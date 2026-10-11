// Linux desktop behavior that does not need a display: window ownership and
// geometry, keyboard guards, AT-SPI element actions, screenshots of app
// windows, recording arguments, kill_app and session listing. Commands are
// injected through `exec`, so each test states exactly what the window manager
// reports and asserts what the backend sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { create, x11GrabArgs } from "../src/backends/linux.mjs";
import { browserStartFailure } from "../src/browser-cdp.mjs";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// Two managed windows, bottom to top: Mousepad, then xterm stacked above it.
// xwininfo reports client rectangles; _NET_FRAME_EXTENTS grows them to frames.
const WINDOWS = {
  "0x800003": { pid: 10165, wm_class: "mousepad.Mousepad", title: "Untitled 1 - Mousepad", client: [1, 315, 640, 480], ext: [1, 1, 20, 5] },
  "0xe0000c": { pid: 10400, wm_class: "xterm.XTerm", title: "root@vm: /home/user", client: [401, 290, 362, 135], ext: [1, 1, 20, 5] },
};

/** X window ids compare by number: the backend pads them to eight hex digits, the fixture does not. */
function windowFor(id) {
  const key = Object.keys(WINDOWS).find((k) => parseInt(k, 16) === parseInt(id, 16));
  return key ? WINDOWS[key] : undefined;
}

/** A fake desktop: answers the commands the Linux backend asks the window manager. */
function fakeDesktop({ active = "0x800003", stack = ["0x800003", "0xe0000c"], onCommand = () => null } = {}) {
  const calls = [];
  const run = async (cmd, args = []) => {
    calls.push({ cmd, args });
    const custom = onCommand(cmd, args);
    if (custom) return custom;
    const ok = (stdout) => ({ code: 0, stdout, stderr: "", timedOut: false, signal: null });
    const fail = { code: 1, stdout: "", stderr: "", timedOut: false, signal: null };
    if (cmd === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST_STACKING") {
      return stack.length ? ok(`_NET_CLIENT_LIST_STACKING(WINDOW): window id # ${stack.join(", ")}\n`) : ok("_NET_CLIENT_LIST_STACKING:  not found.\n");
    }
    if (cmd === "wmctrl" && args[0] === "-lpx") {
      return ok(Object.entries(WINDOWS).map(([id, w]) => `${id}  0 ${w.pid} ${w.wm_class.padEnd(20)} vm ${w.title}`).join("\n") + "\n");
    }
    if (cmd === "xwininfo" && args[0] === "-id") {
      const w = windowFor(args[1]);
      if (!w) return fail;
      return ok(`  Absolute upper-left X:  ${w.client[0]}\n  Absolute upper-left Y:  ${w.client[1]}\n  Width: ${w.client[2]}\n  Height: ${w.client[3]}\n  Map State: IsViewable\n`);
    }
    if (cmd === "xprop" && args[0] === "-id") {
      const w = windowFor(args[1]);
      if (!w) return fail;
      return ok(`_NET_FRAME_EXTENTS(CARDINAL) = ${w.ext.join(", ")}\n`);
    }
    if (cmd === "xdotool" && args[0] === "getactivewindow") return ok(`${parseInt(active, 16)}\n`);
    if (cmd === "xdotool" && args[0] === "getdisplaygeometry") return ok("1280 800\n");
    if (cmd === "xdotool" && args[0] === "getmouselocation") return ok("x:700 y:350 screen:0 window:12345\n");
    return ok("");
  };
  return { run, calls };
}

/** Environment that makes the backend believe it is on an X11 session, restored afterwards. */
function x11Env(t) {
  const saved = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"].map((k) => [k, process.env[k]]));
  delete process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = "x11";
  process.env.DISPLAY = ":test";
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const have = async () => true;

test("keyboard owner is the app with keyboard focus, not the last observed app", async (t) => {
  x11Env(t);
  const desk = fakeDesktop({ active: "0xe0000c" });
  const backend = create({ exec: { run: desk.run, have } });
  const owner = await backend.input_owner({ kind: "keyboard" });
  assert.equal(owner.name, "xterm");
  assert.equal(owner.pid, 10400);
  assert.equal(owner.window, "0x00e0000c");
});

test("pointer owner is the topmost window under the point; the desktop has no owner", async (t) => {
  x11Env(t);
  const desk = fakeDesktop();
  const backend = create({ exec: { run: desk.run, have } });
  // (700, 350) lies inside xterm's frame (x 400..764, y 270..430) and outside Mousepad's frame (x 0..642).
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 700, y: 350 } })).name, "xterm");
  // (100, 600) lies only inside Mousepad's frame.
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 100, y: 600 } })).name, "mousepad");
  // (10, 10) is on the desktop.
  assert.equal(await backend.input_owner({ kind: "pointer", point: { x: 10, y: 10 } }), null);
});

test("pointer owner without a point reads the cursor position", async (t) => {
  x11Env(t);
  const backend = create({ exec: { run: fakeDesktop().run, have } });
  assert.equal((await backend.input_owner({ kind: "pointer" })).name, "xterm"); // cursor at (700, 350)
});

test("without a window manager the owner is unknown and input fails closed", async (t) => {
  x11Env(t);
  const backend = create({ exec: { run: fakeDesktop({ stack: [] }).run, have } });
  await assert.rejects(backend.input_owner({ kind: "keyboard" }), (err) => err.code === "input_owner_unknown");
  await assert.rejects(backend.input_owner({ kind: "pointer", point: { x: 1, y: 1 } }), (err) => err.code === "input_owner_unknown");
});

test("keyboard input is refused while an open menu item is showing", async (t) => {
  x11Env(t);
  const desk = fakeDesktop({
    onCommand: (cmd, args) => (cmd === "python3" && args[1].includes("STATE_SHOWING") && args[1].includes("popup"))
      ? { code: 0, stdout: '{"found": true, "popup": {"role": "menu item", "label": "Save As..."}, "visited": 9}\n', stderr: "", timedOut: false, signal: null }
      : null,
  });
  const backend = create({ exec: { run: desk.run, have } });
  await assert.rejects(backend.type({ text: "x" }), (err) => err.code === "popup_open");
  await assert.rejects(backend.key({ text: "Return" }), (err) => err.code === "popup_open");
  // Escape is how the agent closes the menu, so it is never refused for that reason.
  await backend.key({ text: "Escape" });
  assert.ok(desk.calls.some((c) => c.cmd === "xdotool" && c.args.includes("Escape")));
});

test("targeted keystrokes refuse when the element's window is not the active one", async (t) => {
  x11Env(t);
  const backend = create({ exec: { run: fakeDesktop({ active: "0x800003" }).run, have } });
  const target = { app_ref: { name: "xterm" }, windowIndex: 0, path: [0], strategy: "a11y" };
  await assert.rejects(backend.type({ text: "x", target }), (err) => err.code === "window_not_active");
  await assert.rejects(backend.key({ text: "Return", target }), (err) => err.code === "window_not_active");
});

test("focus reports whether the focused element's window is active; it never activates a window", async (t) => {
  x11Env(t);
  const desk = fakeDesktop({
    active: "0x800003",
    onCommand: (cmd, args) => (cmd === "python3" && args[1].includes("target_path") && args[1].includes("grabFocus"))
      ? { code: 0, stdout: '{"ok": true}\n', stderr: "", timedOut: false, signal: null }
      : null,
  });
  const backend = create({ exec: { run: desk.run, have } });
  const out = await backend.focus({ target: { app_ref: { name: "xterm" }, windowIndex: 0, path: [0] } });
  assert.equal(out.focused, true);
  assert.equal(out.window_active, false);
  assert.ok(!desk.calls.some((c) => c.cmd === "wmctrl" && c.args.includes("-a")), "focus must not raise windows");
  assert.ok(!desk.calls.some((c) => c.cmd === "xdotool" && c.args[0] === "windowactivate"), "focus must not raise windows");
});

test("get_value and select_text pass their arguments to AT-SPI and return what it reports", async (t) => {
  x11Env(t);
  const seen = [];
  const desk = fakeDesktop({
    onCommand: (cmd, args) => {
      if (cmd !== "python3" || !args[1].includes("target_path")) return null;
      seen.push(args);
      // The select script also calls getText, so match on the call only it makes.
      if (args[1].includes("setSelection") || args[1].includes("setCaretOffset")) return { code: 0, stdout: '{"ok": true, "selected": {"start": 1, "end": 3}, "text": "el"}\n', stderr: "", timedOut: false, signal: null };
      return { code: 0, stdout: '{"ok": true, "kind": "text", "value": "hello", "characters": 5, "truncated": false}\n', stderr: "", timedOut: false, signal: null };
    },
  });
  const backend = create({ exec: { run: desk.run, have } });
  const target = { app_ref: { name: "mousepad" }, windowIndex: 0, path: [318] };
  const value = await backend.get_value({ target });
  assert.deepEqual([value.kind, value.value, value.characters], ["text", "hello", 5]);
  const selected = await backend.select_text({ target, text_range: [1, 2] });
  assert.deepEqual(selected.selected, { start: 1, end: 3 });
  // The range reaches the generated Python as JSON, never spliced into the script.
  assert.equal(seen.at(-1)[4], "[1,2]");
  await assert.rejects(backend.select_text({ target, text_range: [-1, 2] }), (err) => err.code === "bad_args");
});

test("get_value reports a missing value interface as no_value", async (t) => {
  x11Env(t);
  const desk = fakeDesktop({
    onCommand: (cmd, args) => (cmd === "python3" && args[1].includes("target_path"))
      ? { code: 0, stdout: '{"ok": false, "code": "no_value_interface"}\n', stderr: "", timedOut: false, signal: null }
      : null,
  });
  const backend = create({ exec: { run: desk.run, have } });
  await assert.rejects(backend.get_value({ target: { app_ref: { name: "mousepad" }, windowIndex: 0, path: [1] } }), (err) => err.code === "no_value");
});

test("list_apps returns one entry per process, with the pid", async (t) => {
  x11Env(t);
  const backend = create({ exec: { run: async (cmd, args) => (cmd === "wmctrl" && args[0] === "-lpx")
    ? { code: 0, stdout: "0x00800001  0 500 mousepad.Mousepad vm A\n0x00800002  0 500 mousepad.Mousepad vm B\n0x00800003  0 600 xterm.XTerm vm C\n", stderr: "", timedOut: false, signal: null }
    : { code: 0, stdout: "", stderr: "", timedOut: false, signal: null }, have } });
  const { apps } = await backend.list_apps();
  assert.deepEqual(apps.map((a) => [a.name, a.pid, a.windows]), [["mousepad", 500, 2], ["xterm", 600, 1]]);
});

test("screenshot with app_ref crops to the app's frame and names the window stacked above it", async (t) => {
  x11Env(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-linux-app-shot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.CODEWHALE_CU_RECORDINGS_DIR = dir;
  t.after(() => { delete process.env.CODEWHALE_CU_RECORDINGS_DIR; });
  const desk = fakeDesktop({
    onCommand: (cmd, args) => {
      if (cmd === "scrot") { fs.writeFileSync(args.at(-1), PNG_1X1); return { code: 0, stdout: "", stderr: "", timedOut: false, signal: null }; }
      return null;
    },
  });
  const backend = create({ exec: { run: desk.run, have } });
  const shot = await backend.screenshot({ app_ref: { name: "mousepad" } });
  // Client 640x480 at (1,315); extents left 1, right 1, top 20, bottom 5 give the frame.
  assert.deepEqual(shot.points, { x: 0, y: 295, w: 642, h: 505 });
  assert.equal(shot.window.wm_class, "mousepad.Mousepad");
  assert.equal(shot.occluded_by[0].name, "xterm");
  const scrot = desk.calls.find((c) => c.cmd === "scrot");
  assert.ok(scrot.args.includes("-a") && scrot.args.includes("0,295,642,505"));
});

test("screenshot refuses window_id and malformed app_ref before probing the desktop", async (t) => {
  x11Env(t);
  const desk = fakeDesktop();
  const backend = create({ exec: { run: desk.run, have } });
  await assert.rejects(backend.screenshot({ window_id: 1 }), (err) => err.code === "unsupported_selector");
  await assert.rejects(backend.screenshot({ app_ref: { name: "mousepad", pid: 1 } }), (err) => err.code === "unsupported_selector");
  await assert.rejects(backend.screenshot({ app_ref: null }), (err) => err.code === "unsupported_selector");
  assert.equal(desk.calls.length, 0, "refusals must precede every desktop probe");
});

test("x11grab arguments trim to even sizes and carry the region offset", () => {
  const args = x11GrabArgs({ display: ":99", rect: [10, 20, 641, 479], fps: 15, file: "/tmp/out.mp4", durationSec: 3 });
  assert.deepEqual(args.slice(args.indexOf("-video_size"), args.indexOf("-video_size") + 2), ["-video_size", "640x478"]);
  assert.equal(args[args.indexOf("-i") + 1], ":99+10,20");
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "3"]);
  assert.equal(args.at(-1), "/tmp/out.mp4");
  assert.throws(() => x11GrabArgs({ display: ":99", rect: [0, 0, 1, 1], fps: 15, file: "/tmp/x.mp4" }), (err) => err.code === "bad_args");
});

test("recording without an X11 session never starts ffmpeg", async (t) => {
  const saved = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });
  const desk = fakeDesktop();
  const backend = create({ exec: { run: desk.run, have } });
  await assert.rejects(backend.recordingStart({}), (err) => err.code === "no_session");
  assert.equal(desk.calls.length, 0);
});

test("list_sessions names the app with keyboard focus and reports no held input", async (t) => {
  x11Env(t);
  const backend = create({ exec: { run: fakeDesktop().run, have } });
  const { sessions, count, via } = await backend.list_sessions();
  assert.equal(via, "direct");
  assert.equal(count, 1);
  assert.equal(sessions[0].target.name, "mousepad");
  assert.equal(sessions[0].inputHeld, false);
});

test("open_application with a missing executable fails with app_not_found and the server keeps running", async (t) => {
  x11Env(t);
  const backend = create({ exec: { run: fakeDesktop().run, have } });
  await assert.rejects(backend.open_application({ name: "codewhale-no-such-app" }), (err) => err.code === "app_not_found" && /not found on PATH/.test(err.message));
});

test("a Wayland session that also exports DISPLAY is treated as Wayland, so input is refused rather than sent through XWayland", async (t) => {
  const saved = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"].map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" });
  const desk = fakeDesktop({ onCommand: (cmd) => (cmd === "swaymsg" || cmd === "hyprctl" ? { code: 1, stdout: "", stderr: "", timedOut: false, signal: null } : null) });
  const backend = create({ exec: { run: desk.run, have } });
  await assert.rejects(backend.input_owner({ kind: "keyboard" }), (err) => err.code === "input_owner_unknown" && /Wayland/.test(err.message));
  assert.ok(!desk.calls.some((c) => c.cmd === "xdotool"), "no X11 tool is consulted");
});

test("list_apps on sway lists one entry per app id", async (t) => {
  const saved = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"].map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.DISPLAY;
  Object.assign(process.env, { WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" });
  const tree = { type: "root", nodes: [{ type: "con", name: "Untitled - Mousepad", app_id: "mousepad", pid: 11, rect: { x: 0, y: 0, width: 10, height: 10 } }, { type: "con", name: "Terminal", app_id: "foot", pid: 12, rect: { x: 0, y: 0, width: 10, height: 10 } }] };
  const desk = fakeDesktop({ onCommand: (cmd) => (cmd === "swaymsg" ? { code: 0, stdout: JSON.stringify(tree), stderr: "", timedOut: false, signal: null } : null) });
  const backend = create({ exec: { run: desk.run, have } });
  assert.deepEqual((await backend.list_apps()).apps.map((a) => a.name), ["mousepad", "foot"]);
});

test("list_displays marks the only output main when xrandr names no primary", async (t) => {
  x11Env(t);
  const desk = fakeDesktop({ onCommand: (cmd) => (cmd === "xrandr" ? { code: 0, stdout: "screen connected 1440x900+0+0 0mm x 0mm\n", stderr: "", timedOut: false, signal: null } : null) });
  const backend = create({ exec: { run: desk.run, have } });
  const displays = await backend.list_displays();
  assert.equal(displays.length, 1);
  assert.equal(displays[0].main, true);
});

test("switch_display and screenshot accept only displays that exist, and screenshot crops to the chosen one", async (t) => {
  x11Env(t);
  const xrandr = "left connected primary 800x600+0+0 0mm x 0mm\nright connected 640x480+800+0 0mm x 0mm\n";
  const desk = fakeDesktop({ onCommand: (cmd) => (cmd === "xrandr" ? { code: 0, stdout: xrandr, stderr: "", timedOut: false, signal: null } : null) });
  const backend = create({ exec: { run: desk.run, have } });
  await assert.rejects(backend.switch_display({ index: 3 }), (err) => err.code === "bad_args" && /have \[1, 2\]/.test(err.message));
  await assert.rejects(backend.switch_display({ index: 0 }), (err) => err.code === "bad_args");
  await assert.rejects(backend.screenshot({ display: 9 }), (err) => err.code === "bad_args");
  await assert.rejects(backend.screenshot({ display: 2, region: [0, 0, 10, 10] }), (err) => err.code === "bad_args");
  assert.equal((await backend.switch_display({ index: 2 })).activeDisplay, 2);
  assert.ok(!desk.calls.some((c) => c.cmd === "scrot"), "nothing was captured for a refused display");
});

test("kill_app refuses ambiguity and never terminates its own process chain", async (t) => {
  x11Env(t);
  const backend = create({ exec: { run: fakeDesktop().run, have } });
  await assert.rejects(backend.kill_app({ pid: process.pid }), (err) => err.code === "bad_args");
  await assert.rejects(backend.kill_app({ pid: 999999999 }), (err) => err.code === "app_not_found");
  await assert.rejects(backend.kill_app({ bundle_id: "com.example.app" }), (err) => err.code === "unsupported_selector");
});

test("kill_app refuses a name that matches two processes and ends the one that is named by pid", { skip: process.platform !== "linux" }, async (t) => {
  x11Env(t);
  // Two copies of sleep under the same unique name: two processes, one kernel name.
  const name = `cwamb-${process.pid.toString(36)}`;
  const children = [];
  for (const sub of ["a", "b"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cu-amb-${sub}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, name);
    fs.copyFileSync("/bin/sleep", bin);
    fs.chmodSync(bin, 0o755);
    const child = spawn(bin, ["60"], { stdio: "ignore" });
    children.push(child);
    t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  }
  await new Promise((r) => setTimeout(r, 300));
  const backend = create({ exec: { run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, signal: null }), have } });
  await assert.rejects(backend.kill_app({ name }), (err) => err.code === "ambiguous_application" && err.pids.length === 2);
  const out = await backend.kill_app({ pid: children[0].pid });
  assert.equal(out.killed, true);
  // The second process was not touched.
  assert.equal(children[1].exitCode, null);
});

test("kill_app ends a process that ignores its window and reports the method", { skip: process.platform !== "linux" }, async (t) => {
  x11Env(t);
  // A copy of sleep under a unique name, so its kernel name is unambiguous.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-kill-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = `cwkt-${process.pid.toString(36)}`;
  const bin = path.join(dir, name);
  fs.copyFileSync("/bin/sleep", bin);
  fs.chmodSync(bin, 0o755);
  const child = spawn(bin, ["60"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await new Promise((r) => setTimeout(r, 200));
  const backend = create({ exec: { run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, signal: null }), have } });
  const out = await backend.kill_app({ pid: child.pid });
  assert.equal(out.killed, true);
  assert.equal(out.method, "sigterm");
});

test("a browser that exits at start is reported with its stderr; the root sandbox case names the fixes", () => {
  const root = browserStartFailure({ stderr: "ERROR: Running as root without --no-sandbox is not supported.", exit: { code: 1 } }, "/state/profile");
  assert.equal(root.code, "browser_unavailable");
  assert.match(root.message, /non-root user/);
  assert.match(root.message, /CODEWHALE_CU_BROWSER_APP/);
  assert.doesNotMatch(root.message, /--no-sandbox"?\s*flag/i, "the message must not offer to disable the sandbox");
  const other = browserStartFailure({ stderr: "cannot open profile", exit: { code: 2, signal: null } }, "/state/profile");
  assert.match(other.message, /exited before it opened its debugging endpoint \(code 2\)/);
  assert.match(other.message, /cannot open profile/);
  const silent = browserStartFailure(undefined, "/state/profile");
  assert.match(silent.message, /never came up/);
});

// sway: two outputs side by side. Workspace 1 on DP-1 is visible and holds a
// tiled Mousepad, a tiled foot and a floating Firefox dialog over Mousepad;
// workspace 2 on DP-1 is hidden.
const SWAY_TREE = { type: "root", nodes: [
  { type: "output", name: "DP-1", current_workspace: "1", rect: { x: 0, y: 0, width: 1280, height: 800 }, nodes: [
    { type: "workspace", name: "1", nodes: [
      { type: "con", id: 4, pid: 10165, app_id: "mousepad", name: "Untitled - Mousepad", visible: true, focused: true, rect: { x: 0, y: 0, width: 640, height: 800 } },
      { type: "con", id: 5, pid: 10400, app_id: "foot", name: "Terminal", visible: true, focused: false, rect: { x: 640, y: 0, width: 640, height: 800 } },
    ], floating_nodes: [
      { type: "floating_con", id: 6, pid: 20000, app_id: "firefox", name: "Save", visible: true, focused: false, rect: { x: 100, y: 100, width: 300, height: 200 } },
    ] },
    { type: "workspace", name: "2", nodes: [
      { type: "con", id: 7, pid: 30000, app_id: "gimp", name: "GIMP", visible: false, focused: false, rect: { x: 0, y: 0, width: 1280, height: 800 } },
    ], floating_nodes: [] },
  ] },
  { type: "output", name: "DP-2", current_workspace: "3", rect: { x: 1280, y: 0, width: 1280, height: 800 }, nodes: [
    { type: "workspace", name: "3", nodes: [], floating_nodes: [] },
  ] },
] };

function swayEnv(t, tree = SWAY_TREE) {
  const saved = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"].map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.DISPLAY;
  Object.assign(process.env, { WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" });
  const ok = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: "", timedOut: false, signal: null });
  return fakeDesktop({ onCommand: (cmd, args) => {
    if (cmd === "hyprctl") return { code: 1, stdout: "", stderr: "", timedOut: false, signal: null };
    if (cmd === "python3") return ok({ found: false, popup: null });
    if (cmd !== "swaymsg") return null;
    if (args.includes("get_tree")) return ok(typeof tree === "function" ? tree() : tree);
    if (args.includes("get_outputs")) return ok([{ name: "DP-1", active: true, rect: { x: 0, y: 0, width: 1280, height: 800 } }, { name: "DP-2", active: true, rect: { x: 1280, y: 0, width: 1280, height: 800 } }]);
    return ok({ human_readable: "1.9" });
  } });
}

test("sway names the focused window's app as the keyboard owner, by pid", async (t) => {
  const desk = swayEnv(t);
  const backend = create({ exec: { run: desk.run, have } });
  const owner = await backend.input_owner({ kind: "keyboard" });
  assert.equal(owner.name, "mousepad");
  assert.equal(owner.pid, 10165);
  assert.ok(!desk.calls.some((c) => c.cmd === "xdotool"));
});

test("sway pointer owner: floating windows above tiled, hidden workspaces ignored, empty space is the desktop", async (t) => {
  const backend = create({ exec: { run: swayEnv(t).run, have } });
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 200, y: 150 } })).name, "firefox");
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 20, y: 700 } })).name, "mousepad");
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 900, y: 10 } })).name, "foot");
  assert.equal(await backend.input_owner({ kind: "pointer", point: { x: 1500, y: 10 } }), null);
});

test("sway refuses a point where floating windows of two apps overlap, and pointer input without coordinates", async (t) => {
  const tree = structuredClone(SWAY_TREE);
  tree.nodes[0].nodes[0].floating_nodes.push({ type: "floating_con", id: 8, pid: 20100, app_id: "foot", name: "Other", visible: true, focused: false, rect: { x: 300, y: 250, width: 200, height: 200 } });
  const backend = create({ exec: { run: swayEnv(t, tree).run, have } });
  await assert.rejects(backend.input_owner({ kind: "pointer", point: { x: 350, y: 280 } }), (err) => err.code === "input_owner_unknown" && /overlap/.test(err.message));
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 450, y: 420 } })).name, "foot");
  await assert.rejects(backend.input_owner({ kind: "pointer" }), (err) => err.code === "input_owner_unknown");
});

test("sway refuses a point where XWayland windows of two apps overlap, whatever sway's stacking", async (t) => {
  const tree = structuredClone(SWAY_TREE);
  Object.assign(tree.nodes[0].nodes[0].nodes[0], { shell: "xwayland" });
  Object.assign(tree.nodes[0].nodes[0].floating_nodes[0], { shell: "xwayland" });
  const backend = create({ exec: { run: swayEnv(t, tree).run, have } });
  await assert.rejects(backend.input_owner({ kind: "pointer", point: { x: 200, y: 150 } }), (err) => err.code === "input_owner_unknown" && /XWayland/.test(err.message));
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 20, y: 700 } })).name, "mousepad");
});

test("sway with no window focused refuses keyboard input", async (t) => {
  const tree = structuredClone(SWAY_TREE);
  tree.nodes[0].nodes[0].nodes[0].focused = false;
  const backend = create({ exec: { run: swayEnv(t, tree).run, have } });
  await assert.rejects(backend.input_owner({ kind: "keyboard" }), (err) => err.code === "input_owner_unknown");
});

test("Hyprland names the active window's app as the keyboard owner", async (t) => {
  const saved = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"].map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.DISPLAY;
  Object.assign(process.env, { WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" });
  const ok = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: "", timedOut: false, signal: null });
  const win = { address: "0x55d1", pid: 4242, class: "kitty", title: "kitty", at: [0, 0], size: [800, 600], workspace: { id: 1, name: "1" }, floating: false, focusHistoryID: 0, mapped: true };
  const desk = fakeDesktop({ onCommand: (cmd, args) => {
    if (cmd === "swaymsg") return { code: 1, stdout: "", stderr: "", timedOut: false, signal: null };
    if (cmd !== "hyprctl") return null;
    if (args.includes("activewindow")) return ok(win);
    if (args.includes("clients")) return ok([win]);
    if (args.includes("monitors")) return ok([{ name: "eDP-1", x: 0, y: 0, width: 1600, height: 1000, scale: 1, activeWorkspace: { id: 1 }, specialWorkspace: { id: 0 } }]);
    return ok({ tag: "v0.41" });
  } });
  const backend = create({ exec: { run: desk.run, have } });
  assert.deepEqual(await backend.input_owner({ kind: "keyboard" }), { name: "kitty", comm: null, pid: 4242, wm_class: "kitty", title: "kitty", window: "0x55d1" });
  assert.equal((await backend.input_owner({ kind: "pointer", point: { x: 10, y: 10 } })).pid, 4242);
});

test("Wayland input maps keys, clicks and scrolls onto virtual-device steps in layout coordinates", async (t) => {
  const desk = swayEnv(t);
  const sent = [];
  const inputClient = { request: async (steps) => { sent.push(steps); return { ok: true }; }, info: async () => ({ ok: true, virtual_keyboard: true, virtual_pointer: true }), close() {} };
  const backend = create({ exec: { run: desk.run, have, waylandInput: inputClient } });
  await backend.key({ text: "ctrl+shift+Left" });
  assert.deepEqual(sent.at(-1), [["key", "Control_L", 1], ["key", "Shift_L", 1], ["key", "Left", 1], ["key", "Left", 0], ["key", "Shift_L", 0], ["key", "Control_L", 0]]);
  await backend.right_click({ target: { x: 1300, y: 20 } });
  assert.deepEqual(sent.slice(-2), [[["move", 1300, 20, 2560, 800], ["sleep", 30], ["move", 1301, 20, 2560, 800], ["move", 1300, 20, 2560, 800]], [["button", 0x111, 1], ["button", 0x111, 0]]]);
  await backend.scroll({ target: { x: 10, y: 10 }, direction: "up", amount: 2 });
  assert.deepEqual(sent.at(-1), [["axis", 0, -15, -1], ["sleep", 16], ["axis", 0, -15, -1]]);
  await backend.type({ text: "café ok" });
  assert.deepEqual(sent.at(-1), [["text", "café ok"]]);
  const probe = await backend.probe();
  assert.equal(probe.permissions.input, "ok");
  assert.equal(probe.capabilities.raw_input, true);
});

test("Wayland without sway or Hyprland reports input refused and never starts the input helper", async (t) => {
  const saved = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP"].map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.DISPLAY;
  Object.assign(process.env, { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" });
  const fail = { code: 1, stdout: "", stderr: "", timedOut: false, signal: null };
  const desk = fakeDesktop({ onCommand: (cmd) => (cmd === "swaymsg" || cmd === "hyprctl" ? fail : null) });
  let started = 0;
  const inputClient = { request: async () => { started++; return { ok: true }; }, info: async () => { started++; return { ok: true }; }, close() {} };
  const backend = create({ exec: { run: desk.run, have, waylandInput: inputClient } });
  const probe = await backend.probe();
  assert.equal(probe.permissions.input, "refused");
  assert.match(probe.input_reason, /GNOME on Wayland/);
  await assert.rejects(backend.input_owner({ kind: "keyboard" }), (err) => err.code === "input_owner_unknown");
  assert.equal(started, 0);
});
