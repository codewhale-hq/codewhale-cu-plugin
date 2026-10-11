// Linux Wayland session: screenshots (grim), clipboard (wl-clipboard), windows
// and outputs from the compositor (swaymsg/hyprctl), and input through
// wayland-input.py, a virtual keyboard and pointer client. linux.mjs selects
// the session and delegates every Wayland branch here.
//
// Input is sent only where the compositor names the app that receives it:
// sway and Hyprland report the focused window's pid (keyboard) and the
// windows' rectangles and stacking (pointer). Other compositors, GNOME and KDE
// among them, are refused with input_owner_unknown.
//
// What this does not guarantee:
// - Layer-shell surfaces (launchers, panels, lock screens) and popup menus
//   are not in the compositor's window list. A launcher holding exclusive
//   keyboard focus receives keys attributed to the focused window, and a
//   popup that extends past its window over another app receives clicks
//   attributed to that app. X11 has the same gap for override-redirect windows.
// - Overlapping floating windows of different apps are refused rather than
//   ordered, because neither compositor reports floating stacking order.
//   Overlapping XWayland windows of different apps are refused too: XWayland
//   delivers to the window on top of its own X stack, which can differ from
//   the compositor's.
import path from "node:path";
import url from "node:url";
import { ExecError, tryJson, throwIfAborted, currentSignal, withSignal } from "../exec.mjs";

const HELPER = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "wayland-input.py");
const ownerUnknown = (message) => Object.assign(new ExecError(message), { code: "input_owner_unknown" });
const MODIFIERS = { ctrl: "Control_L", control: "Control_L", alt: "Alt_L", shift: "Shift_L", logo: "Super_L", super: "Super_L", meta: "Super_L", cmd: "Super_L", win: "Super_L", altgr: "ISO_Level3_Shift", capslock: "Caps_Lock" };
// Linux input-event-codes.h
const BUTTONS = { 1: 0x110, 2: 0x112, 3: 0x111 };

function procComm(fs, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null; } catch { return null; }
}

/** Keysym names for "ctrl+shift+Left": modifiers in press order, then the key. */
export function keysyms(text, keyName) {
  const parts = String(text).split("+").map((p) => p.trim());
  if (parts.some((p) => !p)) throw Object.assign(new ExecError(`unknown key combination "${text}"`), { code: "bad_args" });
  const last = parts.pop();
  const mods = parts.map((p) => {
    const sym = MODIFIERS[p.toLowerCase()];
    if (!sym) throw Object.assign(new ExecError(`unknown modifier "${p}" in "${text}"`), { code: "bad_args" });
    return sym;
  });
  return [...mods, MODIFIERS[last.toLowerCase()] ?? keyName(last)];
}

/** sway get_tree: every window with its owner, rectangle, workspace and stacking facts. */
export function swayWindows(tree) {
  const out = [];
  const walk = (n, ctx) => {
    if (n.type === "output") ctx = { ...ctx, output: n.name, outputRect: n.rect, current: n.current_workspace };
    if (n.type === "workspace") ctx = { ...ctx, workspace: n.name, wsVisible: n.name === ctx.current && n.name !== "__i3_scratch" };
    if ((n.type === "con" || n.type === "floating_con") && Number.isInteger(n.pid) && n.pid > 0) {
      const cls = n.app_id ?? n.window_properties?.class ?? null;
      out.push({
        id: String(n.id), pid: n.pid, name: cls, wm_class: cls, title: n.name ?? "",
        rect: { x: n.rect.x, y: n.rect.y, w: n.rect.width, h: n.rect.height },
        focused: !!n.focused, visible: n.visible === true && ctx.wsVisible === true,
        floating: n.type === "floating_con", fullscreen: (n.fullscreen_mode ?? 0) > 0,
        workspace: ctx.workspace ?? null, shell: n.shell ?? null,
      });
    }
    for (const c of n.nodes ?? []) walk(c, ctx);
    for (const c of n.floating_nodes ?? []) walk(c, ctx);
  };
  walk(tree ?? {}, {});
  return out;
}

/** hyprctl clients: the same shape. Hyprland reports no stacking order. */
export function hyprWindows(clients, activeWorkspaces) {
  return (Array.isArray(clients) ? clients : []).filter((c) => Number.isInteger(c.pid) && c.pid > 0 && c.mapped !== false).map((c) => ({
    id: String(c.address), pid: c.pid, name: c.class || c.initialClass || null, wm_class: c.class || null, title: c.title ?? "",
    rect: { x: c.at?.[0], y: c.at?.[1], w: c.size?.[0], h: c.size?.[1] },
    focused: c.focusHistoryID === 0, visible: !c.hidden && activeWorkspaces.has(c.workspace?.id),
    floating: !!c.floating, fullscreen: !!c.fullscreen && c.fullscreen !== 0,
    workspace: c.workspace?.name ?? null, shell: c.xwayland ? "xwayland" : "xdg_shell",
  }));
}

const inside = (r, x, y) => Number.isFinite(r?.x) && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/**
 * The window that receives pointer input at (x, y): a fullscreen window, else
 * the floating windows, else the tiled one. Null when no window is there.
 * Floating windows of different apps overlapping the point are refused.
 */
export function windowAt(windows, x, y) {
  const shown = windows.filter((w) => w.visible && inside(w.rect, x, y));
  // XWayland routes input among its own windows by X stacking order, which
  // can disagree with the compositor's, so overlapping X windows of
  // different apps cannot be ordered.
  const x11 = shown.filter((w) => w.shell === "xwayland");
  if (new Set(x11.map((w) => w.pid)).size > 1) throw ownerUnknown(`XWayland windows of ${[...new Set(x11.map((w) => w.name ?? `pid ${w.pid}`))].join(" and ")} overlap at (${x}, ${y}); XWayland picks between them by its own stacking order, so this pointer target cannot be attributed`);
  for (const layer of [shown.filter((w) => w.fullscreen), shown.filter((w) => w.floating), shown]) {
    if (!layer.length) continue;
    const pids = new Set(layer.map((w) => w.pid));
    if (pids.size > 1) throw ownerUnknown(`windows of ${[...new Set(layer.map((w) => w.name ?? `pid ${w.pid}`))].join(" and ")} overlap at (${x}, ${y}) and the compositor does not report which is on top, so this pointer target cannot be attributed`);
    return layer.find((w) => w.focused) ?? layer[0];
  }
  return null;
}

/** One long-lived wayland-input.py: its virtual devices persist across calls and are released when it exits. */
function createInputClient({ run, need }) {
  let state = null; // { child, pending: [], buffer, ready: Promise, info }
  function start() {
    need("python3", "Wayland input (wayland-input.py)");
    const s = { child: null, pending: [], buffer: "", info: null, closed: false };
    const first = new Promise((resolve, reject) => s.pending.push({ resolve, reject }));
    const completion = run("python3", [HELPER], {
      ownerPipe: true, timeoutMs: 0, signal: null,
      onSpawn: (child) => { s.child = child; },
      onStdout: (chunk) => {
        s.buffer += chunk;
        let nl;
        while ((nl = s.buffer.indexOf("\n")) !== -1) {
          const line = s.buffer.slice(0, nl);
          s.buffer = s.buffer.slice(nl + 1);
          const waiter = s.pending.shift();
          const reply = tryJson(line, null);
          if (waiter) reply ? waiter.resolve(reply) : waiter.reject(new ExecError(`Wayland input helper returned ${line.slice(0, 120)}`));
        }
      },
    });
    completion.then((r) => {
      s.closed = true;
      if (state === s) state = null;
      const err = Object.assign(new ExecError(`Wayland input helper exited ${r.code}: ${(r.stderr || "").trim().slice(0, 200)}`, r), { code: "input_owner_closed" });
      for (const w of s.pending.splice(0)) w.reject(err);
    });
    s.ready = first.then((info) => {
      if (!info.ok) throw Object.assign(new ExecError(`Wayland input is unavailable: ${info.message}`), { code: info.code === "no_session" ? "no_session" : "input_owner_unknown" });
      s.info = info;
      return info;
    });
    s.ready.catch(() => {});
    state = s;
    return s;
  }
  let queue = Promise.resolve();
  async function request(steps, timeoutMs = 10_000) {
    const signal = currentSignal();
    throwIfAborted(signal);
    const turn = queue.then(async () => {
      const s = state ?? start();
      await s.ready;
      if (s.closed) throw Object.assign(new ExecError("Wayland input helper is closed"), { code: "input_owner_closed" });
      const reply = new Promise((resolve, reject) => s.pending.push({ resolve, reject }));
      s.child.stdin.write(JSON.stringify({ steps }) + "\n");
      let timer;
      try {
        return await Promise.race([reply, new Promise((_, reject) => { timer = setTimeout(() => {
          try { s.child.kill("SIGKILL"); } catch {}
          reject(new ExecError("Wayland input helper did not acknowledge input"));
        }, timeoutMs); })]);
      } finally { clearTimeout(timer); }
    });
    queue = turn.catch(() => {});
    const out = await turn;
    if (!out.ok) throw Object.assign(new ExecError(`Wayland input failed: ${out.message}`), { code: out.code === "unknown_key" || out.code === "bad_args" ? "bad_args" : out.code });
    return out;
  }
  return {
    request,
    async info() { const s = state ?? start(); return s.ready; },
    close() { if (state?.child) try { state.child.stdin.end(); } catch {} },
  };
}

export function createWayland({ run, need, tools, keyName, fs, inputClient }) {
  const input = inputClient ?? createInputClient({ run, need });

  /** "sway" or "hyprland" when that compositor answers on this session, else null. */
  let compositorCache;
  async function compositor() {
    if (compositorCache !== undefined) return compositorCache;
    compositorCache = null;
    if (tools.swaymsg && (await run("swaymsg", ["-t", "get_version"], { timeoutMs: 5_000 })).code === 0) compositorCache = "sway";
    else if (tools.hyprctl && (await run("hyprctl", ["-j", "version"], { timeoutMs: 5_000 })).code === 0) compositorCache = "hyprland";
    return compositorCache;
  }

  async function json(cmd, args) {
    const r = await run(cmd, args, { timeoutMs: 10_000 });
    throwIfAborted();
    if (r.code !== 0) throw ownerUnknown(`${cmd} ${args.join(" ")} exited ${r.code}, so the window receiving input cannot be named: ${r.stderr.trim().slice(0, 160)}`);
    const out = tryJson(r.stdout, null);
    if (out === null) throw ownerUnknown(`${cmd} ${args.join(" ")} returned unreadable output, so the window receiving input cannot be named`);
    return out;
  }

  /** Every window the compositor manages, with owner pid. Null without a supported compositor. */
  async function compositorWindows() {
    const c = await compositor();
    if (c === "sway") return swayWindows(await json("swaymsg", ["-t", "get_tree", "-r"]));
    if (c === "hyprland") {
      const monitors = await json("hyprctl", ["-j", "monitors"]);
      const active = new Set((Array.isArray(monitors) ? monitors : []).flatMap((m) => [m.activeWorkspace?.id, m.specialWorkspace?.id]).filter((id) => id != null && id !== 0));
      return hyprWindows(await json("hyprctl", ["-j", "clients"]), active);
    }
    return null;
  }

  function unsupported() {
    const desktop = process.env.XDG_CURRENT_DESKTOP || "this compositor";
    return ownerUnknown(`${desktop} on Wayland does not tell Codewhale which app would receive input, so keyboard and pointer input are refused; sway and Hyprland are supported`);
  }

  const identityOf = (w) => ({ name: w.name, comm: procComm(fs, w.pid), pid: w.pid, wm_class: w.wm_class, title: w.title, window: w.id });

  async function displays() {
    if (tools.swaymsg) {
      const r = await run("swaymsg", ["-t", "get_outputs", "-r"], { timeoutMs: 15_000 });
      const outs = tryJson(r.stdout, []);
      if (Array.isArray(outs) && outs.length) {
        return outs.filter((o) => o.active !== false).map((o, i) => ({ index: i + 1, name: o.name, points: { x: o.rect?.x, y: o.rect?.y, w: o.rect?.width, h: o.rect?.height }, pixels: { w: o.current_mode?.width, h: o.current_mode?.height }, scale: o.scale ?? 1, main: i === 0 }));
      }
    }
    if (tools.hyprctl) {
      const r = await run("hyprctl", ["-j", "monitors"], { timeoutMs: 15_000 });
      const ms = tryJson(r.stdout, []);
      if (Array.isArray(ms) && ms.length) {
        return ms.map((o, i) => {
          const scale = o.scale || 1;
          return { index: i + 1, name: o.name, points: { x: o.x, y: o.y, w: Math.round(o.width / scale), h: Math.round(o.height / scale) }, pixels: { w: o.width, h: o.height }, scale, main: !!o.focused || i === 0 };
        });
      }
    }
    return null;
  }

  /** The output layout's bounding box; absolute pointer motion is relative to it. */
  async function layoutBox() {
    const ds = await displays();
    if (!ds?.length) throw new ExecError("the compositor reported no outputs, so pointer coordinates cannot be mapped");
    const x0 = Math.min(...ds.map((d) => d.points.x)), y0 = Math.min(...ds.map((d) => d.points.y));
    const x1 = Math.max(...ds.map((d) => d.points.x + d.points.w)), y1 = Math.max(...ds.map((d) => d.points.y + d.points.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  async function moveStep(x, y) {
    const box = await layoutBox();
    if (!inside(box, x, y)) throw Object.assign(new ExecError(`(${x}, ${y}) is outside every output`), { code: "bad_args" });
    return ["move", x - box.x, y - box.y, box.w, box.h];
  }

  return {
    shotTool() {
      need("grim", "screenshots on Wayland");
      return { cmd: "grim", base: [] };
    },
    shotArgs(region, file) {
      const args = [];
      if (region) args.push("-g", `${Math.round(region[0])},${Math.round(region[1])} ${Math.round(region[2])}x${Math.round(region[3])}`);
      args.push(file);
      return args;
    },
    compositor,
    async keyboardOwner() {
      const c = await compositor();
      if (c === "hyprland") {
        const a = await json("hyprctl", ["-j", "activewindow"]);
        if (!Number.isInteger(a?.pid) || a.pid <= 0) throw ownerUnknown("no application window has keyboard focus; click the target app's window first, then retry");
        return identityOf(hyprWindows([a], new Set([a.workspace?.id]))[0]);
      }
      const windows = await compositorWindows();
      if (!windows) throw unsupported();
      const focused = windows.filter((w) => w.focused);
      if (focused.length !== 1) throw ownerUnknown("no application window has keyboard focus; click the target app's window first, then retry");
      return identityOf(focused[0]);
    },
    async pointOwner(x, y) {
      const windows = await compositorWindows();
      if (!windows) throw unsupported();
      const win = windowAt(windows, x, y);
      return win ? identityOf(win) : null;
    },
    async cursorPoint() {
      if ((await compositor()) === "hyprland") {
        const p = await json("hyprctl", ["-j", "cursorpos"]);
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return { x: p.x, y: p.y };
      }
      throw ownerUnknown("this compositor does not report the pointer position, so input at the current pointer cannot be attributed; give the input explicit coordinates");
    },
    /** Refuse before any input when the compositor cannot name the receiver or offers no virtual devices. */
    async inputStatus() {
      if (!(await compositor())) return { ok: false, reason: unsupported().message };
      try {
        const info = await input.info();
        if (!info.virtual_keyboard || !info.virtual_pointer) return { ok: false, reason: "the compositor does not offer the virtual keyboard and pointer protocols" };
        return { ok: true };
      } catch (err) { return { ok: false, reason: err.message }; }
    },
    async key(text, { repeat = 1, holdMs = 0, hold } = {}) {
      const syms = keysyms(text, keyName);
      const down = syms.map((s) => ["key", s, 1]);
      const up = [...syms].reverse().map((s) => ["key", s, 0]);
      if (holdMs) {
        await input.request(down);
        try { await hold(holdMs); } finally { await withSignal(null, () => input.request(up)); }
        return;
      }
      const steps = [];
      for (let i = 0; i < repeat; i++) steps.push(...down, ...up);
      await input.request(steps);
    },
    async type(text) {
      await input.request([["text", String(text)]], 10_000 + [...String(text)].length * 40);
    },
    async move(x, y) {
      // XWayland lost a click that followed the pointer's entry into an X
      // window with no motion inside it; a one-pixel nudge and return gives it one.
      const to = await moveStep(x, y);
      const nudge = [...to];
      nudge[1] += to[1] + 1 < to[3] ? 1 : -1;
      await input.request([to, ["sleep", 30], nudge, to]);
    },
    async click(button, clicks) {
      const code = BUTTONS[button] ?? BUTTONS[1];
      const steps = [];
      for (let i = 0; i < clicks; i++) {
        if (i) steps.push(["sleep", 80]);
        steps.push(["button", code, 1], ["button", code, 0]);
      }
      await input.request(steps);
    },
    mouseDown() {
      return input.request([["button", BUTTONS[1], 1]]);
    },
    mouseUp() {
      return input.request([["button", BUTTONS[1], 0]]);
    },
    async scroll({ direction, amount }) {
      const n = Math.max(1, Math.min(30, Number(amount) || 3));
      const [axis, sign] = { down: [0, 1], up: [0, -1], right: [1, 1], left: [1, -1] }[direction] ?? [0, 1];
      const steps = [];
      // One notch per frame, paced like a wheel: Chromium registered 2 of 30
      // notches sent in one burst.
      for (let i = 0; i < n; i++) steps.push(...(i ? [["sleep", 16]] : []), ["axis", axis, 15 * sign, sign]);
      await input.request(steps);
    },
    displays,
    /** Windows for list_windows, top-most first where the compositor knows. */
    async windows() {
      const ws = await compositorWindows();
      if (!ws) return null;
      return ws.map((w) => ({ id: w.id, title: w.title, wm_class: w.wm_class, pid: w.pid, process: procComm(fs, w.pid),
        position: { x: w.rect.x, y: w.rect.y }, size: { w: w.rect.w, h: w.rect.h }, focused: w.focused, viewable: w.visible }))
        .sort((a, b) => Number(b.focused) - Number(a.focused));
    },
    /** Geometry of an app's visible window and the other apps' floating windows overlapping it. */
    async appFrame(name, sameName) {
      const ws = await compositorWindows();
      if (!ws) throw Object.assign(new ExecError("this compositor does not report window geometry; capture the whole display"), { code: "no_window_manager" });
      const owned = ws.filter((w) => sameName(w.name, name) || sameName(procComm(fs, w.pid), name));
      if (!owned.length) throw Object.assign(new ExecError(`no window belongs to "${name}" — call list_apps and check the name`), { code: "app_not_found" });
      const win = owned.find((w) => w.visible && w.focused) ?? owned.find((w) => w.visible);
      if (!win) throw Object.assign(new ExecError(`"${name}" has no visible window to capture`), { code: "no_window" });
      const r = win.rect;
      const occludedBy = ws.filter((w) => w !== win && w.visible && w.pid !== win.pid && (w.floating || w.fullscreen)
        && w.rect.x < r.x + r.w && r.x < w.rect.x + w.rect.w && w.rect.y < r.y + r.h && r.y < w.rect.y + w.rect.h)
        .map((w) => ({ name: w.name, title: w.title }));
      return { win: { id: win.id, title: win.title, wm_class: win.wm_class, pid: win.pid }, rect: [r.x, r.y, r.w, r.h], occludedBy };
    },
    async focusedWindow() {
      const ws = await compositorWindows().catch(() => null);
      return ws?.find((w) => w.focused)?.id ?? null;
    },
    async focusWindow(id) {
      const c = await compositor();
      if (c === "sway" && /^\d+$/.test(id)) return (await run("swaymsg", [`[con_id=${id}]`, "focus"], { timeoutMs: 3_000 })).code === 0;
      if (c === "hyprland" && /^0x[0-9a-f]+$/i.test(id)) return (await run("hyprctl", ["dispatch", "focuswindow", `address:${id}`], { timeoutMs: 3_000 })).code === 0;
      return false;
    },
    clipboardRead: () => ["wl-paste", "--no-newline"],
    clipboardWrite: () => ["wl-copy"],
    close: () => input.close(),
  };
}
