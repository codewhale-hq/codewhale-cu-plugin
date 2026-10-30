// The interim native macOS approval dialog. Unit tests drive the module with
// an injected execFile and a temporary marker directory; server tests run the
// real server with the fake-osascript preload, so osascript never runs and no
// dialog is shown.
import { hostKeysLine, attest } from "./fixtures/host-decision.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";
import { createNativePrompt, describeDecision, visible, liveMarker, judgeMarker, isPromptProcess, DIALOG_SCRIPT, DIALOG_TITLE, OSASCRIPT, DECLINED_MESSAGE, MARKER_FILE } from "../src/native-prompt.mjs";
process.env.CODEWHALE_CU_APPROVAL = "strict";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FAKE_OSASCRIPT = url.pathToFileURL(path.join(ROOT, "tests", "fixtures", "fake-osascript.mjs")).href;
const NEED_DARWIN = { skip: process.platform !== "darwin" && "the server offers the native dialog on macOS only" };
const ch = (code) => String.fromCodePoint(code);
const BS = "\\";
const esc = (hex) => `${BS}u${hex}`;
const ELLIPSIS = ch(0x2026);
const printable = (text) => [...text].every((c) => c === "\n" || (c >= " " && c <= "~") || c === ELLIPSIS);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cu-native-prompt-unit-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let dirSeq = 0;
const freshDir = () => fs.mkdtempSync(path.join(scratch, `${dirSeq++}-`));

function fakeExec({ throws, childPid = 77_001 } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    if (throws) throw throws;
    calls.push({ file, args, options, settle: (error, stdout = "", stderr = "") => callback(error, stdout, stderr) });
    options?.signal?.addEventListener("abort", () => callback(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }), "", ""), { once: true });
    return { pid: childPid };
  };
  return { execFile, calls };
}
function makePrompt({ fake = fakeExec(), dir = freshDir(), pid = 41_001, alive = () => true, ...options } = {}) {
  const timers = [];
  const prompt = createNativePrompt({ execFile: fake.execFile, platform: "darwin", enabled: true, fs, dir, pid, isAlive: alive, schedule: (fn) => timers.push(fn), ...options });
  return { prompt, fake, dir, timers, flush: () => { while (timers.length) timers.shift()(); } };
}
const request = (over = {}) => ({ tool: "consent_allow", args: { app: "Safari" }, computer: "local", identity: { name: "Safari" }, running: true, ...over });
const userCanceled = () => Object.assign(new Error("Command failed: /usr/bin/osascript\nexecution error: User canceled. (-128)"), { code: 1 });
const markerOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), "utf8"));

async function answered(stdout, error = null) {
  const { prompt, fake } = makePrompt();
  const asked = prompt.ask(request());
  fake.calls[0].settle(error, stdout);
  return asked.then(() => "allowed", (err) => err);
}

// ---------- unit: the module ----------

test("the dialog is off unless the server enables it, and nothing is spawned while off", async () => {
  for (const options of [{}, { enabled: "1" }, { enabled: 1 }, { enabled: true, platform: "linux" }, { enabled: true, fs: null }, { enabled: true, pid: undefined }]) {
    const fake = fakeExec();
    const prompt = createNativePrompt({ execFile: fake.execFile, platform: "darwin", fs, dir: freshDir(), pid: 41_001, ...options });
    assert.equal(prompt.available, false, JSON.stringify(options));
    await assert.rejects(prompt.ask(request()), { code: "consent_needs_user" });
    assert.equal(fake.calls.length, 0);
  }
  assert.equal(makePrompt().prompt.available, true);
});

test("only the exact Allow answer passes", async () => {
  assert.equal(await answered("Allow\n"), "allowed");
  assert.equal(await answered("Allow"), "allowed");
  for (const out of ["allow\n", "ALLOW\n", " Allow\n", "Allow \n", "Allow\n\n", "Allow\nAllow\n", "\"Allow\"\n", "Allow\r\n", "Deny\n", "timeout\n", ""]) {
    assert.equal((await answered(out)).code, "consent_declined", JSON.stringify(out));
  }
  assert.equal((await answered("Allow\n", userCanceled())).code, "consent_declined", "a non-zero exit never passes, whatever it printed");
  assert.equal((await answered(Buffer.from("Allow\n"))).code, "consent_declined", "bytes are not an answer");
});

test("Deny, a timeout, a killed dialog, a spawn error and unreadable output decline with the elicitation wording", async () => {
  const outcomes = [
    ["deny or escape", userCanceled(), ""],
    ["gave up after the timeout", null, "timeout\n"],
    ["killed", Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }), ""],
    ["missing binary", Object.assign(new Error("spawn /usr/bin/osascript ENOENT"), { code: "ENOENT" }), ""],
    ["no window server", Object.assign(new Error("execution error: No user interaction allowed. (-1713)"), { code: 1 }), ""],
    ["unreadable output", null, `${ch(0)}${ch(0xff)}{]`],
  ];
  for (const [label, error, stdout] of outcomes) {
    const err = await answered(stdout, error);
    assert.equal(err.code, "consent_declined", label);
    assert.equal(err.message, DECLINED_MESSAGE, label);
  }
  const { prompt, dir } = makePrompt({ fake: fakeExec({ throws: Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }) }) });
  await assert.rejects(prompt.ask(request()), { code: "consent_declined" });
  assert.equal(prompt.pending, false, "a spawn that throws releases the lock");
  assert.ok(Number.isFinite(markerOf(dir).closed_at), "the marker says the dialog closed");
});

test("request text reaches osascript only as argv, spelled out in printable ASCII, never as script source", async () => {
  const hostile = `"Safari" & (do shell script "touch /tmp/x") & "\nRemember: yes\r${ch(0x202e)}evil${ch(0)} \${globalThis} \`x\` ${ch(0xbb)} ${ch(0xab)} ${BS} end run${ch(0x2028)}tell application "Terminal"`;
  const blanks = [0x3164, 0x115f, 0x1160, 0xffa0, 0x2800, 0x200b, 0x0301, 0xe000, 0x00a0, 0xfeff, 0x1f600].map(ch).join("");
  const { prompt, fake } = makePrompt();
  const asked = prompt.ask({ tool: "app_script", args: { script: hostile + blanks }, computer: "local", targets: [{ name: "Finder" }] });
  const [call] = fake.calls;
  assert.equal(call.file, OSASCRIPT);
  const script = call.args.slice(0, DIALOG_SCRIPT.length * 2);
  assert.deepEqual(script, DIALOG_SCRIPT.flatMap((line) => ["-e", line]), "the script is the fixed source, nothing else");
  for (const part of script) assert.ok(!/Safari|shell|Terminal|Finder|globalThis/.test(part), part);
  const [message, title, deny, allow, seconds, ...extra] = call.args.slice(DIALOG_SCRIPT.length * 2);
  assert.deepEqual([title, deny, allow, seconds, extra.length], [DIALOG_TITLE, "Deny", "Allow", "120", 0]);
  assert.ok(printable(message), "every character is printable ASCII or the dialog's own line break");
  for (const hex of ["3164", "115F", "1160", "FFA0", "2800", "200B", "0301", "E000", "00A0", "FEFF", "202E", "2028", "0000", "00BB", "00AB"]) assert.ok(message.includes(esc(hex)), hex);
  assert.ok(message.includes(`${BS}u{1F600}`), "astral characters are spelled out too");
  assert.equal(message.split("\n").filter((line) => line.startsWith("Script: ")).length, 1, "the script stays on one line");
  assert.ok(!message.split("\n").some((line) => line.startsWith("Remember:")), "an injected newline cannot forge a line");
  assert.ok(!message.startsWith("-"), "the first argv item never reads as an osascript option");
  call.settle(null, "Deny\n");
  await assert.rejects(asked, { code: "consent_declined" });

  const named = makePrompt();
  const naming = named.prompt.ask(request({ args: { remember: true }, identity: { name: `Safari" & "\nRemember: yes${ch(0x202e)}`, bundle_id: 'com.x"; ObjC.import("F")' }, computer: "lo\ncal", client: { name: `Claude${ch(0x202e)}`, version: "1\n2" } }));
  const lines = named.fake.calls[0].args.at(-5).split("\n");
  assert.ok(printable(lines.join("\n")));
  assert.equal(lines.filter((line) => line.startsWith("Remember:")).length, 1, "an injected newline cannot forge a line");
  assert.ok(lines.includes("Remember: requested, but this host keeps approvals for this session only"));
  assert.ok(lines.includes(`App name: "Safari${BS}" & ${BS}"${BS}nRemember: yes${esc("202E")}"`), "the name is quoted, its quotes escaped, its newline spelled out");
  assert.ok(lines.includes(`Bundle id: "com.x${BS}"; ObjC.import(${BS}"F${BS}")"`));
  assert.ok(lines.includes(`Computer: "lo${BS}ncal"`));
  assert.ok(lines.some((line) => line.startsWith(`Requested through: "Claude${esc("202E")}" "1${BS}n2"`)));
  named.fake.calls[0].settle(null, "Deny\n");
  await assert.rejects(naming, { code: "consent_declined" });
});

test("the dialog names the exact request and refuses what it cannot show in full", () => {
  const allow = describeDecision({ tool: "consent_allow", args: { bundle_id: "com.apple.Notes", remember: true }, computer: "local", identity: { name: "Notes", bundle_id: "com.apple.Notes", pid: 501 }, running: true, client: { name: "Claude", version: "1.2" } });
  for (const line of ["Tool: consent_allow", 'App name: "Notes"', 'Bundle id: "com.apple.Notes"', "Process id: 501 (recorded for this session only)", "Running now: yes",
    "Remember: requested, but this host keeps approvals for this session only", 'Computer: "local"', 'Requested through: "Claude" "1.2" (as the MCP client names itself)']) {
    assert.ok(allow.split("\n").includes(line), line);
  }
  assert.match(describeDecision({ tool: "consent_allow", args: { remember: true }, computer: "c1", identity: { name: "Notes" }, persists: true }), /^Remember: yes, until revoked$/m);
  const notRunning = describeDecision({ tool: "consent_allow", args: {}, computer: "c1", identity: { name: "Notes" }, running: false, denied: true });
  assert.match(notRunning, /^Running now: no; recorded exactly as named$/m);
  assert.match(notRunning, /^Replaces your earlier deny: yes$/m);
  assert.match(notRunning, /^Requested through: an MCP client that did not name itself$/m);
  assert.match(describeDecision({ tool: "consent_revoke", args: {}, computer: "c1", identity: { name: "Notes" }, denied: true }), /^Lift your deny for this app\./);
  assert.match(describeDecision({ tool: "consent_revoke", args: {}, computer: "c1", identity: { name: "Notes" } }), /^Remove the recorded decision for this app\./);
  assert.match(describeDecision({ tool: "consent_revoke", args: { scope: "foreground" }, computer: "c1", denied: true }), /^Lift your deny on foreground control\./);
  const confirm = describeDecision({ tool: "consent_allow", args: { confirm: "confirm-1" }, computer: "local", confirmation: { tool: "key", label: "Send", app: { name: "Mail" }, repeated: 3, computer: "studio" } });
  for (const line of ['Action: "key" on "Send"', 'In app: "Mail"', "Presses: 3 Return, Enter or space presses; the focus can move between them", 'On computer: "studio"']) assert.ok(confirm.split("\n").includes(line), line);
  const foreground = describeDecision({ tool: "consent_allow", args: { scope: "foreground", app: "Ignored" }, computer: "local" });
  assert.match(foreground, /foreground control/);
  assert.doesNotMatch(foreground, /App name|Ignored/);
  const script = describeDecision({ tool: "app_script", args: { script: 'tell application "Finder" to get name\nreturn 1' }, computer: "local", targets: [{ name: "Finder" }, { bundle_id: "com.apple.systemevents" }] });
  assert.match(script, /^Apps it names: "Finder", "com\.apple\.systemevents"$/m);
  assert.ok(script.split("\n").includes(`Script: "tell application ${BS}"Finder${BS}" to get name${BS}nreturn 1"`));
  assert.match(describeDecision({ tool: "app_script", args: { script: "return 1" }, computer: "local", targets: [{ bundle_id: "com.apple.osascript" }] }), /^Apps it names: none; it runs as osascript itself/m);
  assert.throws(() => describeDecision({ tool: "app_script", args: { script: "x".repeat(1001) }, computer: "local", targets: [] }), { code: "script_too_long" });
  assert.throws(() => describeDecision({ tool: "app_script", args: { script: ch(0x3164).repeat(200) }, computer: "local", targets: [] }), { code: "script_too_long" }, "escapes count toward the window");
  assert.doesNotThrow(() => describeDecision({ tool: "app_script", args: { script: "x".repeat(998) }, computer: "local", targets: [] }));
  assert.throws(() => describeDecision({ tool: "app_script", args: { script: "return 1" }, computer: "local", targets: Array.from({ length: 13 }, (_, i) => ({ name: `App${i}` })) }), { code: "bad_args" });
  const register = describeDecision({ tool: "computer_register", args: { computer: "box", transport: "ssh", host: "192.0.2.1", user: "me", port: 22, knownHosts: "/tmp/kh" }, computer: "box" });
  for (const line of ['Host: "192.0.2.1"', 'User: "me"', 'Port: "22"', 'Known hosts file: "/tmp/kh"', "Install remote agent: yes", 'Computer id: "box"']) assert.ok(register.split("\n").includes(line), line);
  assert.throws(() => describeDecision({ tool: "consent_allow", args: {}, computer: "local", identity: { name: "n".repeat(121) } }), { code: "bad_args" }, "an identity is never shown cut");
  assert.throws(() => describeDecision({ tool: "computer_spawn", args: { transport: "docker", image: "x".repeat(201) }, computer: "tmp" }), { code: "bad_args" });
  assert.throws(() => describeDecision({ tool: "consent_deny", args: {}, computer: "local" }), { code: "bad_args" });
  assert.equal(visible("a\u0009b", 40), `"a${BS}tb"`);
  assert.equal(visible("n".repeat(10), 4, { cut: true }), `"nnnn${ELLIPSIS}"`);
});

test("one dialog at a time; while it is open everything that could reach the screen is refused", async () => {
  const { prompt, fake } = makePrompt();
  assert.equal(prompt.refusal("left_click", {}), null, "no lock before a dialog");
  const first = prompt.ask(request());
  assert.equal(prompt.pending, true);
  await assert.rejects(prompt.ask(request({ identity: { name: "Mail" } })), { code: "consent_pending" });
  assert.equal(fake.calls.length, 1, "the second decision never reached osascript");
  for (const tool of ["left_click", "double_click", "right_click", "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "scroll", "type", "key", "hold_key",
    "set_value", "focus", "select_text", "perform_action", "invoke_menu", "open_application", "kill_app", "set_window_frame", "switch_display", "screenshot", "zoom",
    "get_app_state", "find_elements", "wait_for", "list_windows", "list_displays", "get_value", "cursor_position", "read_clipboard", "write_clipboard", "recording_start",
    "preview", "request_access", "browser_click", "browser_type", "browser_screenshot", "run_actions", "trajectory_replay", "app_script", "consent_allow", "consent_deny",
    "consent_revoke", "computer_register", "computer_spawn", "computer_switch", "wait"]) {
    assert.equal(prompt.refusal(tool, {})?.code, "consent_pending", tool);
  }
  assert.match(prompt.refusal("left_click", {}).message, /consent status and plain list_apps wait in the queue until it closes/);
  assert.equal(prompt.refusal("list_apps", { all: true })?.code, "consent_pending");
  assert.equal(prompt.refusal("list_apps", { installed: true })?.code, "consent_pending");
  for (const [tool, args] of [["stop_computer_control", {}], ["consent_status", {}], ["list_apps", {}], ["list_apps", { computer: "local" }]]) assert.equal(prompt.refusal(tool, args), null, tool);
  fake.calls[0].settle(null, "Allow\n");
  await first;
  assert.equal(prompt.pending, false);
  assert.equal(prompt.refusal("left_click", {}), null, "the lock lifts when the dialog closes");
});

test("the lock lifts after a timeout, an error or a cancelled request", async () => {
  for (const settle of [(call) => call.settle(null, "timeout\n"), (call) => call.settle(Object.assign(new Error("killed"), { killed: true }), ""), (call) => call.settle(new Error("boom"))]) {
    const { prompt, fake } = makePrompt();
    const asked = prompt.ask(request());
    assert.equal(fake.calls[0].options.timeout, 130_000, "osascript is killed if it outlives its own 120 s give-up");
    settle(fake.calls[0]);
    await assert.rejects(asked, { code: "consent_declined" });
    assert.equal(prompt.pending, false);
    assert.equal(prompt.refusal("screenshot", {}), null);
  }
  const { prompt, fake, dir, flush } = makePrompt();
  const controller = new AbortController();
  const asked = prompt.ask(request(), { signal: controller.signal });
  assert.equal(fake.calls[0].options.signal, controller.signal, "the dialog is killed with its request");
  controller.abort();
  await assert.rejects(asked, { code: "cancelled" });
  assert.equal(prompt.pending, false);
  flush();
  assert.ok(!fs.existsSync(path.join(dir, MARKER_FILE)), "an aborted dialog's marker is removed");
  const idle = makePrompt();
  const ended = new AbortController();
  ended.abort();
  await assert.rejects(idle.prompt.ask(request(), { signal: ended.signal }), { code: "cancelled" });
  assert.equal(idle.fake.calls.length, 0, "an ended request shows nothing");
});

test("a minimum gap follows every dialog, Allow included, and a decision that waited behind one is refused", async () => {
  let t = 5_000;
  const { prompt, fake } = makePrompt({ now: () => t });
  const ticket = prompt.ticket;
  const first = prompt.ask(request());
  fake.calls[0].settle(null, "Allow\n");
  await first;
  await assert.rejects(prompt.ask(request(), { ticket }), (err) => err.code === "consent_pending" && /waited behind/.test(err.message), "a decision that arrived before the dialog opened is not shown after it");
  t += 1_000;
  await assert.rejects(prompt.ask(request()), (err) => err.code === "consent_rate_limited" && err.extra.retry_after_s === 1);
  assert.equal(fake.calls.length, 1);
  t += 1_001;
  const second = prompt.ask(request(), { ticket: prompt.ticket });
  assert.equal(fake.calls.length, 2, "the gap ended");
  fake.calls[1].settle(null, "Allow\n");
  await second;
});

test("a decline quiets the dialog for ten seconds, and a rolling minute shows at most five", async () => {
  const start = 1_000_000;
  let t = start;
  const { prompt, fake } = makePrompt({ now: () => t });
  const ask = () => prompt.ask(request());
  let asked = ask();
  fake.calls.at(-1).settle(userCanceled(), "");
  await assert.rejects(asked, { code: "consent_declined" });
  t += 5_000;
  await assert.rejects(ask(), (err) => err.code === "consent_rate_limited" && err.extra.retry_after_s === 5);
  assert.equal(fake.calls.length, 1, "no dialog during the quiet period");
  t = start + 10_001;
  asked = ask();
  assert.equal(fake.calls.length, 2, "the quiet period ended");
  fake.calls.at(-1).settle(null, "Allow\n");
  await asked;
  for (let i = 0; i < 3; i++) {
    t += 2_500;
    asked = ask();
    fake.calls.at(-1).settle(null, "Allow\n");
    await asked;
  }
  t += 2_500;
  await assert.rejects(ask(), (err) => err.code === "consent_rate_limited" && /5 approval dialogs/.test(err.message) && err.extra.retry_after_s === 40);
  assert.equal(fake.calls.length, 5);
  t = start + 60_000;
  asked = ask();
  assert.equal(fake.calls.length, 6, "the oldest dialog left the rolling minute");
  fake.calls.at(-1).settle(null, "Allow\n");
  await asked;
});

test("an open dialog leaves a 0600 marker with both pids, closes it, and removes it after the gap or at exit", async () => {
  const { prompt, fake, dir, flush } = makePrompt({ pid: 41_002, fake: fakeExec({ childPid: 77_002 }) });
  const asked = prompt.ask(request());
  const file = path.join(dir, MARKER_FILE);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const open = markerOf(dir);
  assert.equal(open.pid, 41_002);
  assert.equal(open.child_pid, 77_002);
  assert.equal(open.closed_at, null);
  fake.calls[0].settle(null, "Deny\n");
  await assert.rejects(asked, { code: "consent_declined" });
  assert.ok(Number.isFinite(markerOf(dir).closed_at));
  flush();
  assert.ok(!fs.existsSync(file), "removed when the gap ends");
  const again = makePrompt({ dir });
  const pending = again.prompt.ask(request());
  again.prompt.release();
  assert.ok(!fs.existsSync(file), "release (process exit) removes the marker");
  again.fake.calls[0].settle(null, "Deny\n");
  await assert.rejects(pending, { code: "consent_declined" });
});

test("stale markers are ignored: a dead owner, an expired dialog, an old unreadable file, a future timestamp", async () => {
  const now = Date.now();
  const alive = (pid) => pid !== 9_999;
  const judge = (marker, extra = {}) => judgeMarker(typeof marker === "string" ? marker : JSON.stringify(marker), { isAlive: alive, wallNow: () => now, ...extra });
  assert.equal(judge({ pid: 9_999, opened_at: now }), null, "dead owner");
  assert.equal(judge({ pid: 1_234, opened_at: now - 161_000 }), null, "older than the dialog timeout plus slack");
  assert.equal(judge({ pid: 1_234, opened_at: now + 60_000 }), null, "a timestamp from the future");
  assert.equal(judge("{", { mtimeMs: now - 3_000 }), null, "an old unreadable marker");
  assert.equal(judge("", { mtimeMs: now - 100 })?.state, "open", "a marker still being written counts as open");
  assert.deepEqual(judge({ pid: 1_234, child_pid: 5_678, opened_at: now - 1_000 }).pids, [1_234, 5_678]);
  assert.equal(judge({ pid: 1_234, opened_at: now - 5_000, closed_at: now - 500 })?.state, "closing");
  assert.equal(judge({ pid: 1_234, opened_at: now - 5_000, closed_at: now - 2_500 }), null, "past its gap");
  for (const leftover of [{ pid: 9_999, opened_at: now, token: "x" }, { pid: 1_234, opened_at: now - 500_000, token: "y" }]) {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify(leftover));
    const { prompt, fake } = makePrompt({ dir, alive });
    assert.equal(prompt.refusal("left_click", {}), null, "a stale marker locks nothing");
    const asked = prompt.ask(request());
    assert.equal(fake.calls.length, 1, "a stale marker does not block a new dialog");
    assert.equal(markerOf(dir).pid, 41_001, "it was replaced");
    fake.calls[0].settle(null, "Deny\n");
    await assert.rejects(asked, { code: "consent_declined" });
  }
});

test("a second server sharing the marker directory refuses the same tools and opens no dialog of its own", async () => {
  const dir = freshDir();
  const first = makePrompt({ dir, pid: 50_001 });
  const second = makePrompt({ dir, pid: 50_002 });
  const asked = first.prompt.ask(request());
  for (const tool of ["left_click", "type", "screenshot", "get_app_state", "app_script", "consent_allow"]) {
    const refused = second.prompt.refusal(tool, {});
    assert.equal(refused?.code, "consent_pending", tool);
    assert.match(refused.message, /Another Computer Use session/);
  }
  assert.equal(second.prompt.refusal("consent_status", {}), null);
  assert.equal(second.prompt.refusal("list_apps", {}), null);
  await assert.rejects(second.prompt.ask(request()), { code: "consent_pending" });
  assert.equal(second.fake.calls.length, 0, "cross-process single-flight");
  assert.equal(liveMarker({ fs, dir, isAlive: () => true })?.state, "open");
  first.fake.calls[0].settle(null, "Allow\n");
  await asked;
  assert.equal(second.prompt.refusal("left_click", {}), null, "input resumes once the dialog closes");
  await assert.rejects(second.prompt.ask(request()), { code: "consent_rate_limited" }, "the other session's gap holds too");
  first.flush();
  const next = second.prompt.ask(request());
  assert.equal(second.fake.calls.length, 1);
  second.fake.calls[0].settle(null, "Deny\n");
  await assert.rejects(next, { code: "consent_declined" });
  const dead = makePrompt({ dir: freshDir(), pid: 50_003 });
  fs.writeFileSync(path.join(dead.dir, MARKER_FILE), JSON.stringify({ pid: 50_004, opened_at: Date.now() }));
  assert.equal(createNativePrompt({ fs, dir: dead.dir, pid: 50_003, isAlive: () => false }).refusal("left_click", {}), null, "a dead owner's marker locks nothing");
  assert.equal(createNativePrompt({ fs, dir: dead.dir, pid: 50_003, isAlive: () => true }).refusal("left_click", {})?.code, "consent_pending", "a server with the dialog turned off still honors a live marker");
});

test("the macOS backend never binds to, observes or operates osascript or the dialog's processes", async (t) => {
  const { create } = await import("../src/backends/darwin.mjs");
  const bundle = freshDir();
  const state = freshDir();
  fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "MacOS", "accessibility"), "");
  const saved = { bundle: process.env.CODEWHALE_CU_APP_BUNDLE, state: process.env.CODEWHALE_CU_STATE_DIR };
  process.env.CODEWHALE_CU_APP_BUNDLE = bundle;
  process.env.CODEWHALE_CU_STATE_DIR = state;
  t.after(() => {
    for (const [key, value] of [["CODEWHALE_CU_APP_BUNDLE", saved.bundle], ["CODEWHALE_CU_STATE_DIR", saved.state]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const sent = [];
  const replies = { app_info: { found: true, pid: 4_321, name: "osascript" }, get_app_state: { found: true, pid: 4_321, name: "osascript", elements: [] } };
  const backend = create({ exec: { run: async (cmd, args) => {
    const req = JSON.parse(args[0]);
    sent.push(req);
    if (req.tool === "get_app_state" && req.args.app_ref?.name === "TextEdit") return { code: 0, stdout: JSON.stringify({ found: true, pid: 900, name: "TextEdit", elements: [] }), stderr: "", spawned: true };
    return { code: 0, stdout: JSON.stringify(replies[req.tool] ?? {}), stderr: "", spawned: true };
  } } });
  for (const call of [() => backend.get_app_state({ app_ref: { name: "osascript" } }), () => backend.get_app_state({ app_ref: { bundle_id: "com.apple.osascript" } }), () => backend.kill_app({ name: "osascript" }), () => backend.list_windows({ app_ref: { name: "OSAScript.app" } })]) {
    await assert.rejects(call(), { code: "protected_application" });
  }
  assert.equal(sent.length, 0, "refused before the native helper runs");
  await assert.rejects(backend.open_application({ pid: 4_321 }), { code: "protected_application" }, "a pid that resolves to osascript is refused at bind");
  await assert.rejects(backend.get_app_state({ app_ref: { pid: 4_321 } }), { code: "protected_application" }, "an observation that names osascript is not returned");
  fs.writeFileSync(path.join(state, MARKER_FILE), JSON.stringify({ pid: process.pid, child_pid: 55_555, opened_at: Date.now(), closed_at: null, token: "t" }));
  const before = sent.length;
  await assert.rejects(backend.get_app_state({ app_ref: { pid: 55_555 } }), { code: "protected_application" }, "the dialog's pid");
  await assert.rejects(backend.get_app_state({ app_ref: { pid: process.pid } }), { code: "protected_application" }, "the dialog owner's pid");
  assert.equal(sent.length, before);
  assert.equal((await backend.get_app_state({ app_ref: { name: "TextEdit" } })).name, "TextEdit", "other apps are unaffected");
  assert.equal(isPromptProcess({ name: "Safari", pid: 1 }, [2]), false);
  const { handle } = await import("../src/app-handler.mjs");
  for (const tool of ["left_click", "screenshot", "get_app_state", "type", "app_script"]) {
    const reply = await handle({ tool, args: {} }, { computerId: "local" });
    assert.equal(reply.error?.code, "consent_pending", `the helper refuses ${tool} from any caller while the dialog is open`);
  }
});

test("nothing but a function argument can answer or replace the dialog; the environment only turns it on", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "native-prompt.mjs"), "utf8");
  assert.doesNotMatch(source, /process\.env|process\.argv|\bimport\b[^;]*from/, "the module reads no environment and imports no runner");
  assert.match(source, /const available = enabled === true && platform === "darwin"/, "enabled only gates whether the dialog may be shown");
  const server = fs.readFileSync(path.join(ROOT, "mcp", "server.mjs"), "utf8");
  assert.equal((server.match(/createNativePrompt\(/g) ?? []).length, 1);
  assert.match(server, /createNativePrompt\(\{ execFile, platform: process\.platform, enabled: process\.env\.CODEWHALE_CU_NATIVE_PROMPT === "1", fs, dir: registry\.stateDir\(\), pid: process\.pid \}\)/);
  assert.equal((server.match(/CODEWHALE_CU_NATIVE_PROMPT/g) ?? []).length, 2, "read once, named once in the comment");
  assert.match(server, /^import \{ execFile \} from "node:child_process";$/m);
});

// ---------- wire: the real server, the fake osascript ----------

async function boot(t, { hostKeys = false, elicitation = null, enabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-native-prompt-"));
  const calls = path.join(dir, "backend-calls.jsonl");
  const stateDir = path.join(dir, "state");
  const child = spawn(process.execPath, ["--import", FAKE_OSASCRIPT, path.join(ROOT, "mcp", "server.mjs")], {
    env: { ...process.env, CODEWHALE_CU_NATIVE_PROMPT: enabled ? "1" : "", FAKE_OSASCRIPT_DIR: dir, FAKE_BACKEND_CALLS: calls, CODEWHALE_CU_STATE_DIR: stateDir, CODEWHALE_CU_RECORDINGS_DIR: path.join(dir, "rec"), CODEWHALE_CU_APP: "off", CODEWHALE_CU_TEST_BACKEND: path.join(ROOT, "tests", "fixtures", "fake-backend.mjs") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (hostKeys) child.stdin.write(hostKeysLine());
  t.after(() => { try { child.stdin.end(); } catch {} child.kill("SIGTERM"); fs.rmSync(dir, { recursive: true, force: true }); });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === "elicitation/create" && elicitation) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { action: elicitation(msg) } }) + "\n");
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const frame = (method, params, timeoutMs = 20_000) => {
    const id = nextId++;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
    return { line: JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", reply };
  };
  const rpc = (method, params, timeoutMs) => { const f = frame(method, params, timeoutMs); child.stdin.write(f.line); return f.reply; };
  const parse = (r) => JSON.parse(r.result.content[0].text);
  const send = (params, timeoutMs) => rpc("tools/call", params, timeoutMs).then(parse);
  const tool = (name, args = {}, timeoutMs) => send({ name, arguments: args }, timeoutMs);
  const together = (...calls) => {
    const frames = calls.map(([name, args]) => frame("tools/call", { name, arguments: args }));
    child.stdin.write(frames.map((f) => f.line).join(""));
    return frames.map((f) => f.reply.then(parse));
  };
  const prompt = async (n) => {
    const file = path.join(dir, `prompt-${n}.json`);
    for (let i = 0; i < 250 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const answer = (n, body) => fs.writeFileSync(path.join(dir, `answer-${n}.json`), JSON.stringify(body));
  const promptCount = () => fs.readdirSync(dir).filter((name) => /^prompt-\d+\.json$/.test(name)).length;
  const backendCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).method) : []);
  return { rpc, send, tool, together, prompt, answer, promptCount, backendCalls, dir, stateDir, pid: child.pid };
}
const DENIED = { error: "execution error: User canceled. (-128)", code: 1 };

test("server: without CODEWHALE_CU_NATIVE_PROMPT=1 the old refusal stands and no dialog opens", async (t) => {
  const s = await boot(t, { enabled: false });
  for (const [name, args] of [["consent", { action: "allow", app: "FakeApp" }], ["app_script", { script: "return 1" }], ["computer", { action: "spawn", id: "tmp", transport: "docker" }]]) {
    assert.equal((await s.tool(name, args)).error?.code, "consent_needs_user", name);
  }
  assert.equal(s.promptCount(), 0);
});

test("server: the dialog shows the one running app the ledger records, resolved once before it opens", NEED_DARWIN, async (t) => {
  const s = await boot(t);
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native-test", version: "1.0" } });
  const decision = s.tool("consent", { action: "allow", pid: 4242, remember: true });
  const shown = await s.prompt(1);
  assert.equal(shown.file, "/usr/bin/osascript");
  const lines = shown.args.at(-5).split("\n");
  for (const line of ["Tool: consent_allow", 'App name: "FakeApp"', 'Bundle id: "com.fake.app"', "Process id: 4242 (recorded for this session only)", "Running now: yes",
    "Remember: requested, but this host keeps approvals for this session only", 'Computer: "local"', 'Requested through: "native-test" "1.0" (as the MCP client names itself)']) {
    assert.ok(lines.includes(line), line);
  }
  const marker = JSON.parse(fs.readFileSync(path.join(s.stateDir, MARKER_FILE), "utf8"));
  assert.equal(marker.pid, s.pid, "the server marks its open dialog");
  assert.equal(fs.statSync(path.join(s.stateDir, MARKER_FILE)).mode & 0o777, 0o600);
  s.answer(1, { stdout: "Allow\n" });
  const allowed = await decision;
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.deepEqual(allowed.keys, ["bundle:com.fake.app", "name:fakeapp", "pid:4242"], "exactly the identity the dialog showed");
  assert.equal(allowed.persisted, false, "without the host's ledger key an allow lasts this session");
  assert.equal(s.backendCalls().filter((method) => method === "list_apps").length, 1, "no second lookup after the click");
  assert.equal((await s.tool("open_application", { name: "FakeApp" })).ok, true);
});

test("server: a name, bundle id and pid that do not resolve to one app are refused before any dialog", NEED_DARWIN, async (t) => {
  const s = await boot(t);
  for (const args of [{ name: "FakeApp", bundle_id: "com.other.app" }, { name: "FakeApp", pid: 999 }, { pid: 999 }, { name: "Ghost", bundle_id: "com.ghost.app" }]) {
    const refused = await s.tool("consent", { action: "allow", ...args });
    assert.equal(refused.error?.code, "consent_identity_ambiguous", JSON.stringify(args));
  }
  assert.equal((await s.tool("consent", { action: "revoke", name: "FakeApp", bundle_id: "com.other.app" })).error?.code, "consent_identity_ambiguous");
  assert.equal(s.promptCount(), 0);
  const ghost = s.tool("consent", { action: "allow", app: "Ghost" });
  assert.match((await s.prompt(1)).args.at(-5), /^Running now: no; recorded exactly as named$/m);
  s.answer(1, { stdout: "Allow\n" });
  assert.deepEqual((await ghost).keys, ["name:ghost"]);
});

test("server: while the dialog is open, input, targeting and observation refuse consent_pending and reach no backend", NEED_DARWIN, async (t) => {
  const s = await boot(t);
  const decision = s.tool("consent", { action: "allow", app: "FakeApp" });
  await s.prompt(1);
  const listed = s.backendCalls().length;
  for (const [name, args] of [
    ["screenshot", {}], ["click", { target: { type: "coordinate", x: 1, y: 1 } }], ["type", { text: "y" }], ["key", { text: "return" }],
    ["pointer", { action: "move", target: { type: "coordinate", x: 1, y: 1, space: "screen" } }], ["get_app_state", { app_ref: { name: "FakeApp" } }],
    ["open_application", { name: "FakeApp" }], ["run_actions", { steps: [{ tool: "key", arguments: { text: "return" } }] }],
    ["consent", { action: "allow", app: "OtherApp" }], ["app_script", { script: "return 1" }], ["computer", { action: "register", id: "x", transport: "ssh", host: "192.0.2.1" }],
    ["trajectory", { action: "replay", id: "none" }], ["list_apps", { all: true }],
  ]) {
    const refused = await s.tool(name, args, 2_000);
    assert.equal(refused.error?.code, "consent_pending", `${name}: ${JSON.stringify(refused)}`);
  }
  const status = s.tool("consent", { action: "status" });
  const apps = s.tool("list_apps", {});
  assert.equal(s.backendCalls().length, listed, "nothing reached the backend while the dialog was open");
  s.answer(1, DENIED);
  const declined = await decision;
  assert.equal(declined.error?.code, "consent_declined");
  assert.equal(declined.error?.message, DECLINED_MESSAGE);
  assert.equal((await status).ok, true, "consent status waited and ran");
  assert.equal((await apps).ok, true, "plain list_apps waited and ran");
  assert.notEqual((await s.tool("screenshot", {})).error?.code, "consent_pending", "the lock lifts when the dialog closes");
  const again = await s.tool("consent", { action: "allow", app: "FakeApp" });
  assert.equal(again.error?.code, "consent_rate_limited");
  assert.ok(again.retry_after_s > 0 && again.retry_after_s <= 10, JSON.stringify(again));
  assert.equal(again.ok, false);
  assert.equal(s.promptCount(), 1, "only one dialog was shown");
});

test("server: a decision queued behind an open dialog is refused, and another waits out the gap after an Allow", NEED_DARWIN, async (t) => {
  const s = await boot(t);
  const [first, queued] = s.together(["consent", { action: "allow", app: "FakeApp" }], ["consent", { action: "allow", app: "OtherApp" }]);
  await s.prompt(1);
  s.answer(1, { stdout: "Allow\n" });
  assert.equal((await first).ok, true);
  assert.equal((await queued).error?.code, "consent_pending", "it is not shown after the first dialog closes");
  const soon = await s.tool("consent", { action: "allow", app: "ThirdApp" });
  assert.equal(soon.error?.code, "consent_rate_limited", "the gap after an Allow");
  assert.equal(s.promptCount(), 1);
});

test("server: app_script runs its policy before the dialog, names the apps it targets, and is refused when it cannot be shown in full", NEED_DARWIN, async (t) => {
  const s = await boot(t);
  assert.equal((await s.tool("app_script", { script: 'do shell script "id"' })).error?.code, "script_refused");
  assert.equal((await s.tool("app_script", { script: `return "${"x".repeat(1200)}"` })).error?.code, "script_too_long");
  assert.equal(s.promptCount(), 0);
  const run = s.tool("app_script", { script: 'tell application "Finder" to get name of startup disk' });
  const lines = (await s.prompt(1)).args.at(-5).split("\n");
  assert.ok(lines.includes('Apps it names: "Finder"'), lines.join("\n"));
  assert.ok(lines.includes(`Script: "tell application ${BS}"Finder${BS}" to get name of startup disk"`));
  s.answer(1, DENIED);
  assert.equal((await run).error?.code, "consent_declined");
});

test("server: another session's live marker locks this server too, and register is validated before any dialog", NEED_DARWIN, async (t) => {
  const s = await boot(t);
  assert.equal((await s.tool("computer", { action: "register", id: "bad id", transport: "ssh", host: "192.0.2.1" })).error?.code, "invalid_id");
  assert.equal((await s.tool("computer", { action: "register", id: "box", transport: "ssh", host: "-oProxyCommand=x" })).error?.code, "invalid_host");
  assert.equal((await s.tool("computer", { action: "spawn", id: "tmp", transport: "ssh" })).error?.code, "bad_args");
  assert.equal(s.promptCount(), 0);
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(path.join(s.stateDir, MARKER_FILE), JSON.stringify({ pid: process.pid, child_pid: null, opened_at: Date.now(), closed_at: null, token: "other" }));
  for (const [name, args] of [["screenshot", {}], ["type", { text: "y" }], ["consent", { action: "allow", app: "FakeApp" }]]) {
    const refused = await s.tool(name, args, 2_000);
    assert.equal(refused.error?.code, "consent_pending", name);
    assert.match(refused.error.message, /Another Computer Use session/);
  }
  assert.equal((await s.tool("consent", { action: "status" }, 2_000)).ok, true);
  fs.rmSync(path.join(s.stateDir, MARKER_FILE));
  assert.notEqual((await s.tool("screenshot", {})).error?.code, "consent_pending");
  assert.equal(s.promptCount(), 0);
});

test("server: stop_computer_control closes an open dialog, a late Allow records nothing, and the marker goes away", NEED_DARWIN, async (t) => {
  const s = await boot(t);
  const decision = s.tool("consent", { action: "allow", app: "FakeApp" });
  await s.prompt(1);
  assert.equal((await s.tool("stop_computer_control", {}, 5_000)).ok, true);
  assert.equal((await decision).error?.code, "cancelled");
  assert.ok(fs.existsSync(path.join(s.dir, "aborted-1")), "the dialog was killed with its request");
  s.answer(1, { stdout: "Allow\n" });
  assert.deepEqual((await s.tool("consent", { action: "status" })).apps, {});
  const file = path.join(s.stateDir, MARKER_FILE);
  for (let i = 0; i < 200 && fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(!fs.existsSync(file), "the marker is removed after the gap");
});

test("server: a Codewhale host key or an elicitation-capable client keeps its own prompt, and batches never open the dialog", NEED_DARWIN, async (t) => {
  const keyed = await boot(t, { hostKeys: true });
  assert.equal((await keyed.tool("consent", { action: "allow", app: "FakeApp" })).error?.code, "consent_needs_user", "an unattested call under the host is still refused");
  assert.equal((await keyed.send(attest({ name: "consent", arguments: { action: "allow", app: "FakeApp" } }))).ok, true);
  assert.equal(keyed.promptCount(), 0);
  const asked = [];
  const elicited = await boot(t, { elicitation: (msg) => { asked.push(msg.params.message); return "accept"; } });
  await elicited.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } });
  assert.equal((await elicited.tool("consent", { action: "allow", app: "FakeApp" })).ok, true);
  assert.equal(asked.length, 1);
  assert.equal(elicited.promptCount(), 0);
  const plain = await boot(t);
  assert.equal((await plain.tool("run_actions", { steps: [{ tool: "consent", arguments: { action: "allow", app: "FakeApp" } }] })).error?.code, "bad_args");
  assert.equal((await plain.tool("run_actions", { steps: [{ tool: "app_script", arguments: { script: "return 1" } }] })).error?.code, "consent_needs_user");
  assert.equal(plain.promptCount(), 0);
});
