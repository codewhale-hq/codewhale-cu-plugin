// Linux/Wayland desktop driver for the parity engine, for sway. --isolated
// starts a headless sway (pixman renderer, XWayland for the Tk fixture) on its
// own runtime directory and session bus; without it the run uses the sway
// session in the environment. Window geometry, titles and focus come from
// swaymsg, never from the backend under test.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sh } from "./sh.mjs";

export function createDesktop({ parityDir, tasksDoc, isolated, helper = false }) {
  const TASKS_DOC = tasksDoc;
  const PARITY = parityDir;
  const ISOLATED = isolated;
  const HELPER = helper;
  let helperProc = null;
  let helperSocket = null;
  let helperStateDir = null;
  // The user's own session, sampled for interference; absent when there is none.
  const HOST = process.env.SWAYSOCK ? { SWAYSOCK: process.env.SWAYSOCK } : null;
  let env = {
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    SWAYSOCK: process.env.SWAYSOCK, XDG_SESSION_TYPE: "wayland", DISPLAY: process.env.DISPLAY,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
  let sway = null;
  let runtimeDir = null;
  let busPid = null;
  let outputGeometry = "";

  const swaymsg = (args, sock = env.SWAYSOCK) => sh("swaymsg", args, { env: { SWAYSOCK: sock } });
  const tree = (sock) => { try { return JSON.parse(swaymsg(["-t", "get_tree", "-r"], sock).stdout); } catch { return null; } };

  function windows(sock) {
    const out = [];
    const walk = (n) => {
      if ((n.type === "con" || n.type === "floating_con") && n.pid) out.push({ id: n.id, pid: n.pid, title: n.name ?? "", app_id: n.app_id ?? n.window_properties?.class ?? null, rect: n.rect, focused: !!n.focused });
      for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
    };
    const t = tree(sock);
    if (t) walk(t);
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function browserBinary() {
    return sh("which", ["google-chrome"]).code === 0 ? "google-chrome" : "chromium";
  }
  function browserAppName() {
    return /chromium/i.test(sh(browserBinary(), ["--version"]).stdout) ? "Chromium" : "Chrome";
  }

  async function startIsolated() {
    // sway's IPC socket path must fit sockaddr_un, so keep the runtime dir short.
    runtimeDir = fs.mkdtempSync("/tmp/cu-wl-");
    fs.chmodSync(runtimeDir, 0o700);
    const config = path.join(runtimeDir, "sway.conf");
    // Tk's fixed-size window floats; place it at 0,0 unbordered, as the X11
    // run does, so the origin Tk reports is where sway put it.
    fs.writeFileSync(config, [
      "output HEADLESS-1 resolution 1600x1200", "default_border none", "default_floating_border none", "xwayland enable",
      'for_window [title="^CU-NATIVE {"] move position 0 0',
      // Beside the main window: XWayland routes clicks on overlapping X
      // windows by its own stacking order, not sway's.
      'for_window [title="^CU-NATIVE-2"] floating enable, move position 820 0', "",
    ].join("\n"));
    const bus = sh("env", ["-u", "DBUS_SESSION_BUS_ADDRESS", "dbus-daemon", "--session", "--fork", "--print-address=1", "--print-pid=1"]);
    if (bus.code !== 0) throw new Error(`dbus-daemon failed: ${bus.stderr}`);
    const [addr, pid] = bus.stdout.trim().split("\n");
    busPid = Number(pid);
    const swayEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? "C.UTF-8",
      XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: addr,
      WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", WLR_RENDERER: "pixman",
    };
    sway = spawn("sway", ["-c", config], { env: swayEnv, stdio: "ignore", detached: true });
    sway.unref();
    let sock = null;
    for (let i = 0; i < 60 && !sock; i++) {
      await sleep(250);
      sock = fs.readdirSync(runtimeDir).find((f) => /^sway-ipc\..*\.sock$/.test(f)) ?? null;
    }
    if (!sock) throw new Error("headless sway did not open its IPC socket");
    const wl = fs.readdirSync(runtimeDir).find((f) => /^wayland-\d+$/.test(f));
    env = { WAYLAND_DISPLAY: wl, XDG_RUNTIME_DIR: runtimeDir, SWAYSOCK: path.join(runtimeDir, sock), XDG_SESSION_TYPE: "wayland", DBUS_SESSION_BUS_ADDRESS: addr };
    // XWayland's display is only known to sway's children; ask one.
    const dispFile = path.join(runtimeDir, "display");
    swaymsg(["exec", `printf %s "$DISPLAY" > ${dispFile}`]);
    for (let i = 0; i < 40 && !fs.existsSync(dispFile); i++) await sleep(100);
    const display = fs.existsSync(dispFile) ? fs.readFileSync(dispFile, "utf8").trim() : "";
    if (display) env.DISPLAY = display;
    // A fresh bus reports accessibility off, and Chromium then never joins AT-SPI.
    sh("gdbus", ["call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus", "--method", "org.freedesktop.DBus.Properties.Set", "org.a11y.Status", "IsEnabled", "<true>"], { env: { DBUS_SESSION_BUS_ADDRESS: addr } });
  }

  async function startHelper() {
    helperStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-parity-helper-"));
    helperSocket = path.join(helperStateDir, "app.sock");
    helperProc = spawn(process.execPath, [path.join(PARITY, "..", "app", "daemon.mjs")], {
      env: { ...process.env, ...baseEnv(), CODEWHALE_CU_STATE_DIR: helperStateDir, CODEWHALE_CU_APP_SOCKET: helperSocket },
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (let i = 0; i < 40 && !fs.existsSync(helperSocket); i++) await sleep(250);
    if (!fs.existsSync(helperSocket)) throw new Error("the desktop helper did not open its socket");
  }

  function baseEnv() {
    const out = {};
    for (const [k, v] of Object.entries(env)) if (v) out[k] = v;
    // The server must choose its Wayland session, not an inherited X11 one.
    if (!out.DISPLAY) out.DISPLAY = "";
    return out;
  }

  /** The host session's focused window title. sway does not report the pointer position. */
  function hostProbe() {
    if (!HOST || (ISOLATED && HOST.SWAYSOCK === env.SWAYSOCK)) return { pointer: { x: 0, y: 0 }, activeWindow: "" };
    const focused = windows(HOST.SWAYSOCK).find((w) => w.focused);
    return { pointer: { x: 0, y: 0 }, activeWindow: focused?.title ?? "" };
  }

  async function findWindow(match, timeoutMs = 15_000, pid = null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ws = windows().filter((w) => (typeof match === "string" ? w.title.includes(match) : match.test(w.title)));
      const mine = pid ? ws.filter((w) => w.pid === pid) : [];
      const hit = mine.at(-1) ?? (pid ? null : ws.at(-1));
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  }

  function windowById(id) {
    return windows().find((w) => w.id === id) ?? null;
  }

  /** Top-left origin and size of a non-fixture window found by title (dialogs, file choosers). */
  function windowGeometry(titleRe) {
    const w = windows().filter((x) => (typeof titleRe === "string" ? x.title.includes(titleRe) : titleRe.test(x.title))).at(-1);
    return w ? { x: w.rect.x, y: w.rect.y, w: w.rect.width, h: w.rect.height } : null;
  }

  // Chromium's AT-SPI extents are window-relative on Wayland, so the document
  // offset is read in window coordinates and added to sway's window rectangle.
  const ATSPI_DOC = `import json, sys, pyatspi
want = sys.argv[1].casefold()
d = pyatspi.Registry.getDesktop(0)
for i in range(d.childCount):
    a = d.getChildAtIndex(i)
    if a and (a.name or "").casefold() == want:
        def walk(e, depth=0):
            if depth > 10: return None
            try:
                if e.getRoleName() == "document web":
                    x = e.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
                    return (x.x, x.y)
            except Exception: return None
            try:
                for k in range(e.childCount):
                    r = walk(e.getChildAtIndex(k), depth + 1)
                    if r: return r
            except Exception: pass
            return None
        for j in range(a.childCount):
            w = a.getChildAtIndex(j)
            if not w: continue
            if "CU-FIXTURE" in (w.name or ""):
                r = walk(w)
                if r:
                    print(json.dumps({"x": r[0], "y": r[1]}))
                    raise SystemExit(0)`;

  function atspiDocOffset() {
    const r = sh("python3", ["-c", ATSPI_DOC, browserAppName()], { env: baseEnv(), timeoutMs: 20_000 });
    try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return null; }
  }

  function clientOrigin(fixtureKey, { window = "main", repCtx } = {}) {
    const fx = TASKS_DOC.fixtures[fixtureKey];
    if (fixtureKey === "native") {
      // The second window has no menubar or border: its content origin is
      // sway's rectangle. The main window is pinned at 0,0, where the origin
      // Tk reports (below its menubar) is exact.
      if (window === "second") {
        const w = windows().filter((x) => x.pid === repCtx.pid && x.title.startsWith(fx.second_window_title)).at(-1);
        if (!w) throw new Error("native fixture's second window not found");
        return { x: w.rect.x, y: w.rect.y, winId: w.id };
      }
      const st = (() => { try { return JSON.parse(fs.readFileSync(repCtx.nativeStateFile, "utf8")); } catch { return null; } })();
      if (!st?.origin) throw new Error("native fixture has not reported its window origin");
      return { x: st.origin[0], y: st.origin[1], winId: repCtx.winId };
    }
    const w = window !== "second" && repCtx?.winId ? windowById(repCtx.winId) : windows().filter((x) => x.title.includes(window === "second" ? fx.second_window_title : fx.title_prefix)).at(-1);
    if (!w) throw new Error(`fixture window for ${fixtureKey} not found`);
    const off = repCtx?.docOffset ?? { x: 0, y: 0 };
    return { x: w.rect.x + off.x, y: w.rect.y + off.y, winId: w.id };
  }

  const fixtureProcs = [];

  function sessionMembers(sid) {
    const out = [];
    for (const e of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
      try {
        const rest = fs.readFileSync(`/proc/${e}/stat`, "utf8").split(")").pop().trim().split(" ");
        if (Number(rest[3]) === sid) out.push(Number(e));
      } catch {}
    }
    return out;
  }

  async function killFixture(proc) {
    if (!proc) return;
    try { process.kill(-proc.pid, "SIGTERM"); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      try { process.kill(proc.pid, 0); } catch { break; }
      await sleep(150);
    }
    try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
    if (proc.cuSessionId) for (const p of sessionMembers(proc.cuSessionId)) { try { process.kill(p, "SIGKILL"); } catch {} }
  }

  async function oracleState(task, repCtx) {
    if (task.fixture === "browser") {
      const prefix = TASKS_DOC.fixtures.browser.title_prefix;
      for (let attempt = 0; attempt < 4; attempt++) {
        const t = repCtx.winId ? windowById(repCtx.winId)?.title ?? "" : "";
        const i = t.indexOf(prefix);
        if (i !== -1) { try { return JSON.parse(t.slice(i + prefix.length)); } catch {} }
        if (attempt < 3) await sleep(150);
      }
      return null;
    }
    if (task.fixture === "native") {
      try { return JSON.parse(fs.readFileSync(repCtx.nativeStateFile, "utf8")); } catch { return null; }
    }
    return null;
  }

  async function launchFixture(kind, repCtx) {
    const fx = TASKS_DOC.fixtures[kind];
    if (kind === "browser") {
      const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cu-parity-chrome-"));
      fs.mkdirSync(path.join(udd, "Default"), { recursive: true });
      fs.writeFileSync(path.join(udd, "Default", "Preferences"), JSON.stringify({ download: { default_directory: repCtx.downloadDir, prompt_for_download: false } }));
      const proc = spawn(browserBinary(), [
        `--user-data-dir=${udd}`, `--app=file://${path.join(PARITY, fx.file)}`,
        `--window-size=${fx.size[0]},${fx.size[1]}`, "--ozone-platform=wayland",
        // As in the X11 driver: a session keyring's password prompt would take all input.
        "--no-first-run", "--disable-features=Translate", "--force-renderer-accessibility", "--password-store=basic",
      ], { env: { ...process.env, ...baseEnv() }, stdio: "ignore", detached: true });
      proc.cuSessionId = proc.pid;
      repCtx.pid = proc.pid;
      fixtureProcs.push(proc);
      try {
        const w = await findWindow(fx.title_prefix, 20_000, proc.pid);
        if (!w) throw new Error("browser fixture window did not appear");
        repCtx.winId = w.id;
        repCtx.appId = w.app_id;
        let ready = false;
        const stateDeadline = Date.now() + 40_000;
        while (Date.now() < stateDeadline && !(ready = await oracleState({ fixture: "browser" }, repCtx))) await sleep(200);
        if (!ready) throw new Error("browser fixture window mapped but never published a CU-FIXTURE state");
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const doc = atspiDocOffset();
          if (doc) { repCtx.docOffset = doc; break; }
          await sleep(500);
        }
        return proc;
      } catch (e) {
        await killFixture(proc);
        throw e;
      }
    }
    if (kind === "native") {
      const stateFile = path.join(repCtx.dir, "native-state.json");
      const proc = spawn("python3", [path.join(PARITY, fx.file), stateFile], { env: { ...process.env, ...baseEnv() }, stdio: "ignore" });
      fixtureProcs.push(proc);
      const w = await findWindow(fx.title_prefix, 15_000, proc.pid);
      if (!w) { try { proc.kill("SIGKILL"); } catch {} throw new Error("native fixture window did not appear"); }
      repCtx.winId = w.id;
      repCtx.appId = w.app_id;
      repCtx.pid = proc.pid;
      repCtx.nativeStateFile = stateFile;
      // Tk's first origin report can precede sway's configure; wait until it settles.
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        const st = await oracleState({ fixture: "native" }, repCtx);
        if (st?.origin) break;
      }
      return proc;
    }
    return null;
  }

  /** sway gives keyboard focus to the window it is told to focus. */
  function focusFixture(repCtx) {
    if (repCtx?.winId) swaymsg([`[con_id=${repCtx.winId}]`, "focus"]);
  }

  return {
    sessionType: () => "wayland",
    async start() {
      if (ISOLATED) await startIsolated();
      else if (!env.SWAYSOCK) throw new Error("the Wayland parity driver needs sway: set SWAYSOCK or pass --isolated");
      const outs = JSON.parse(swaymsg(["-t", "get_outputs", "-r"]).stdout || "[]");
      outputGeometry = outs.map((o) => `${o.name} ${o.rect.width}x${o.rect.height}+${o.rect.x}+${o.rect.y}`).join(", ");
      if (HELPER) await startHelper();
    },
    stop() {
      for (const p of fixtureProcs) {
        try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
        if (p.cuSessionId) for (const m of sessionMembers(p.cuSessionId)) { try { process.kill(m, "SIGKILL"); } catch {} }
      }
      if (helperProc) try { helperProc.kill(); } catch {}
      if (helperStateDir) fs.rmSync(helperStateDir, { recursive: true, force: true });
      if (sway) { try { process.kill(-sway.pid, "SIGTERM"); } catch { try { sway.kill(); } catch {} } }
      if (busPid) try { process.kill(busPid); } catch {}
      if (runtimeDir) setTimeout(() => fs.rmSync(runtimeDir, { recursive: true, force: true }), 500).unref();
    },
    baseEnv,
    browserAppName,
    serverEnv: () => (HELPER ? { CODEWHALE_CU_APP_SOCKET: helperSocket, CODEWHALE_CU_APP: "" } : { CODEWHALE_CU_APP: "off" }),
    inputOwner: HELPER,
    hostProbe,
    launchFixture,
    focusFixture,
    killFixture,
    prelude: (task, repCtx) => {
      if (!task.fixture || !repCtx.pid) return [];
      const steps = [{ call: "consent_allow", args: { pid: repCtx.pid } }];
      if (repCtx.appId) steps.push({ call: "consent_allow", args: { app: repCtx.appId } });
      // Element targets name the app as AT-SPI does.
      if (task.fixture === "browser") steps.push({ call: "consent_allow", args: { app: browserAppName() } });
      for (const app of (process.env.PARITY_EXTRA_CONSENT ?? "").split(",").filter(Boolean)) steps.push({ call: "consent_allow", args: { app } });
      return steps;
    },
    clientOrigin,
    windowGeometry,
    oracleState,
    meta: () => ({
      route: HELPER ? "helper" : "direct",
      compositor: sh("sway", ["--version"]).stdout.trim(),
      outputs: outputGeometry,
      xwayland: !!env.DISPLAY,
      chrome: sh(browserBinary(), ["--version"]).stdout.trim(),
      browser_app_name: browserAppName(),
      python3: sh("python3", ["--version"]).stdout.trim(),
      tk: sh("python3", ["-c", "import tkinter;print(tkinter.TkVersion)"]).stdout.trim(),
      pointer_interference: "not measured: sway does not report the pointer position",
    }),
  };
}
