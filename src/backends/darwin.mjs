// macOS backend. Zero third-party dependencies:
//  - observation and input: native Accessibility and CoreGraphics APIs
//  - stills:      /usr/sbin/screencapture
//  - video:       ScreenCaptureKit in the signed helper (macOS 13+, no overlay)
//  - crop:         sips   - clipboard: pbcopy/pbpaste
// Helper requests use structured JSON over the resident pipe or one process argument.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { run, runOk, ExecError, tryJson, have, withSignal, wait, throwIfAborted, currentSignal } from "../exec.mjs";
import { stateDir } from "../registry.mjs";
import { isStrict } from "../approval-mode.mjs";
import { createBrowser } from "../browser-cdp.mjs";
import { chromiumPointer } from "./darwin-chromium.mjs";
import { liveMarker, isPromptProcess } from "../native-prompt.mjs";
import { recordingsDir, recordingsOutputPath } from "../recordings.mjs";

/** Base64 expands 3 bytes to 4, padded to a multiple of 4. */
const encodedSize = (bytes) => Math.ceil(bytes / 3) * 4;

/**
 * Largest base64 payload a single JSON-RPC message may carry. Stdio hosts cap
 * what a server may write between message boundaries (Claude Code disconnects
 * at 16MB) and model image APIs cap well below that. Mirrors
 * CODEWHALE_CU_MAX_IMAGE_BYTES in mcp/server.mjs, which keeps the hard guard.
 */
const rasterByteBudget = () => (Number(process.env.CODEWHALE_CU_MAX_IMAGE_BYTES) > 0
  ? Number(process.env.CODEWHALE_CU_MAX_IMAGE_BYTES)
  : 5_000_000);

/**
 * Pixel dimensions from a PNG IHDR or a JPEG frame header, reading only the
 * bytes that carry them rather than the whole raster.
 */
function imagePixels(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head[0] === 0x89 && head.toString("ascii", 1, 4) === "PNG") {
      return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
    }
    if (head[0] !== 0xff || head[1] !== 0xd8) throw new ExecError(`unrecognized raster format: ${file}`);
    // Walk JPEG segments to the frame header. SOF0/1/2/3/5..7/9..11/13..15
    // carry the dimensions; DHT/DQT and the rest are skipped by their length.
    const size = fs.fstatSync(fd).size;
    const seg = Buffer.alloc(9);
    for (let at = 2; at + 9 <= size; ) {
      fs.readSync(fd, seg, 0, 9, at);
      if (seg[0] !== 0xff) throw new ExecError(`malformed JPEG at byte ${at}: ${file}`);
      const marker = seg[1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: seg.readUInt16BE(7), h: seg.readUInt16BE(5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
      at += 2 + seg.readUInt16BE(2);
    }
    throw new ExecError(`JPEG carries no frame header: ${file}`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Shrink a raster until it fits the single-message budget.
 *
 * A 5K display captures to ~22MB of PNG, which is ~29MB of base64 — past every
 * host limit, so the alternative is handing back a receipt with no picture and
 * a screenshot tool that never shows anything. Downscaling here, before the
 * caller reads the PNG header, keeps coordinates exact by construction:
 * `pixels` comes from the header, `points` stays in screen points, and `scale`
 * is derived from the two, so raster-to-point conversion follows automatically.
 *
 * PNG bytes track pixel count, so the long edge shrinks by the square root of
 * the overshoot. The estimate is verified rather than trusted — screen content
 * compresses unevenly — and gives up rather than shrinking past legibility.
 */
async function fitRasterToBudget(file) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const budget = rasterByteBudget();
    const size = fs.statSync(file).size;
    if (encodedSize(size) <= budget) return;
    const { w, h } = imagePixels(file);
    const longest = Math.max(w, h);
    if (longest <= 640) return;
    const overshoot = encodedSize(size) / budget;
    const target = Math.max(640, Math.floor((longest / Math.sqrt(overshoot)) * 0.9));
    if (target >= longest) return;
    await runOk("sips", ["-Z", String(target), file], { timeoutMs: 20_000 });
  }
}

async function fitRasterToDimension(file, maxDimension) {
  if (maxDimension === undefined) return;
  const { w, h } = imagePixels(file);
  if (Math.max(w, h) <= maxDimension) return;
  await runOk("sips", ["-Z", String(maxDimension), file], { timeoutMs: 20_000 });
}

const KEY_CODES = {
  return: 36, enter: 36, tab: 48, space: 49, escape: 53, esc: 53, delete: 51,
  backspace: 51, forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, clear: 71, capslock: 57, f1: 122,
  f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, volumeup: 72, volumedown: 73, mute: 74, help: 114,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29, "-": 27, "=": 24,
  "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
};
// Shifted symbols on a US layout, sent as shift plus their base key.
const SHIFTED = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
};
const MODIFIERS = {
  cmd: 1 << 20, command: 1 << 20, win: 1 << 20, meta: 1 << 20,
  shift: 1 << 17, ctrl: 1 << 18, control: 1 << 18, alt: 1 << 19, opt: 1 << 19, option: 1 << 19,
  fn: 1 << 23, function: 1 << 23,
};
const KEY_ALIASES = {
  pgdn: "pagedown", pgup: "pageup", arrowleft: "left", arrowright: "right",
  arrowup: "up", arrowdown: "down", del: "forwarddelete", kpenter: "enter",
};
// CGEventType values (CGEventTypes.h). The dragged codes are easy to get
// wrong: 6 is LeftMouseDragged and 7 is RightMouseDragged, so a left drag sent
// as 7 is delivered as a right-button drag and no view ever sees it.
const MOUSE = {
  left: { down: 1, up: 2, dragged: 6 },
  right: { down: 3, up: 4, dragged: 7 },
  middle: { down: 25, up: 26, dragged: 27 },
};
const MOUSE_MOVED = 5;

/**
 * Native refusals carry exception reasons; these map to stable codes so
 * receipts and callers can branch without parsing prose. Unknown reasons stay
 * uncoded (the message is the contract there).
 */
export function nativeErrorCode(message) {
  const m = String(message ?? "");
  if (/^background_focus_required:/.test(m)) return "background_focus_required";
  if (/^user_busy:/.test(m)) return "user_busy";
  if (/^screen_locked:/.test(m)) return "screen_locked";
  if (/^element_stale:/.test(m)) return "element_stale";
  for (const code of ["pointer_reading_toolkit", "chromium_pointer_unavailable", "drag_session_active", "drag_session_detected", "menu_item_not_found", "menu_item_disabled", "menu_item_ambiguous", "key_window_unconfirmed", "text_focus_unconfirmed"]) if (m.startsWith(`${code}:`)) return code;
  if (/ambiguous/i.test(m)) return "window_ambiguous";
  if (/not capturable/i.test(m)) return "window_not_capturable";
  if (/several running applications match/i.test(m)) return "ambiguous_application";
  if (/cannot be terminated by this plugin/i.test(m)) return "protected_application";
  if (/refused the window frame change/i.test(m)) return "frame_refused";
  if (/no accessibility geometry/i.test(m)) return "window_target_not_found";
  if (/application not found|no running application/i.test(m)) return "app_not_found";
  if (/^focused_control_unknown:/.test(m)) return "focused_control_unknown";
  return null;
}

/**
 * Regular apps are what "open an app" means; accessories and daemons answer
 * menu-bar and background questions. Keep the signal, drop the XPC soup.
 * A helper that predates the activation_policy field returns the list whole.
 */
export function selectApps(apps, all) {
  if (all || !apps.some((a) => a.activation_policy)) return apps;
  return apps.filter((a) => a.activation_policy === "regular" || a.frontmost === true);
}

const GUARDED_TOOLS = new Set(["type", "key_event", "bg_pointer", "bg_key", "set_value", "select_text", "perform_action", "click_element", "scroll_element", "focus_element", "invoke_menu"]);
const callChanges = new AsyncLocalStorage();
let sharedAgent = null;
let agentStarting = null;
let agentRetryAt = 0;

export function displayAwakeSeconds(value = process.env.CODEWHALE_CU_KEEP_DISPLAY_AWAKE) {
  if (value === undefined || value === "") return 600;
  if (/^(0|off|false|no)$/i.test(String(value).trim())) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 86_400) : 600;
}

export function mergeWindowChanges(list) {
  const seen = new Set();
  const windows = (key) => list.flatMap((c) => c[key] ?? []).filter((w) => !seen.has(`${key}:${w.window_id}`) && seen.add(`${key}:${w.window_id}`));
  const sum = (key) => list.reduce((n, c) => n + (c[key] ?? 0), 0);
  const out = {
    observed: list.every((c) => c.observed),
    new_windows: windows("new_windows"),
    foreground_changed: list.some((c) => c.foreground_changed),
    key_focus_guard: list.some((c) => c.key_focus_guard),
    key_focus_kept: list.every((c) => c.key_focus_kept !== false),
  };
  const earlier = windows("earlier_new_windows");
  if (earlier.length) out.earlier_new_windows = earlier;
  for (const key of ["key_focus_released", "self_activation_reverted", "window_order_restored"]) if (sum(key)) out[key] = sum(key);
  return out;
}

export function windowChanges(armed, settled) {
  if (!armed?.ok || !settled?.ok) return { observed: false };
  const pick = (w) => ({ window_id: w.window_id, pid: w.pid, app: w.app, title: w.title || null, layer: w.layer, ...(w.layer === 101 ? { menu: true } : {}) });
  return {
    observed: true,
    new_windows: (settled.new_windows ?? []).map(pick),
    earlier_new_windows: (settled.earlier_new_windows ?? []).map(pick),
    foreground_changed: settled.foreground_changed === true,
    key_focus_guard: armed.key_focus_guard === true,
    key_focus_kept: !(armed.key_focus_pid > 0) || settled.key_focus_pid === armed.key_focus_pid,
    key_focus_released: settled.key_focus_released ?? 0,
    self_activation_reverted: settled.self_activation_reverted ?? 0,
    window_order_restored: settled.window_order_restored ?? 0,
  };
}

// Tools that act at a point and so move the agent's drawn cursor there.
const AGENT_CURSOR_TOOLS = new Set(["bg_pointer", "hit_test", "click_element", "perform_action", "scroll_element", "focus_element", "set_value", "select_text", "type"]);
const AGENT_CURSOR_GLIDE_MS = Math.min(600, Math.max(0, Number(process.env.CODEWHALE_CU_AGENT_CURSOR_GLIDE_MS ?? 180) || 0));
const MOUSE_DOWN_TYPES = new Set(Object.values(MOUSE).map((m) => m.down));
function agentCursorClick(tool, args) {
  if (tool === "bg_pointer") return (args.steps ?? []).some((s) => MOUSE_DOWN_TYPES.has(s?.type));
  if (tool === "hit_test") return !args.direction;
  return tool === "click_element" || tool === "perform_action";
}

export function create({ exec }) {
  const runL = (cmd, args, opts) => exec.run(cmd, args, opts);
  const state = { activeDisplay: 1, lastRaster: null, inputApp: null, foregroundInput: false, previewEnabled: false, pointer: null, heldDrag: null, agentCursor: process.env.CODEWHALE_CU_AGENT_CURSOR !== "0" };
  const awakeSeconds = displayAwakeSeconds();
  const settleMs = Math.max(0, Number(process.env.CODEWHALE_CU_SETTLE_MS ?? 300) || 0);
  // Shared-surface politeness: menu-opening presses, real-pointer gestures,
  // foreground keys and activations wait for a gap in the user's hardware
  // input rather than interleave with their typing. The helper reads the
  // same HID idle clock it uses for interference accounting. gap<=0 turns
  // the wait off entirely; wait_ms bounds it and refuses user_busy if the
  // person is still active. Successful waits report yield_ms in the receipt.
  const yieldArgs = {
    yield_gap_ms: Number(process.env.CODEWHALE_CU_YIELD_GAP_MS ?? 450),
    yield_wait_ms: Number(process.env.CODEWHALE_CU_YIELD_WAIT_MS ?? 2500),
  };
  let previewLoop = null;
  let previewBusy = false;
  let previewActiveAt = 0;
  let previewOwner = null;
  let previewVisible = false;
  let previewWork = Promise.resolve();
  function stopPreviewLoop() { if (previewLoop) { clearInterval(previewLoop); previewLoop = null; } }
  const previewPath = (owner, extension) => path.join(stateDir(), "preview", `${owner}.${extension}`);
  const previewDismissed = (owner) => owner && fs.existsSync(previewPath(owner, "dismissed"));
  async function retirePreview(disable = false) {
    const owner = previewOwner;
    previewOwner = null;
    previewVisible = false;
    if (disable) state.previewEnabled = false;
    stopPreviewLoop();
    if (!owner) return;
    try { await native("preview_notify", { enabled: false, owner }); }
    finally {
      for (const ext of ["png", "next.png", "dismissed"]) fs.rmSync(previewPath(owner, ext), { force: true });
    }
  }
  const browser = createBrowser();
  function startPreviewLoop() {
    if (previewLoop) return;
    const ms = Number(process.env.CODEWHALE_CU_PREVIEW_REFRESH_MS ?? 1000);
    const refreshMs = Number.isFinite(ms) && ms > 0 ? Math.max(50, ms) : 0;
    const idleMs = Math.max(5_000, Number(process.env.CODEWHALE_CU_PREVIEW_IDLE_MS) || 60_000);
    let refreshedAt = Date.now();
    previewLoop = setInterval(() => {
      if (previewBusy || !state.previewEnabled || !state.inputApp) return;
      if (previewDismissed(previewOwner)) { retirePreview(true).catch(() => {}); return; }
      if (Date.now() - previewActiveAt > idleMs) { retirePreview().catch(() => {}); return; }
      if (!refreshMs || Date.now() - refreshedAt < refreshMs) return;
      refreshedAt = Date.now();
      previewBusy = true;
      updatePreview(false).catch(() => {}).finally(() => { previewBusy = false; });
    }, refreshMs ? Math.min(refreshMs, 1000) : 1000);
    previewLoop.unref?.();
  }

  async function nativeHelper() {
    let helper = process.env.CODEWHALE_CU_APP_BUNDLE
      ? path.join(process.env.CODEWHALE_CU_APP_BUNDLE, "Contents", "MacOS", "accessibility") : null;
    if (!helper || !fs.existsSync(helper)) {
      const packaged = fileURLToPath(new URL("../../bin/darwin/accessibility", import.meta.url));
      if (fs.existsSync(packaged)) helper = packaged;
    }
    // A source checkout (plugin installs in other hosts) self-compiles an
    // unsigned helper, which has no TCC grant. Prefer the installed app's
    // signed helper so accessibility and screen-recording grants carry over.
    if (!helper || !fs.existsSync(helper)) {
      const installed = path.join(os.homedir(), "Applications", "Codewhale Computer Use.app", "Contents", "MacOS", "accessibility");
      if (fs.existsSync(installed)) helper = installed;
    }
    if (!helper || !fs.existsSync(helper)) {
      const source = fileURLToPath(new URL("./darwin-accessibility.m", import.meta.url));
      const hash = crypto.createHash("sha256").update(fs.readFileSync(source)).update(fs.readFileSync(new URL("./darwin-recording.h", import.meta.url))).update(fs.readFileSync(new URL("./darwin-ocr.h", import.meta.url))).digest("hex").slice(0, 16);
      const dir = path.join(os.homedir(), ".codewhale-cu", "bin");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      helper = path.join(dir, `accessibility-${hash}`);
      if (!fs.existsSync(helper)) {
        const tmp = `${helper}-${process.pid}`;
        const r = await runL("clang", ["-fobjc-arc", "-Os", "-framework", "Cocoa", "-framework", "ApplicationServices", "-framework", "ScreenCaptureKit", "-framework", "AVFoundation", "-framework", "CoreMedia", "-framework", "Vision", source, "-o", tmp], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new ExecError(`native accessibility helper needs a built app or Xcode Command Line Tools: ${r.stderr}`, r);
        fs.renameSync(tmp, helper);
      }
    }
    return helper;
  }

  async function agent() {
    if (!exec.startAgent || process.env.CODEWHALE_CU_AGENT === "off") return null;
    if (sharedAgent?.alive) return sharedAgent;
    if (agentStarting) return agentStarting;
    if (Date.now() < agentRetryAt) return null;
    agentRetryAt = Date.now() + 30_000;
    agentStarting = (async () => {
      const link = exec.startAgent(await nativeHelper(), [JSON.stringify({ tool: "agent", args: {} })]);
      const hello = link ? await link.request("hello", {}, 3000) : null;
      if (hello?.agent !== 1) { link?.close(); return null; }
      link.nativeRpc = hello.native_rpc === 1;
      sharedAgent = link;
      agentRetryAt = 0;
      return link;
    })().finally(() => { agentStarting = null; });
    return agentStarting;
  }

  async function captureWindowFile(windowId, file) {
    const link = await agent();
    const format = /\.png$/i.test(file) ? "png" : "jpg";
    const cap = link ? await link.request("capture", { window_id: windowId, file, format }, 12_000) : null;
    if (cap?.ok) return { route: cap.route, on_current_space: cap.on_current_space };
    if (cap?.error === "screen_locked") throw Object.assign(new ExecError("screen_locked: the Mac is locked; apps cannot be read or controlled until the person unlocks it. No input was sent."), { code: "screen_locked" });
    const r = await runL("screencapture", ["-x", "-t", format, "-o", "-l", String(windowId), file], { timeoutMs: 8000 });
    if (r.code !== 0) throw Object.assign(new ExecError(`window capture failed: ${(cap?.tried ?? []).map((t) => `${t.route}: ${t.reason}`).join("; ") || r.stderr.trim().slice(0, 300)}`, r), { code: "window_not_capturable" });
    return { route: "screencapture", ...(cap ? { agent_tried: cap.tried } : {}) };
  }

  async function refuseLocked() {
    const status = await (await agent())?.request("status");
    if (status?.screen_locked) throw Object.assign(new ExecError("screen_locked: the Mac is locked; apps cannot be read or controlled until the person unlocks it. No input was sent."), { code: "screen_locked" });
  }

  function requireForegroundInput() {
    if (!state.foregroundInput) throw Object.assign(new ExecError("This action would take keyboard focus and was not sent in background mode. Use an accessibility action, browser control, or a separate computer."), { code: "background_focus_required" });
  }

  function requireFocusControl() {
    if (!isStrict()) return;
    requireForegroundInput();
  }

  function assertNotPrompt(...refs) {
    const pids = liveMarker({ fs, dir: stateDir() })?.pids ?? [];
    if (refs.some((ref) => isPromptProcess(ref, pids))) {
      throw Object.assign(new ExecError("osascript and the Computer Use approval dialog belong to the person; this plugin does not bind to, observe or operate them."), { code: "protected_application" });
    }
  }

  let nativeCapabilities;
  async function native(tool, args = {}) {
    assertNotPrompt(args?.app_ref, args?.target?.app_ref, args?.from_target?.app_ref, args?.to?.app_ref, tool === "kill_app" ? args : null, state.inputApp);
    // Window-addressed events take keyboard focus inside the target app. Strict approval mode
    // refuses that before even starting an older installed helper.
    if (["bg_pointer", "bg_key"].includes(tool)) requireFocusControl();
    // Every resolved target (element center or screen point) is where the
    // action lands; tracking it here means the preview cursor follows element
    // actions, not just raw pointer events.
    if (tool === "type" && !state.foregroundInput && (await native("input_capabilities"))?.background_focus_guard !== 1) {
      throw Object.assign(new ExecError("Update the Computer Use helper before background typing; this helper may borrow keyboard focus."), { code: "app_upgrade_required" });
    }
    const t = args?.target;
    let point = null;
    if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) point = { x: t.x, y: t.y };
    if (tool === "hit_test" && args.perform && Number.isFinite(args.x) && Number.isFinite(args.y)) point = { x: args.x, y: args.y };
    if (tool === "bg_pointer") {
      const last = [...(args.steps ?? [])].reverse().find((s) => Number.isFinite(s?.x) && Number.isFinite(s?.y));
      if (last) point = { x: last.x, y: last.y };
    }
    if (point) state.pointer = point;
    const agentPointer = point && state.agentCursor && AGENT_CURSOR_TOOLS.has(tool) && (tool !== "hit_test" || args.perform)
      ? { ...point, click: agentCursorClick(tool, args), glide_ms: AGENT_CURSOR_GLIDE_MS } : undefined;
    if (args.observed_window && (await native("input_capabilities"))?.observed_window_input !== 1) throw Object.assign(new ExecError("Update Computer Use before acting on a captured window; this helper cannot preserve its identity"), { code: "app_upgrade_required" });
    const helper = await nativeHelper();
    let capabilityKey;
    if (tool === "input_capabilities") {
      const stat = fs.statSync(helper);
      capabilityKey = `${helper}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (nativeCapabilities?.key === capabilityKey) return { ...nativeCapabilities.value };
    }
    const inputTool = GUARDED_TOOLS.has(tool) || (tool === "hit_test" && args.perform);
    const guarded = inputTool && state.inputApp && !state.foregroundInput;
    const intentional = (inputTool && state.foregroundInput) || (tool === "app_info" && args.activate);
    const link = await agent();
    if (intentional) await link?.request("intent");
    const armed = guarded ? await link?.request("arm", { target_pid: state.inputApp.pid, awake_s: awakeSeconds }) : null;
    let r;
    try {
      const input = { ...args, ...yieldArgs, ...(agentPointer ? { agent_pointer: agentPointer } : {}), input_app_ref: state.inputApp, foreground_input: state.foregroundInput, focus_lease: !isStrict(), owner_pipe: true };
      if (link?.nativeRpc) {
        const reply = await link.request("execute", { tool, args: input }, 20_000, { signal: currentSignal() });
        r = { code: reply?.ok ? 0 : 1, stdout: reply?.ok ? JSON.stringify(reply.data) : "", stderr: reply?.error ?? "native command owner disconnected",
          aborted: reply?.aborted === true, timedOut: !reply || reply.timed_out === true, spawned: reply?.request_dispatched !== false };
      } else r = await runL(helper, [JSON.stringify({ tool, args: input })], { timeoutMs: 20_000, ownerPipe: true });
    } finally {
      const changes = callChanges.getStore();
      if (armed?.ok) {
        const reportMs = changes?.length ? Math.min(settleMs, 50) : settleMs;
        const settled = await link.request("settle", { action: armed.action, report_ms: reportMs }, reportMs + 2000);
        changes?.push(windowChanges(armed, settled));
      } else if (guarded && link) changes?.push({ observed: false });
    }
    if (r.aborted || r.timedOut || r.code !== 0) {
      const error = new ExecError(r.aborted ? "computer request cancelled" : r.timedOut ? "native accessibility helper timed out" : r.stderr.trim() || "native accessibility helper failed", r);
      if (r.aborted) error.code = "cancelled";
      else error.code = nativeErrorCode(error.message) ?? undefined;
      // A deterministic native refusal sent no input. A killed/timed-out
      // helper may have posted the press before losing its response.
      const postsPress = (tool === "key_event" && args.down) || ["type", "perform_action", "click_element", "scroll_element", "set_value", "focus_element", "select_text", "bg_pointer", "bg_key", "invoke_menu"].includes(tool) || (tool === "hit_test" && args.perform);
      error.inputMayHaveBeenSent = postsPress && r.spawned === true && (r.aborted || r.timedOut || /^drag_session_detected:/.test(r.stderr));
      if (error.inputMayHaveBeenSent) error.message += "; input may already have been sent — observe the target before doing anything else";
      throw error;
    }
    const result = tryJson(r.stdout, null);
    if (capabilityKey && result) nativeCapabilities = { key: capabilityKey, value: { ...result } };
    if (tool === "get_app_state" || tool === "window_info") assertNotPrompt(result);
    if (state.previewEnabled && state.inputApp && ["type", "key_event", "bg_pointer", "bg_key", "set_value", "select_text", "perform_action", "hit_test", "click_element", "scroll_element", "focus_element"].includes(tool)) {
      previewActiveAt = Date.now();
      try { await updatePreview(!previewVisible); } catch (error) { result.preview_error = error.message; }
    }
    return result;
  }

  async function requireBackgroundActions() {
    if ((await native("input_capabilities"))?.background_actions !== 1) {
      throw Object.assign(new ExecError("Update the Computer Use helper to use background focus, selection, context menus and scrolling."), { code: "app_upgrade_required" });
    }
  }

  function assertBoundElement(target) {
    if (!state.inputApp || target.app_ref?.pid !== state.inputApp.pid) throw new ExecError("element does not belong to the bound application — open_application and observe again");
    if (!Array.isArray(target.path) || !Number.isInteger(target.windowIndex) || !target.role) throw new ExecError("element has no resolved accessibility identity");
  }

  async function nativeLease(tool, args) {
    if (!exec.runInputLease) throw new ExecError("This executor cannot safely own held input; update Computer Use");
    if ((await native("input_capabilities"))?.input_lease !== 1) throw new ExecError("The native helper needs an update for disconnect-safe held input");
    const helper = await nativeHelper();
    if (args.target?.native_ref) {
      const resolved = await native("resolve_element", { ...args.target });
      if (!resolved?.found) throw Object.assign(new ExecError("the observed native target no longer resolves; observe again before pointer input"), { code: "element_stale" });
      const { native_ref, ...target } = args.target;
      args = { ...args, target };
    }
    try {
      return await exec.runInputLease(helper, [JSON.stringify({ tool, args: { ...args, ...yieldArgs, input_app_ref: state.inputApp, foreground_input: state.foregroundInput, focus_lease: !isStrict(), owner_pipe: true, input_lease: true } })]);
    } catch (error) {
      error.code = nativeErrorCode(error.message) ?? error.code;
      throw error;
    }
  }

  function updatePreview(show = false) {
    if (!state.previewEnabled || !state.inputApp) return Promise.resolve({ enabled: false });
    if (previewDismissed(previewOwner)) return retirePreview(true).then(() => ({ enabled: false }));
    previewOwner ??= crypto.randomUUID();
    const owner = previewOwner;
    const work = previewWork.catch(() => {}).then(async () => {
      const current = () => state.previewEnabled && previewOwner === owner && !previewDismissed(owner);
      if (!current()) return { enabled: false };
      const dir = path.join(stateDir(), "preview");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = previewPath(owner, "next.png"), file = previewPath(owner, "png");
      try {
        const win = await native("window_info", { app_ref: state.inputApp });
        if (!current()) return { enabled: false };
        await captureWindowFile(win.window_id, temp);
        if (!current()) return { enabled: false };
        fs.renameSync(temp, file);
        const p = state.pointer;
        let userCursor = null;
        try { userCursor = await native("cursor_position"); } catch {}
        if (!current()) return { enabled: false };
        await native("preview_notify", { enabled: true, show, owner, title: `Codewhale · ${win.name} · ${state.foregroundInput ? "Shared desktop control" : "Background app control"}`, x: p ? (p.x-win.points.x)/win.points.w : -1, y: p ? (p.y-win.points.y)/win.points.h : -1,
          user_x: userCursor && Number.isFinite(userCursor.x) ? (userCursor.x-win.points.x)/win.points.w : -1,
          user_y: userCursor && Number.isFinite(userCursor.y) ? (userCursor.y-win.points.y)/win.points.h : -1 });
        if (!current()) return { enabled: false };
        if (show) previewVisible = true;
        startPreviewLoop();
        return { enabled: true, file, app: state.inputApp, pointer: p };
      } finally {
        fs.rmSync(temp, { force: true });
        if (!current()) fs.rmSync(file, { force: true });
      }
    });
    previewWork = work.catch(() => {});
    return work;
  }

  // ---------- pointer input ----------
  function mouseName(button) { return { left: "left", right: "right", middle: "middle" }[button] ?? "left"; }

  function assertInScreen(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ExecError("coordinates must be finite numbers");
  }

  function buttonCode(button) { return button === "middle" ? 2 : button === "right" ? 1 : 0; }

  function pointerBinding(target) {
    if (target?.coordinate_space !== "raster") return target?.type === "element" ? { target } : {};
    const observed = state.lastRaster?.observed_window;
    if (state.lastRaster && !state.lastRaster.app_ref) return {};
    if (!observed || observed.pid !== state.inputApp?.pid) throw new ExecError("raster has no window identity for the bound application — capture its window again");
    if (state.lastRaster.off_space) throw Object.assign(new ExecError("this raster shows a window on another Space; input to it is not supported. Ask the person to bring it to this desktop, or use an element action."), { code: "window_off_space" });
    return { observed_window: observed };
  }

  /**
   * Every pointer gesture — click, hover, drag, wheel — goes to a window of the
   * bound application as window-routed event records. The user's hardware
   * cursor is never posted to, warped or held: there is no shared-pointer
   * route to fall back to. Window ownership is enforced inside the helper (the
   * records are addressed to a window id of the bound app), so a covering
   * window cannot receive them.
   */
  async function windowPointer(steps, extra = {}, binding = {}) {
    requireFocusControl();
    const caps = await native("input_capabilities");
    if (caps?.window_record !== 1) {
      throw Object.assign(new ExecError("Pointer input needs the window-routed pointer, which this helper cannot resolve; update Computer Use or use an accessibility action. The user's cursor is never used instead."), { code: "bg_dispatch_unavailable" });
    }
    if (!state.foregroundInput && caps?.pid_input !== 1) {
      throw Object.assign(new ExecError("Background pointer input needs a helper that posts to the app's process; update the Codewhale Computer Use app, or use an accessibility action."), { code: "app_upgrade_required" });
    }
    if (caps.pointer_context === 1 && (steps.every(s => s.type === MOUSE_MOVED) || steps.some(s => [6, 7, 27].includes(s.type)))) {
      const context = await native("pointer_context", { steps, ...binding });
      if (context.chromium) {
        const link = await agent();
        if (!link) throw Object.assign(new ExecError("Chromium pointer control needs the resident native guard; update the helper and plugin together."), { code: "app_upgrade_required" });
        const armed = await link.request(state.foregroundInput ? "intent" : "arm", { target_pid: state.inputApp.pid, awake_s: awakeSeconds });
        if (!armed?.ok) throw new ExecError("The resident guard could not prepare the Chromium gesture");
        let lease;
        try {
          lease = await nativeLease("bg_pointer", { steps, ...binding, prepare_only: true });
          const prepared = lease.receipt;
          const expected = JSON.stringify({ window: prepared.window, web: prepared.web });
          const observed_window = { pid: prepared.pid, id: prepared.window.id, frame: { x: prepared.window.x, y: prepared.window.y, w: prepared.window.w, h: prepared.window.h } };
          return await chromiumPointer(prepared, steps, { run: runL, validate: async () => {
            if (caps.pointer_owner_validation === 1) {
              const checked = await lease.send({ validate: true });
              if (checked.validated !== true) throw Object.assign(new ExecError(checked.error ?? "The native pointer owner refused further input"), { code: nativeErrorCode(checked.error) ?? "element_stale" });
              return;
            }
            const current = await native("pointer_context", { steps, observed_window });
            if (JSON.stringify({ window: current.window, web: current.web }) !== expected) throw new ExecError("The bound web window changed during the gesture; observe before retrying");
          } });
        } finally {
          try { await lease?.release(); }
          finally {
            if (!state.foregroundInput) {
              const settled = await link.request("settle", { action: armed.action, report_ms: settleMs }, settleMs + 2000);
              callChanges.getStore()?.push(windowChanges(armed, settled));
            }
          }
        }
      }
    }
    const r = await native("bg_pointer", { steps, ...extra, ...binding });
    return { action_sent: true, strategy: r.strategy ?? "pid-routed", input_scope: "application-window", pointer_moved: false,
             ...(r.drag_session_detected !== undefined ? { drag_session_detected: r.drag_session_detected } : {}),
             ...(typeof r.verified === "boolean" ? { verified: r.verified, verification_required: r.verification_required } : {}),
             front_lease: false, window: r.window ?? null,
             ...(Number.isFinite(r.yield_ms) ? { yield_ms: r.yield_ms } : {}),
             ...(r.menu_lease_held ? { menu_lease_held: true, menu_holds_key_focus: true } : {}) };
  }

  function clickSteps(button, x, y, clicks) {
    const m = MOUSE[button] ?? MOUSE.left;
    const b = buttonCode(button);
    const steps = [{ type: MOUSE_MOVED, x, y, button: b, clickState: 0 }];
    for (let i = 1; i <= clicks; i++) {
      steps.push({ type: m.down, x, y, button: b, clickState: i });
      steps.push({ type: m.up, x, y, button: b, clickState: i });
    }
    return steps;
  }

  /**
   * Coordinate pointer click. A left single click is first hit-tested against
   * the bound application's accessibility tree: when the point names a
   * pressable element we perform its semantic action, which needs no pointer
   * and no foreground. strategy="a11y" requires that and fails closed;
   * strategy="event" goes straight to the guarded global gesture.
   */
  async function pointerClick(button, x, y, clicks, strategy = "auto", target) {
    assertInScreen(x, y);
    if (!["auto", "a11y", "event", "app"].includes(strategy)) throw new ExecError(`strategy must be auto, a11y, app or event (got ${JSON.stringify(strategy)})`);
    const binding = pointerBinding(target);
    let a11yReason = null;
    if (strategy !== "event" && ["left", "right"].includes(button) && clicks === 1) {
      if (button === "right") await requireBackgroundActions();
      const hit = await native("hit_test", { x, y, perform: true, ...binding, ...(button === "right" ? { operation: "context" } : {}) });
      if (hit?.action_sent) {
        return { action_sent: true, strategy: "a11y", action: hit.action, pointer_moved: false, at: { x, y }, button, clicks,
                 element: { role: hit.element?.role ?? null, label: hit.element?.label ?? null },
                 ...(Number.isFinite(hit.yield_ms) ? { yield_ms: hit.yield_ms } : {}),
                 ...(hit.menu_lease_held ? { menu_lease_held: true, menu_holds_key_focus: true } : {}) };
      }
      a11yReason = hit?.reason ?? "not_found";
      if (strategy === "a11y") {
        throw new ExecError(`no supported accessibility click at (${x}, ${y}) in the bound application (${a11yReason}) — observe the available actions, use strategy "app" for a window-routed pointer click, or a separate computer`);
      }
    } else if (strategy === "a11y") {
      throw new ExecError(`strategy "a11y" is only available for a left single click on this backend; ${mouseName(button)} x${clicks} has no accessibility equivalent`);
    }
    // Whatever the strategy, a raw click is a window-routed record: "app" and
    // "event" only choose whether the accessibility hit-test runs first.
    const r = await windowPointer(clickSteps(button, x, y, clicks),
      a11yReason === "web_popup_requires_real_click" ? { menu_poll_ms: 6000 } : {}, binding);
    return { ...r, at: { x, y }, button, clicks, ...(a11yReason ? { a11y_reason: a11yReason } : {}) };
  }

  async function withPressedKey(code, flags, action) {
    const lease = await nativeLease("key_event", { code, flags, down: true });
    try {
      await action();
      // The acknowledgement carries the yield_ms the helper waited for a
      // hardware-input gap before posting the press.
      return lease.receipt;
    } finally {
      await withSignal(null, () => lease.release());
    }
  }

  function parseChord(text) {
    const raw = String(text);
    const tokens = raw === "+" ? ["+"] : raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
    const parts = tokens.map((s) => {
      const key = s.trim().toLowerCase();
      const normalized = key.length > 1 ? key.replace(/[\s_-]/g, "") : key;
      return KEY_ALIASES[normalized] ?? normalized;
    }).filter(Boolean);
    if (!parts.length) throw new ExecError("empty key text");
    let flags = 0;
    let key = null;
    for (const p of parts) {
      if (MODIFIERS[p] != null) flags |= MODIFIERS[p];
      else if (KEY_CODES[p] != null || SHIFTED[p] != null) {
        if (key) throw new ExecError(`multiple non-modifier keys in "${text}"`);
        if (SHIFTED[p] != null) { flags |= MODIFIERS.shift; key = SHIFTED[p]; } else key = p;
      }
      else throw new ExecError(`unknown key "${p}" (supported: ${Object.keys(KEY_CODES).join(", ")}, ${Object.keys(SHIFTED).join(" ")} + modifiers cmd/ctrl/alt/shift/fn)`);
    }
    if (key == null) throw new ExecError(`no non-modifier key in "${text}"`);
    return { flags, code: KEY_CODES[key], key };
  }

  // ---------- displays ----------
  async function displayInfo() { return native("displays"); }

  // ---------- screenshots ----------
  async function screenshot({ display, region, app_ref, window_id, path: outPath, max_dimension } = {}) {
    await refuseLocked();
    if (max_dimension !== undefined && (!Number.isInteger(max_dimension) || max_dimension < 256 || max_dimension > 8192)) {
      throw new ExecError("max_dimension must be an integer between 256 and 8192");
    }
    // Once an app is selected, ordinary observations follow it behind the
    // user's work. An explicit display/region remains a deliberate desktop capture.
    if (app_ref === undefined && display === undefined && region === undefined) app_ref = state.inputApp ?? undefined;
    const dir = recordingsDir();
    fs.mkdirSync(dir, { recursive: true });
    // JPEG, not PNG. A screen is photographic content — gradients, wallpaper,
    // antialiased text — and lossless compression of it is enormous: the same
    // 5760x3240 frame is 21.8MB as PNG and 2.1MB as JPEG, at full resolution
    // and with terminal text still crisp. PNG stays available by asking for a
    // `.png` path, which is what a pixel-exact comparison wants.
    const file = recordingsOutputPath(outPath) ?? path.join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.jpg`);
    const args = ["-x", "-t", /\.png$/i.test(file) ? "png" : "jpg"];
    const disp = display ?? state.activeDisplay;
    // An explicit app reference resolves first and alone: nothing may run
    // before it and redirect the capture to another target.
    const window = app_ref !== undefined ? await native("window_info", { app_ref, window_id, allow_off_space: true }) : null;
    if (window && region) throw new ExecError("choose app_ref or region, not both");
    // On the display path, resolve displays before capturing so an unknown
    // index is a clean error instead of a raster silently labelled with another
    // display's geometry — list_displays reports `index` and `id` separately,
    // and a caller passing the id would otherwise get points and scale that
    // mis-target every later coordinate. A window capture ignores `display`.
    let displays = null;
    if (!window) {
      displays = await displayInfo();
      if (disp != null && disp !== "all" && !displays.some((x) => x.index === disp)) {
        throw new ExecError(`no display ${disp}; have [${displays.map((x) => x.index).join(", ")}] — screenshot takes the display index from list_displays, not its id`);
      }
    }
    // A region pins the crop itself in global screen points — x and y may be
    // negative where a display sits left of or above the main one — so it is
    // never combined with -D: together they would reinterpret the same
    // capture against one display instead of the arranged desktop.
    if (region) {
      if (region.length !== 4 || !region.every((n) => Number.isFinite(n)) || region[2] < 1 || region[3] < 1) {
        throw new ExecError("region must be [x, y, w, h] in global screen points (x and y may be negative) and a positive size");
      }
      args.push("-R", region.join(","));
    }
    else if (disp && disp !== "all" && !window) args.push("-D", String(disp));
    args.push(file);
    let capture = null;
    if (window) capture = await captureWindowFile(window.window_id, file);
    else {
      const r = await runL("screencapture", args, { timeoutMs: 20_000 });
      if (r.code !== 0) throw new ExecError(`screencapture exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`, r);
    }
    await fitRasterToBudget(file);
    await fitRasterToDimension(file, max_dimension);
    const stat = fs.statSync(file);
    displays ??= await displayInfo();
    const holds = (x) => x.points && region[0] + region[2] / 2 >= x.points.x && region[0] + region[2] / 2 < x.points.x + x.points.w
      && region[1] + region[3] / 2 >= x.points.y && region[1] + region[3] / 2 < x.points.y + x.points.h;
    const d = (region && displays.find(holds)) ?? displays.find((x) => x.index === (disp === "all" ? 1 : disp)) ?? displays[0];
    const scale = d?.scale ?? 1;
    const raster = {
      file,
      ...(window ? { app_ref, window_index: window_id ?? 0, observed_window: { id: window.window_id, pid: window.pid ?? state.inputApp?.pid, frame: window.points } } : {}),
      ...(capture ? { capture_route: capture.route } : {}),
      ...(window?.off_space ? { off_space: true, note: "This window is on another Space; it was captured without switching Spaces. Coordinates on it are refused (window_off_space)." } : {}),
      bytes: stat.size,
      display: region ? d?.index ?? disp ?? 1 : disp ?? 1,
      // Region and window rasters describe that rect, not the whole display.
      // The PNG header is the pixel ground truth; scale is derived from
      // pixels/points below so Retina and mixed-DPI stay exact.
      points: window?.points ?? (region ? { x: region[0], y: region[1], w: region[2], h: region[3] } : d?.points ?? null),
      pixels: imagePixels(file),
      scale: d?.scale ?? 1,
      capturedAt: new Date().toISOString(),
    };
    if (raster.points?.w) raster.scale = raster.pixels.w / raster.points.w;
    // A capture whose geometry is unknown must not re-anchor coordinate
    // targets at a guessed origin: the previous raster stays the frame zoom
    // crops, and the receipt says so instead of staying silent.
    if (raster.points) state.lastRaster = raster;
    else raster.note = [raster.note, "display geometry unknown; coordinates not re-anchored"].filter(Boolean).join(" ");
    return { ...raster, path: file };
  }

  // Always crops the last raster this backend captured; a caller-named
  // source file is not accepted.
  async function zoom({ region, path: outPath }) {
    // Validate the caller's output path before anything else runs.
    const explicitOut = recordingsOutputPath(outPath);
    if (!state.lastRaster) throw new ExecError("no screenshot taken yet on this computer — call screenshot first");
    const [x, y, w, h] = region;
    if (![x, y, w, h].every((n) => Number.isInteger(n) && n >= 0) || !w || !h || x + w > state.lastRaster.pixels.w || y + h > state.lastRaster.pixels.h) throw new ExecError("region must be [x, y, w, h] in last-raster pixels");
    const src = state.lastRaster.file;
    const dir = recordingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const out = explicitOut ?? path.join(dir, `zoom-${crypto.randomBytes(4).toString("hex")}.png`);
    await runOk("sips", ["-s", "format", "png", "-c", String(Math.round(h)), String(Math.round(w)), "--cropOffset", String(Math.round(y)), String(Math.round(x)), src, "--out", out], { timeoutMs: 15_000 });
    const parent = state.lastRaster;
    state.lastRaster = { ...parent, file: out, bytes: fs.statSync(out).size, source: src, region,
      points: { x: (parent.points?.x ?? 0) + x / parent.scale, y: (parent.points?.y ?? 0) + y / parent.scale, w: w / parent.scale, h: h / parent.scale },
      pixels: { w, h }, scale: parent.scale, capturedAt: new Date().toISOString() };
    return state.lastRaster;
  }

  // ---------- recording ----------
  const rec = new Map(); // Includes starting children so session close owns them too.

  function requestRecordingStop(r) {
    if (r.child.exitCode == null && r.child.signalCode == null) {
      r.child.stdin.end();
      r.child.kill("SIGINT");
    }
  }

  async function waitForRecordingStop(r, timeoutMs) {
    let timer;
    try {
      return await Promise.race([r.completion, new Promise(resolve => {
        timer = setTimeout(async () => {
          r.child.kill("SIGKILL");
          let reapTimer;
          const terminated = await Promise.race([r.completion.then(() => true), new Promise(done => { reapTimer = setTimeout(() => done(false), 500); })]);
          clearTimeout(reapTimer);
          resolve({ code: -1, terminated, error: terminated ? "screen recorder finalization timed out; partial file retained" : "screen recorder could not be terminated; recording ownership retained for retry" });
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  async function recordingStart({ display, durationSec, region, app_ref, window_id } = {}) {
    const dir = recordingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(4).toString("hex");
    const file = path.join(dir, `rec-${id}.mov`);
    const displays = await displayInfo();
    // app_ref scopes the recording to the app's window rect: resolved once at
    // start through the same window_info the AX path uses, so a background
    // window records behind the user's work. The rect is fixed at start —
    // it does not track later moves or resizes.
    let window = null;
    if (app_ref !== undefined || window_id != null) {
      window = await native("window_info", { app_ref: app_ref === undefined ? state.inputApp ?? undefined : app_ref, window_id });
      if (!window?.points || !(window.points.w > 0) || !(window.points.h > 0)) throw new ExecError("the selected application has no capturable window — call list_windows");
      if (region) throw new ExecError("choose app_ref or region, not both");
      region = [window.points.x, window.points.y, window.points.w, window.points.h];
    }
    let disp = display ?? state.activeDisplay;
    if (window && display == null) {
      const cx = region[0] + region[2] / 2, cy = region[1] + region[3] / 2;
      const host = displays.find(d => d.points && cx >= d.points.x && cx < d.points.x + d.points.w && cy >= d.points.y && cy < d.points.y + d.points.h);
      if (host) disp = host.index;
    }
    const selected = displays.find(d => d.index === disp);
    if (!selected) throw new ExecError("choose one available display for recording");
    if (durationSec != null && (!Number.isFinite(durationSec) || durationSec <= 0)) throw new ExecError("durationSec must be positive");
    const capabilities = await native("input_capabilities");
    if (capabilities?.record_owner_pipe !== 1) throw new ExecError("native screen recorder cannot own its client lifetime; update Computer Use before recording");
    const helper = await nativeHelper();
    throwIfAborted();
    const child = spawn(helper, [JSON.stringify({ tool: "record", args: { file, displayID: selected.id, region, durationSec, owner_pipe: true } })], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    const startedAt = new Date().toISOString();
    let stderr = "", output = "", ready = false;
    const completion = new Promise(resolve => {
      child.once("error", error => resolve({ code: -1, error: error.message }));
      child.once("close", code => resolve({ code, error: stderr.trim() }));
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    const recording = { child, completion, pid: child.pid, file, startedAt, mode: "ScreenCaptureKit", display: disp };
    rec.set(id, recording);
    const signal = currentSignal();
    let timer, abort;
    try {
      await new Promise((resolve, reject) => {
        abort = () => { requestRecordingStop(recording); reject(Object.assign(new ExecError("computer request cancelled"), { code: "cancelled" })); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => reject(new ExecError("screen recorder startup timed out")), 20_000);
        child.stdout.on("data", chunk => {
          output += chunk;
          let i;
          while ((i = output.indexOf("\n")) >= 0) {
            const line = output.slice(0, i); output = output.slice(i + 1);
            try { if (JSON.parse(line).ready) { ready = true; resolve(); } } catch {}
          }
        });
        completion.then(result => { if (!ready) reject(new ExecError(result.error || "screen recorder exited before capture started")); });
      });
      throwIfAborted();
      return { id, pid: child.pid, file, display: disp, durationSec: durationSec ?? null, region: region ?? null, fps: 30, mode: "ScreenCaptureKit", startedAt,
        ...(window ? { window: { id: window.window_id ?? null, name: window.name ?? null }, note: "Recording the window's rect as it was at start; it does not track moves or resizes." } : {}) };
    } catch (error) {
      requestRecordingStop(recording);
      const result = await waitForRecordingStop(recording, 2_000);
      if (result.terminated !== false) rec.delete(id);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function recordingStop({ id }) {
    const r = rec.get(id);
    if (!r) throw new ExecError(`unknown or already-finished recording "${id}"`);
    requestRecordingStop(r);
    const result = await waitForRecordingStop(r, 20_000);
    if (result.code !== 0) throw new ExecError(result.error || "screen recorder failed; partial file retained");
    const size = fs.existsSync(r.file) ? fs.statSync(r.file).size : 0;
    if (!size) throw new ExecError("screen recorder produced no video");
    rec.delete(id);
    return { id, file: r.file, mp4: null, bytes: size, mode: r.mode, startedAt: r.startedAt, stoppedAt: new Date().toISOString() };
  }

  async function closeSession() {
    await retirePreview(true).catch(() => {});
    if (state.agentCursor && state.pointer) {
      try { await native("agent_cursor", { hide: true }); } catch {}
    }
    await browser.close().catch(() => {});
    const owned = [...rec.entries()];
    for (const [, recording] of owned) requestRecordingStop(recording);
    const results = await Promise.all(owned.map(async ([id, recording]) => {
      const result = await waitForRecordingStop(recording, 2_000);
      if (result.terminated !== false) rec.delete(id);
      return result;
    }));
    const failed = results.find(result => result.code !== 0);
    if (failed) throw new ExecError(failed.error || "screen recorder failed; partial file retained");
  }

  async function recordingStatus({ id }) {
    const r = rec.get(id);
    if (!r) return { id, running: false };
    const alive = r.child.exitCode == null && r.child.signalCode == null;
    return { id, running: alive, pid: r.pid, file: r.file, bytes: fs.existsSync(r.file) ? fs.statSync(r.file).size : 0, startedAt: r.startedAt };
  }

  async function recordingList() {
    const dir = recordingsDir();
    const out = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isFile() && /\.(mov|mp4|png|jpe?g)$/i.test(f)) out.push({ file: full, bytes: st.size, modifiedAt: st.mtime.toISOString() });
    }
    out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return { dir, recordings: out.slice(0, 50), running: [...rec.keys()] };
  }

  // ---------- apps / windows ----------
  async function listApps(args = {}) {
    if (args?.installed === true) {
      const r = await native("installed_apps", {});
      const apps = Array.isArray(r?.apps) ? r.apps : [];
      return {
        apps,
        total: apps.length,
        installed: true,
        note: "Installed catalog from /Applications, /System/Applications and ~/Applications; running flags reflect this moment. This scan takes a moment.",
      };
    }
    const r = await native("list_apps");
    const apps = Array.isArray(r?.apps) ? r.apps : [];
    const shown = selectApps(apps, args?.all === true);
    return {
      apps: shown,
      total: apps.length,
      filtered: args?.all === true ? "all" : "regular",
      ...(shown.length !== apps.length ? { note: "Regular (user-facing) apps only — pass all:true to include menu-bar helpers and background processes." } : {}),
    };
  }

  async function listWindows({ app_ref } = {}) { return native("list_windows", { app_ref: app_ref === undefined ? state.inputApp ?? undefined : app_ref }); }

  async function openApplication({ name, bundle_id: bid, pid, url: urlArg, activate = false } = {}) {
    if (!name && !bid && !pid) throw new ExecError("open_application needs name, bundle_id or pid");
    // Failed selection must not leave an earlier app armed for foreground
    // input, nor a buffered drag aimed at the previous binding.
    state.foregroundInput = false;
    state.inputApp = null;
    state.heldDrag = null;
    // pid is the most specific identity and the only one that separates two
    // processes of the same bundle (e.g. a second Chrome on its own profile),
    // so it wins when given.
    const find = {};
    if (pid) find.pid = pid; else if (bid) find.bundle_id = bid; else find.name = String(name).replace(/\.app$/, "");
    let p;
    let launched = false;
    let link = null, armed = null, firstWindow;
    // Binding an already-running app must not ask LaunchServices to reopen
    // it: reopen can raise windows even with open -g on some applications.
    let running;
    try { running = await native("app_info", { app_ref: find, activate: urlArg ? false : activate }); }
    catch (error) {
      if (!error.message.includes("application not found")) throw error;
    }
    if (!urlArg) p = running;
    if (!p?.found) {
      if (!name && !bid) throw Object.assign(new ExecError(`no running application with pid ${pid}; call list_apps for the current processes`), { code: "app_not_found" });
      const args = [];
      if (urlArg) args.push(urlArg);
      if (bid) args.unshift("-b", bid); else args.unshift("-a", name);
      if (!activate) args.unshift("-g");
      link = await agent();
      if (activate) await link?.request("intent");
      else armed = await link?.request("arm", { target_pid: 0, awake_s: awakeSeconds });
      const r = await runL("open", args, { timeoutMs: 25_000 });
      if (r.code !== 0 && armed?.ok) link.request("settle", { action: armed.action, report_ms: 0 }).catch(() => {});
      if (r.code !== 0) {
        const stderr = (r.stderr ?? "").trim();
        // A name or bundle id that resolves nowhere is a stable refusal code,
        // not a generic opener failure — agents branch on the code.
        const code = /Unable to find application|failed while trying to determine the application/i.test(stderr)
          ? "app_not_found" : undefined;
        throw Object.assign(new ExecError(`open failed: ${stderr.slice(0, 200)}`), { code });
      }
      launched = !running?.found;
      if (link) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          try { p = await native("app_info", { app_ref: find, activate: false }); }
          catch (error) { if (!error.message.includes("application not found")) throw error; }
          if (p?.found || Date.now() >= deadline) break;
          await wait(150);
        }
        if (armed?.ok) {
          const settled = await link.request("settle", { action: armed.action, report_ms: p?.found ? settleMs : 0, ...(p?.found ? { target_pid: p.pid } : {}) }, settleMs + 2000);
          callChanges.getStore()?.push(windowChanges(armed, settled));
        }
        if (!p?.found) throw Object.assign(new ExecError(`${find.name ?? find.bundle_id} did not start within 10 s of launching`), { code: "app_not_found" });
        const shown = await link.request("wait_window", { pid: p.pid, timeout_ms: Math.max(500, deadline - Date.now()) }, 12_000);
        firstWindow = shown?.window ? { window_id: shown.window.window_id, title: shown.window.title || null } : null;
        p = await native("app_info", { app_ref: find, activate });
      } else {
        await new Promise((res) => setTimeout(res, 600));
        p = await native("app_info", { app_ref: find, activate });
      }
    }
    if (activate && p?.frontmost === false) throw Object.assign(new ExecError("The selected application did not become frontmost; no input mode was enabled. Continue with background control or wait for the user."), { code: "activation_not_confirmed" });
    if (p?.bundle_id === "net.codewhale.computer-use") throw Object.assign(new ExecError("The Computer Use setup and safety controls belong to the user and cannot be operated by this plugin."), { code: "protected_application" });
    assertNotPrompt(p);
    // A bare executable has no bundle id; carrying an empty one would make the
    // identity unmatchable.
    state.inputApp = { pid: p.pid, ...(p.bundle_id ? { bundle_id: p.bundle_id } : {}), ...(p.name ? { name: p.name } : {}) };
    state.foregroundInput = !!activate;
    if (state.previewEnabled) {
      previewActiveAt = Date.now();
      updatePreview(true).catch(() => {});
    }
    return { launched, ...(firstWindow !== undefined ? { first_window: firstWindow } : {}), activate, keyboard_delivery: activate ? "foreground-guarded" : "process", input_scope: activate ? "shared-desktop" : "application", shared_pointer: false, pointer_route: "pid-routed", isolated_desktop: false, url: urlArg ?? null, resolved: p?.found ? { name: p.name, pid: p.pid, bundle_id: p.bundle_id, frontmost: p.frontmost } : null,
      ...(Number.isFinite(p?.yield_ms) && p.yield_ms > 0 ? { yield_ms: p.yield_ms } : {}) };
  }

  async function invokeMenu(menuPath) {
    if (!state.inputApp) throw new ExecError("open_application first — invoke_menu acts on the bound application");
    if (!Array.isArray(menuPath) || menuPath.length < 1 || menuPath.some(s => typeof s !== "string" || !s.trim())) throw new ExecError('invoke_menu needs a non-empty path of exact menu titles, e.g. ["File","New"]');
    if ((await native("input_capabilities"))?.menu_path !== 1) throw Object.assign(new ExecError("Update the helper and plugin together for nested menu commands."), { code: "app_upgrade_required" });
    return native("invoke_menu", { app_ref: state.inputApp, path: menuPath.map(s => s.trim()) });
  }

  // ---------- clipboard / cursor / waits ----------
  async function readClipboard() {
    const r = await runL("pbpaste", [], { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 });
    return { text: r.stdout, encoding: "utf8" };
  }
  async function writeClipboard({ text }) {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(String(text ?? ""));
    await new Promise((res, rej) => { child.on("close", res); child.on("error", rej); });
    return { written: String(text ?? "").length };
  }
  async function cursorPosition() { return native("cursor_position"); }

  // ---------- app scripting ----------
  // The programmatic interface into apps that ship a scripting dictionary:
  // osascript runs AppleScript (default) or JXA. It never moves the pointer,
  // needs no Accessibility grant, and returns values instead of "sent"
  // receipts — which is why it ranks above clicking wherever a dictionary
  // exists. The script travels as one argv entry; no shell ever parses it.
  async function appScript({ script, language = "applescript", timeout } = {}) {
    if (typeof script !== "string" || !script.trim()) {
      throw Object.assign(new ExecError("app_script needs a non-empty script string"), { code: "bad_args" });
    }
    const lang = language === "javascript" ? ["-l", "JavaScript"] : language === "applescript" ? [] : null;
    if (!lang) throw Object.assign(new ExecError('app_script language must be "applescript" or "javascript"'), { code: "bad_args" });
    const timeoutMs = Math.min(Math.max(Number(timeout) > 0 ? Number(timeout) : 30, 1), 120) * 1000;
    const r = await runL("osascript", [...lang, "-e", script], { timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    if (r.aborted) throw Object.assign(new ExecError("computer request cancelled", r), { code: "cancelled" });
    if (r.timedOut) throw Object.assign(new ExecError(`app_script timed out after ${Math.round(timeoutMs / 1000)}s — the script or a consent dialog was still open`, r), { code: "script_timeout" });
    if (r.code !== 0) {
      const stderr = (r.stderr || r.stdout || "").trim();
      if (/-1743|not authorized to send apple events|not permitted/i.test(stderr)) {
        throw Object.assign(new ExecError(`${stderr} — Automation consent was refused or is missing; allow the responsible app to control the target in System Settings → Privacy & Security → Automation`, r), { code: "automation_denied" });
      }
      if (/\(-?128\)|user canceled/i.test(stderr)) {
        throw Object.assign(new ExecError(stderr || "the script was cancelled by the user", r), { code: "script_cancelled" });
      }
      throw Object.assign(new ExecError(stderr || `osascript exited ${r.code}`, r), { code: "script_error" });
    }
    return { language, result: r.stdout.trim(), stderr: r.stderr.trim() || null };
  }

  // ---------- probe ----------
  async function probe() {
    const caps = { screenshot: true, recording: true, accessibility_tree: true, clipboard: true, displays: true, app_script: true };
    const perms = {};
    try {
      const ax = await native("permissions");
      perms.accessibility = ax.trusted ? "granted" : "denied";
    } catch { perms.accessibility = "denied_or_unavailable"; }
    caps.accessibility_tree = perms.accessibility === "granted";
    caps.raw_input = caps.accessibility_tree;
    try {
      const t = os.tmpdir() + `/cu-probe-${crypto.randomBytes(3).toString("hex")}.png`;
      const r = await runL("screencapture", ["-x", "-R0,0,2,2", "-t", "png", t], { timeoutMs: 8_000 });
      perms.screen_capture = r.code === 0 ? "ok" : "failed";
      try { fs.rmSync(t, { force: true }); } catch {}
    } catch { perms.screen_capture = "failed"; }
    caps.screenshot = perms.screen_capture === "ok";
    caps.recording = caps.screenshot;
    const bundles = perms.screen_capture === "ok" ? [] : process.execPath.split(path.sep).filter((part) => part.endsWith(".app"));
    const screenRecordingApp = bundles[0]?.slice(0, -4);
    const setup = screenRecordingApp ? { screen_recording_app: screenRecordingApp, setup_hint: `Ask the person to turn on ${screenRecordingApp} in System Settings > Privacy & Security > Screen & System Audio Recording${bundles.length > 1 ? `. macOS grants screen capture to ${screenRecordingApp} because Computer Use runs inside it` : ""}, then quit and reopen it.` } : {};
    return { platform: "darwin", capabilities: caps, permissions: perms, ...setup, note: "macOS does not expose Screen-Recording TCC state to CLI; a black/empty screenshot means Screen Recording permission is missing. Background mode (open_application activate:false) uses accessibility actions and process-bound keyboard events; pointer gestures and modified keys are posted to the app's process without taking the front (strict approval mode refuses them); a self-activating app is put back behind the person's app and a background menu's key-focus grab is released. Foreground control (activate:true) uses the shared desktop and requires exclusive use. Neither mode is an isolated desktop. App-specific behavior still requires verification." };
  }

  const api = {
    platform: "darwin",
    probe,
    list_displays: displayInfo,
    async switch_display({ index }) {
      const ds = await displayInfo();
      if (!ds.some((d) => d.index === index)) throw new ExecError(`no display ${index}; have [${ds.map((d) => d.index).join(", ")}]`);
      state.activeDisplay = index;
      return { activeDisplay: index };
    },
    list_apps: listApps,
    set_window_frame: async ({ app_ref, window_id, frame } = {}) => {
      if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y) || !Number.isFinite(frame.w) || !Number.isFinite(frame.h) || frame.w <= 0 || frame.h <= 0) {
        throw Object.assign(new ExecError("set_window_frame needs frame {x,y,w,h} with positive w/h"), { code: "bad_args" });
      }
      if (!Number.isSafeInteger(window_id) || window_id < 0) {
        throw Object.assign(new ExecError("set_window_frame needs window_id (a non-negative window index from list_windows)"), { code: "bad_args" });
      }
      const r = await native("set_window_frame", { app_ref: app_ref === undefined ? state.inputApp ?? undefined : app_ref, window_id, frame });
      return { ...r, verified: r?.verified === true, note: r?.note ?? "the after frame is the app's own readback; cross-check with list_windows before relying on it" };
    },
    list_windows: listWindows,
    focused_control: async () => {
      if (!state.inputApp) return null;
      if (!state.focusedControl) {
        state.focusedControl = (await native("input_capabilities"))?.focused_control === 1;
        if (!state.focusedControl) return null;
      }
      const r = await native("focused_control", {});
      return r?.control ? { ...r.control, app: { ...state.inputApp } } : null;
    },
    open_application: openApplication,
    get_app_state: async ({ app_ref, detail, depth, window_id, query, role, include_ocr = false, ocr_region } = {}) => {
      const t0 = Date.now();
      const t = await native("get_app_state", { app_ref: app_ref === undefined ? state.inputApp ?? undefined : app_ref, detail, window_id, query: query?.trim() || undefined, role: role || undefined });
      if (process.env.CODEWHALE_CU_DEBUG_OBSERVE) console.error(`observe ${Date.now() - t0}ms elements=${t.elements?.length} truncated=${t.truncated}`);
      if (!t.found) throw new ExecError("application not found — call list_apps for exact names/pids");
      if (include_ocr) {
        // Resolve once through AX, then capture only that exact application's
        // selected window. A changing foreground cannot redirect this image.
        let raster;
        try {
          if (!Number.isSafeInteger(t.pid) || t.pid <= 0) throw new ExecError("The observed application did not provide an exact process identity for OCR");
          if ((await native("input_capabilities"))?.window_ocr !== 1) throw new ExecError("The native helper needs an update for selected-window text recognition");
          // PNG here, against the JPEG default: this raster is fed to text
          // recognition, not to a viewer, and lossless glyph edges are what
          // Vision reads. A single window is small enough that the size the
          // JPEG default exists to solve does not arise.
          const ocrDir = path.join(recordingsDir(), "captures");
          fs.mkdirSync(ocrDir, { recursive: true });
          raster = await screenshot({
            ...(ocr_region
              ? { region: ocr_region }
              : { app_ref: { pid: t.pid, ...(t.bundle_id ? { bundle_id: t.bundle_id } : {}) }, window_id }),
            path: path.join(ocrDir, `ocr-${crypto.randomBytes(4).toString("hex")}.png`),
          });
          const ocr = await native("recognize_text", { file: raster.file });
          if (ocr?.status === "ok" && ocr.pixels?.w === raster.pixels.w && ocr.pixels?.h === raster.pixels.h && Array.isArray(ocr.blocks)) {
            t.ocr = { ...ocr, raster, blocks: ocr.blocks.map(block => ({ ...block, target: {
              type: "coordinate", x: Math.floor(block.bounds.x + block.bounds.w / 2), y: Math.floor(block.bounds.y + block.bounds.h / 2),
            } })) };
          } else {
            t.ocr = { status: "unavailable", engine: "apple_vision", reason: ocr?.reason ?? "The native OCR helper needs an update or returned mismatched image dimensions", blocks: [], raster };
          }
        } catch (error) {
          throwIfAborted();
          if (error.code === "cancelled") throw error;
          t.ocr = { status: "unavailable", engine: "apple_vision", reason: error.message, blocks: [], ...(raster ? { raster } : {}) };
        }
      }
      return t;
    },
    resolve_element: async ({ app_ref, windowIndex, path: pathArr, native_ref, role, label } = {}) => {
      const r = await native("resolve_element", { app_ref, windowIndex: windowIndex ?? 0, path: pathArr ?? [], native_ref, role, label });
      return { found: !!r?.found, element: r?.element ?? null, reason: r?.reason ?? null };
    },
    preview: async ({ enabled = true } = {}) => {
      if (!enabled) { await retirePreview(true); return { enabled: false }; }
      if (!state.inputApp) throw new ExecError("open_application first to choose the preview app");
      await retirePreview();
      state.previewEnabled = true;
      previewActiveAt = Date.now();
      return updatePreview(true);
    },
    screenshot,
    zoom,
    left_click: async ({ target, strategy = "auto" } = {}) => {
      if (target?.type !== "element" || strategy === "event" || strategy === "app") return pointerClick("left", target?.x, target?.y, 1, strategy, target);
      if (!["auto", "a11y"].includes(strategy)) throw new ExecError(`strategy must be auto, a11y, app or event (got ${JSON.stringify(strategy)})`);
      try {
        assertBoundElement(target);
        if ((await native("input_capabilities"))?.element_identity !== 1) throw new ExecError("native helper needs an update for element identity validation");
        const semantic = ["AXTextField", "AXTextArea", "AXComboBox", "AXRow", "AXCell", "AXMenuItem"].includes(target.role);
        if (semantic) await requireBackgroundActions();
        const receipt = await native(semantic ? "click_element" : "perform_action", { target, action: "AXPress" });
        if (!receipt?.action_sent) throw new ExecError("element press was not acknowledged");
        return { ...receipt, action: receipt.action ?? "AXPress", strategy: "a11y", pointer_moved: false,
          element: { role: target.role, label: target.label ?? null }, verified: receipt.verified ?? false, verification_required: "observation" };
      } catch (error) {
        // An AX frame can cover other controls. Never turn a refused or
        // ambiguous element press into another element's press or a raw click.
        error.message += ' — no coordinate fallback was sent; take a fresh screenshot or OCR observation and choose an advertised action or a separate computer';
        throw error;
      }
    },
    double_click: ({ target } = {}) => pointerClick("left", target?.x, target?.y, 2, "auto", target),
    triple_click: ({ target } = {}) => pointerClick("left", target?.x, target?.y, 3, "auto", target),
    right_click: async ({ target } = {}) => {
      if (target?.type !== "element") return pointerClick("right", target?.x, target?.y, 1, "auto", target);
      assertBoundElement(target);
      await requireBackgroundActions();
      return native("click_element", { target, context: true });
    },
    middle_click: ({ target } = {}) => pointerClick("middle", target?.x, target?.y, 1, "auto", target),
    // Hover moves only the Codewhale pointer: a mouse-moved record to the
    // window under it. While a button is held the point joins the drag path,
    // and the whole drag is delivered to the window on left_mouse_up.
    mouse_move: async ({ target } = {}) => {
      assertInScreen(target?.x, target?.y);
      if (state.heldDrag) {
        if (state.heldDrag.path.length >= 64) throw new ExecError("a held drag takes at most 64 intermediate points; release it with left_mouse_up");
        state.heldDrag.path.push({ x: target.x, y: target.y });
        state.pointer = { x: target.x, y: target.y };
        return { action_sent: false, deferred: true, strategy: "pid-routed", at: state.pointer, pointer_moved: false,
                 note: "the button is held on the Codewhale pointer; the drag reaches the window on left_mouse_up" };
      }
      const r = await windowPointer([{ type: MOUSE_MOVED, x: target.x, y: target.y, button: 0, clickState: 0 }], {}, pointerBinding(target));
      return { ...r, at: { x: target.x, y: target.y } };
    },
    left_mouse_down: async ({ target } = {}) => {
      assertInScreen(target?.x, target?.y);
      requireFocusControl();
      if (state.heldDrag) throw new ExecError("this session already holds the left pointer button; release it first");
      if ((await native("input_capabilities"))?.window_record !== 1) {
        throw Object.assign(new ExecError("Pointer input needs the window-routed pointer, which this helper cannot resolve; update Computer Use. The user's cursor is never used instead."), { code: "bg_dispatch_unavailable" });
      }
      state.heldDrag = { from: { x: target.x, y: target.y }, path: [], app: state.inputApp, binding: pointerBinding(target) };
      state.pointer = { x: target.x, y: target.y };
      return { action_sent: false, deferred: true, strategy: "pid-routed", at: state.pointer, pointer_moved: false,
               note: "the button is held on the Codewhale pointer; the press reaches the window with the rest of the drag on left_mouse_up" };
    },
    left_mouse_up: async ({ target } = {}) => {
      const held = state.heldDrag;
      if (!held) throw new ExecError("no agent pointer button is held by this session");
      state.heldDrag = null;
      const loc = target ?? state.pointer ?? held.from;
      assertInScreen(loc.x, loc.y);
      if (held.app?.pid !== state.inputApp?.pid) throw new ExecError("the bound application changed while the button was held; nothing was sent");
      const { from } = held;
      const steps = [
        { type: MOUSE_MOVED, x: from.x, y: from.y, button: 0, clickState: 0 },
        { type: MOUSE.left.down, x: from.x, y: from.y, button: 0, clickState: 1, delayMs: 60 },
      ];
      let last = from;
      for (const p of [...held.path, loc]) {
        const n = Math.max(1, Math.min(12, Math.ceil(Math.hypot(p.x - last.x, p.y - last.y) / 20)));
        for (let i = 1; i <= n; i++) steps.push({ type: MOUSE.left.dragged, x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n, button: 0, clickState: 1, delayMs: 30 });
        last = p;
      }
      steps.push({ type: MOUSE.left.up, x: loc.x, y: loc.y, button: 0, clickState: 1, delayMs: 80 });
      const r = await windowPointer(steps, {}, held.binding);
      state.pointer = { x: loc.x, y: loc.y };
      return { ...r, from, to: state.pointer, at: state.pointer };
    },
    left_click_drag: async ({ from_target: from, to } = {}) => {
      assertInScreen(from?.x, from?.y); assertInScreen(to?.x, to?.y);
      const steps = [
        { type: MOUSE_MOVED, x: from.x, y: from.y, button: 0, clickState: 0 },
        { type: MOUSE.left.down, x: from.x, y: from.y, button: 0, clickState: 1, delayMs: 60 },
      ];
      const n = 12;
      for (let i = 1; i <= n; i++) {
        steps.push({ type: MOUSE.left.dragged, x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n, button: 0, clickState: 1, delayMs: 45 });
      }
      steps.push({ type: MOUSE.left.up, x: to.x, y: to.y, button: 0, clickState: 1, delayMs: 80 });
      return { ...(await windowPointer(steps, {}, pointerBinding(from))), from, to };
    },
    scroll: async ({ target, direction = "down", amount = 5 } = {}) => {
      assertInScreen(target?.x, target?.y);
      if (!state.foregroundInput) {
        await requireBackgroundActions();
        if (target.type === "element") {
          assertBoundElement(target);
          return native("scroll_element", { target, direction, amount });
        }
        const receipt = await native("hit_test", { x: target.x, y: target.y, perform: true, direction, amount, ...pointerBinding(target),
          operation: ["left", "right"].includes(direction) ? "scroll-horizontal" : "scroll-vertical" });
        if (receipt?.action_sent) return receipt;
        if ((await native("input_capabilities"))?.window_record !== 1) {
          throw Object.assign(new ExecError(`No background scrollbar at this point (${receipt?.reason ?? "not_found"}); choose an observed scroll area or a separate computer.`), { code: "background_scroll_unavailable" });
        }
      }
      // No AX scrollbar here (overlay scrollers, web pages), or foreground
      // control: wheel records reach the view through the window route.
      const dx = direction === "left" ? amount : direction === "right" ? -amount : 0;
      const dy = direction === "up" ? amount : direction === "down" ? -amount : 0;
      const notches = Math.max(1, Math.min(100, Math.round(amount)));
      const steps = [];
      for (let i = 0; i < notches; i++) steps.push({ scroll: [Math.sign(dx), Math.sign(dy)], x: target.x, y: target.y, delayMs: 15 });
      return { ...(await windowPointer(steps, {}, pointerBinding(target))), direction, amount, verified: false, verification_required: "observation" };
    },
    type: async (args = {}) => {
      if (args.delivery === "events" && !state.foregroundInput && (await native("input_capabilities"))?.window_text_input !== 1) {
        throw Object.assign(new ExecError("Update Computer Use before requesting confirmed window-routed text events."), { code: "app_upgrade_required" });
      }
      return native("type", args);
    },
    key: async ({ text, repeat = 1, target } = {}) => {
      const { flags, code, key } = parseChord(text);
      const n = Math.max(1, Math.min(100, repeat));
      // Background standard-mode and window-targeted keys use the app's key
      // window without activating it; strict mode retains its focus refusal.
      const routed = target != null || (!state.foregroundInput && (flags !== 0 || !isStrict()));
      if (routed) requireFocusControl();
      if (routed && !state.foregroundInput && (await native("input_capabilities"))?.pid_input !== 1) {
        throw Object.assign(new ExecError("Update the Codewhale Computer Use app before sending a modified key to a background app."), { code: "app_upgrade_required" });
      }
      if (target != null) {
        assertBoundElement(target);
        if ((await native("input_capabilities"))?.targeted_keys !== 1) throw Object.assign(new ExecError("Update Computer Use before sending a key to an explicit element"), { code: "app_upgrade_required" });
      }
      let yieldMs = 0;
      let receipt = {};
      for (let i = 0; i < n; i++) {
        const press = routed ? await native("bg_key", { code, flags, ...(target != null ? { target } : {}) }) : await withPressedKey(code, flags, () => {});
        receipt = press ?? {};
        if (Number.isFinite(press?.yield_ms)) yieldMs = Math.max(yieldMs, press.yield_ms);
        if (i < n - 1) await wait(30);
      }
      return { ...receipt, action_sent: true, key, code, keyboard_delivery: routed ? "process" : state.foregroundInput ? "foreground-guarded" : "process", repeat: n,
        ...(yieldMs > 0 ? { yield_ms: yieldMs } : {}) };
    },
    hold_key: async ({ text, duration } = {}) => {
      const { flags, code, key } = parseChord(text);
      if (flags !== 0) requireForegroundInput();
      const d = Math.max(0.05, Math.min(30, Number(duration) || 1));
      const press = await withPressedKey(code, flags, () => wait(d * 1000));
      return { action_sent: true, key, keyboard_delivery: state.foregroundInput ? "foreground-guarded" : "process", heldSec: d,
        ...(Number.isFinite(press?.yield_ms) && press.yield_ms > 0 ? { yield_ms: press.yield_ms } : {}) };
    },
    set_value: async (args = {}) => {
      if (args.target?.type !== "element") throw new ExecError("set_value needs an element target — {type:'element',index} from get_app_state");
      assertBoundElement(args.target);
      try {
        return await native("set_value", args);
      } catch (error) {
        if (!/web area/i.test(error.message)) throw error;
        requireForegroundInput();
        throw Object.assign(new ExecError("Update Computer Use for literal web text replacement; the installed helper cannot preserve and verify the requested text"), { code: "app_upgrade_required" });
      }
    },
    focus: (args = {}) => native("focus_element", args),
    get_value: (args = {}) => native("get_value", args),
    select_text: async (args = {}) => {
      if (args.target?.type !== "element") throw new ExecError("select_text needs an element target — {type:'element',index} from get_app_state");
      return native("select_text", args);
    },
    perform_action: async (args = {}) => {
      if (args.target?.type !== "element") throw new ExecError("perform_action needs an element target — {type:'element',index} from get_app_state");
      return native("perform_action", args);
    },
    invoke_menu: async ({ path: menuPath } = {}) => invokeMenu(menuPath),
    app_script: appScript,
    read_clipboard: readClipboard,
    write_clipboard: writeClipboard,
    cursor_position: cursorPosition,
    recordingStart,
    recordingStop,
    recordingStatus,
    recordingList,
    closeSession,
    list_sessions: async () => ({
      via: "direct",
      count: 1,
      sessions: [{
        target: state.inputApp ? { pid: state.inputApp.pid, ...(state.inputApp.bundle_id ? { bundle_id: state.inputApp.bundle_id } : {}), ...(state.inputApp.name ? { name: state.inputApp.name } : {}) } : null,
        mode: state.foregroundInput ? "foreground" : "background",
        action: null,
        ageSec: 0,
        inputHeld: !!state.heldDrag,
      }],
    }),
    kill_app: async (args = {}) => {
      const { name, bundle_id, pid, force } = args;
      if (!name && !bundle_id && pid == null) throw Object.assign(new ExecError("kill_app needs name, bundle_id or pid"), { code: "bad_args" });
      return native("kill_app", { name, bundle_id, pid, force: force === true });
    },
    browser_start: browser.start,
    browser_status: browser.status,
    browser_navigate: browser.navigate,
    browser_click: browser.click,
    browser_type: browser.type,
    browser_screenshot: browser.screenshot,
    browser_stop: browser.stop,
    // A held drag is buffered, not held on any real button: nothing to release.
    releaseInput: async () => { state.heldDrag = null; },
  };
  for (const [name, fn] of Object.entries(api)) {
    if (typeof fn !== "function") continue;
    api[name] = async (...callArgs) => {
      if (callChanges.getStore()) return fn(...callArgs);
      const changes = [];
      const result = await callChanges.run(changes, () => fn(...callArgs));
      if (changes.length && result && typeof result === "object" && !Array.isArray(result) && !("window_changes" in result)) {
        result.window_changes = mergeWindowChanges(changes);
        if (result.menu_holds_key_focus && result.window_changes.key_focus_kept && result.window_changes.key_focus_released) result.menu_holds_key_focus = false;
      }
      return result;
    };
  }
  return api;
}

export default { create };
