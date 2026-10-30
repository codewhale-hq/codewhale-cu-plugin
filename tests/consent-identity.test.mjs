import { hostKeysLine, attestParams } from "./fixtures/host-decision.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";
process.env.CODEWHALE_CU_APPROVAL = "strict";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FAKE = { name: "FakeApp", pid: 4242, bundle_id: "com.fake.app", frontmost: true };

async function boot(t, { env = {}, state = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-identity-"));
  const calls = path.join(dir, "calls.jsonl");
  const stateFile = path.join(dir, "state.json");
  const control = path.join(dir, "control.json");
  fs.writeFileSync(stateFile, JSON.stringify({ apps: [FAKE], ...state }));
  const child = spawn("node", [path.join(ROOT, "mcp", "server.mjs")], {
    env: {
      ...process.env,
      CODEWHALE_CU_STATE_DIR: path.join(dir, "state"),
      CODEWHALE_CU_RECORDINGS_DIR: path.join(dir, "rec"),
      CODEWHALE_CU_APP: "off",
      CODEWHALE_CU_TEST_BACKEND: path.join(ROOT, "tests", "fixtures", "fake-backend.mjs"),
      FAKE_BACKEND_CALLS: calls,
      FAKE_BACKEND_CONTROL: control,
      FAKE_BACKEND_STATE: stateFile,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(hostKeysLine());
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
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 20_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: attestParams(method, params) }) + "\n");
  });
  const tool = async (name, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);
  const calls_ = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    tool,
    calls: (method) => calls_().filter((c) => !method || c.method === method),
    setState: (next) => fs.writeFileSync(stateFile, JSON.stringify(next)),
    setControl: (next) => fs.writeFileSync(control, JSON.stringify(next)),
  };
}

test("open_application judges every identity it names: one allowed app's pid does not launch another app", async (t) => {
  const s = await boot(t);
  assert.equal((await s.tool("consent", { action: "allow", app: "FakeApp" })).ok, true);
  const mixed = await s.tool("open_application", { pid: 4242, name: "Terminal" });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error.code, "consent_required");
  assert.match(mixed.error.message, /Terminal/);
  const withUrl = await s.tool("open_application", { pid: 4242, name: "Terminal", url: "https://example.test/x" });
  assert.equal(withUrl.error?.code, "consent_required");
  const byBundle = await s.tool("open_application", { name: "FakeApp", bundle_id: "com.apple.Terminal" });
  assert.equal(byBundle.error?.code, "consent_required");
  assert.deepEqual(s.calls("open_application"), []);
});

test("a deny on the named app holds when an allowed app's pid rides along", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  await s.tool("consent", { action: "deny", app: "Terminal" });
  const mixed = await s.tool("open_application", { pid: 4242, name: "Terminal", url: "https://example.test/y" });
  assert.equal(mixed.error?.code, "app_denied");
  assert.deepEqual(s.calls("open_application"), []);
});

test("kill_app judges every identity it names", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const mixed = await s.tool("kill_app", { pid: 4242, name: "Terminal" });
  assert.equal(mixed.error?.code, "consent_required");
  await s.tool("consent", { action: "deny", app: "Terminal" });
  const denied = await s.tool("kill_app", { pid: 4242, name: "Terminal" });
  assert.equal(denied.error?.code, "app_denied");
  assert.deepEqual(s.calls("kill_app"), []);
});

test("identities that agree still open; malformed identities are refused at the boundary", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const agreeing = await s.tool("open_application", { pid: 4242, name: "FakeApp", bundle_id: "com.fake.app" });
  assert.equal(agreeing.ok, true, JSON.stringify(agreeing));
  for (const args of [{ pid: "4242", name: "FakeApp" }, { pid: 4242.5, name: "FakeApp" }, { pid: -3, name: "FakeApp" }]) {
    const r = await s.tool("kill_app", args);
    assert.equal(r.error?.code, "bad_args", JSON.stringify(args));
  }
  const odd = await s.tool("kill_app", { pid: 4242, name: ["Terminal"] });
  assert.equal(odd.error?.code, "bad_args");
});

const CHROME = { name: "chrome", comm: "chrome", pid: 77, title: "Calculator", aliases: ["Calculator"] };

test("a window name that matches an allowed app does not override a deny on the process", async (t) => {
  const s = await boot(t, { state: { owner: CHROME } });
  await s.tool("consent", { action: "deny", app: "chrome" });
  await s.tool("consent", { action: "allow", app: "Calculator" });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.error?.code, "app_denied");
  assert.deepEqual(s.calls("type"), []);
});

test("a window name that matches a denied app tightens an allowed process", async (t) => {
  const s = await boot(t, { state: { owner: CHROME } });
  await s.tool("consent", { action: "deny", app: "Calculator" });
  await s.tool("consent", { action: "allow", app: "chrome" });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.error?.code, "app_denied");
});

test("a window name still stands in for the process when the process has no decision", async (t) => {
  const s = await boot(t, { state: { owner: { ...CHROME, name: "ApplicationFrameHost", comm: "ApplicationFrameHost" } } });
  await s.tool("consent", { action: "allow", app: "Calculator" });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.ok, true, JSON.stringify(typed));
});

test("a pid the user approved does not carry over to the app that inherits the number", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const terminal = { name: "Terminal", comm: "Terminal", pid: 4242 };
  s.setState({ apps: [{ ...terminal, bundle_id: "com.apple.Terminal", frontmost: true }], owner: terminal });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.error?.code, "consent_required");
  assert.match(typed.error.message, /Terminal/);
  const byPid = await s.tool("get_app_state", { app_ref: { pid: 4242 } });
  assert.equal(byPid.error?.code, "consent_required");
  assert.match(byPid.error.message, /Terminal/);
  assert.deepEqual(s.calls("type"), []);
  assert.deepEqual(s.calls("get_app_state"), []);
});

test("a pid reference follows the process now at that pid, and an unresolvable pid is not trusted", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const ok = await s.tool("get_app_state", { app_ref: { pid: 4242 } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  s.setState({ apps: [] });
  const gone = await s.tool("get_app_state", { app_ref: { pid: 4242 } });
  assert.equal(gone.error?.code, "consent_required");
});

test("an unnamed observation on macOS is pinned to the whole identity, not the pid alone", { skip: process.platform !== "darwin" }, async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  assert.equal((await s.tool("get_app_state", {})).ok, true);
  assert.deepEqual(s.calls("get_app_state").at(-1).args.app_ref, { pid: 4242, bundle_id: "com.fake.app", name: "FakeApp" });
  assert.equal((await s.tool("open_application", { name: "FakeApp" })).ok, true);
  assert.equal((await s.tool("get_app_state", {})).ok, true);
  assert.deepEqual(s.calls("get_app_state").at(-1).args.app_ref, { pid: 4242, bundle_id: "com.fake.app", name: "FakeApp" });
});

async function bound(s, name) {
  await s.tool("consent", { action: "allow", app: name });
  const opened = await s.tool("open_application", { name });
  assert.equal(opened.ok, true, JSON.stringify(opened));
}

test("a launch that fails after dispatch keeps the old binding judged, and its target too", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  await bound(s, "FakeApp");
  await s.tool("consent", { action: "allow", app: "OtherApp" });
  s.setState({ apps: [FAKE], owner: null, open_error: { code: "launch_failed" } });
  const failed = await s.tool("open_application", { name: "OtherApp" });
  assert.equal(failed.error?.code, "launch_failed");
  await s.tool("consent", { action: "deny", app: "FakeApp" });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.error?.code, "app_denied");
  assert.deepEqual(s.calls("type"), []);
  await s.tool("consent", { action: "revoke", app: "FakeApp" });
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  await s.tool("consent", { action: "deny", app: "OtherApp" });
  const second = await s.tool("key", { text: "tab" });
  assert.equal(second.error?.code, "app_denied");
  assert.deepEqual(s.calls("key"), []);
});

test("a later launch that succeeds settles the binding again", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  await bound(s, "FakeApp");
  await s.tool("consent", { action: "allow", app: "OtherApp" });
  s.setState({ apps: [FAKE], owner: null, open_error: { code: "launch_failed" } });
  assert.equal((await s.tool("open_application", { name: "OtherApp" })).ok, false);
  s.setState({ apps: [FAKE], owner: null });
  assert.equal((await s.tool("open_application", { name: "FakeApp" })).ok, true);
  await s.tool("consent", { action: "deny", app: "OtherApp" });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.ok, true, JSON.stringify(typed));
});

test("a launch that reports no resolved app leaves its target judged too", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  await bound(s, "FakeApp");
  await s.tool("consent", { action: "allow", app: "OtherApp" });
  s.setControl({ open_without_resolved: true });
  assert.equal((await s.tool("open_application", { name: "OtherApp" })).ok, true);
  await s.tool("consent", { action: "deny", app: "OtherApp" });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.error?.code, "app_denied");
});

const BUTTON = { role: "AXButton", label: "Continue", app: { name: "FakeApp", pid: 4242 } };

test("a repeated Return is not judged by one read of the focused control", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  s.setControl({ focused: BUTTON });
  const single = await s.tool("key", { text: "return" });
  assert.equal(single.ok, true, JSON.stringify(single));
  const repeated = await s.tool("key", { text: "return", repeat: 5 });
  assert.equal(repeated.error?.code, "confirmation_required");
  assert.match(repeated.error.message, /5 times/);
  assert.equal(s.calls("key").length, 1, "only the single press reached the backend");
  const token = repeated.confirm.token;
  assert.equal((await s.tool("consent", { action: "allow", confirm: token })).ok, true);
  assert.equal((await s.tool("key", { text: "return", repeat: 5 })).ok, true);
  assert.equal(s.calls("key").length, 2);
  assert.equal((await s.tool("key", { text: "return", repeat: 5 })).error?.code, "confirmation_required", "the approval admits one call");
});

test("several newlines typed while a button holds focus need the same confirmation", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  s.setControl({ focused: BUTTON });
  assert.equal((await s.tool("type", { text: "ok\n" })).ok, true);
  const many = await s.tool("type", { text: "\n\n\n" });
  assert.equal(many.error?.code, "confirmation_required");
  const withEnter = await s.tool("type", { text: "a\nb", press_enter: true });
  assert.equal(withEnter.error?.code, "confirmation_required");
  assert.deepEqual(s.calls("type").map((c) => c.args.text), ["ok"]);
});

test("repeated Return in a text field is not gated", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  s.setControl({ focused: { role: "AXTextField", label: "Notes", app: { name: "FakeApp", pid: 4242 } } });
  assert.equal((await s.tool("key", { text: "return", repeat: 5 })).ok, true);
  assert.equal((await s.tool("type", { text: "a\n\nb" })).ok, true);
});

test("a whole-screen capture needs at least one approved app on the computer", async (t) => {
  const s = await boot(t);
  for (const args of [{}, { region: [0, 0, 10, 10] }, { display: 1 }]) {
    const r = await s.tool("screenshot", args);
    assert.equal(r.error?.code, "consent_required", JSON.stringify(args));
  }
  const recording = await s.tool("recording", { action: "start" });
  assert.equal(recording.error?.code, "consent_required");
  await s.tool("consent", { action: "deny", app: "Terminal" });
  assert.equal((await s.tool("screenshot", {})).error?.code, "consent_required", "a deny alone is not an approval");
  assert.deepEqual(s.calls("screenshot"), []);
  assert.deepEqual(s.calls("recording_start"), []);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const shot = await s.tool("screenshot", {});
  assert.equal(shot.ok, true, JSON.stringify(shot));
});

test("naming an app still decides on that app, not on the rest of the ledger", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const other = await s.tool("screenshot", { app_ref: { name: "Terminal" } });
  assert.equal(other.error?.code, "consent_required");
  assert.match(other.error.message, /Terminal/);
});

test("every key spelling a backend accepts for Return or space is judged on the focused control", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  s.setControl({ focused: { role: "AXButton", label: "Delete account", app: { name: "FakeApp", pid: 4242 } } });
  for (const text of ["return", "KP_Enter", "kp-enter", "KP Enter", "ISO_Enter", "KP_Space", "Linefeed", "3270_Enter", "ctrl+Return", "shift+space", " "]) {
    const r = await s.tool("key", { text });
    assert.equal(r.error?.code, "confirmation_required", JSON.stringify(text));
  }
  assert.deepEqual(s.calls("key"), []);
  assert.equal((await s.tool("key", { text: "tab" })).ok, true);
});

test("zoom without a named or bound app needs an approved app too", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const shot = await s.tool("screenshot", {});
  assert.equal(shot.ok, true, JSON.stringify(shot));
  await s.tool("consent", { action: "revoke", app: "FakeApp" });
  const zoomed = await s.tool("zoom", { region: [0, 0, 10, 10], raster_id: shot.raster_id });
  assert.equal(zoomed.error?.code, "consent_required");
  assert.deepEqual(s.calls("zoom"), []);
});

test("a whole-screen capture is refused while a deny covers the app in front", { skip: process.platform !== "darwin" }, async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "OtherApp" });
  assert.equal((await s.tool("screenshot", {})).ok, true);
  await s.tool("consent", { action: "deny", app: "FakeApp" });
  const refused = await s.tool("screenshot", {});
  assert.equal(refused.error?.code, "app_denied");
  assert.match(refused.error.message, /FakeApp/);
  const recording = await s.tool("recording", { action: "start" });
  assert.equal(recording.error?.code, "app_denied");
  assert.equal(s.calls("screenshot").length, 1);
  assert.deepEqual(s.calls("recording_start"), []);
  s.setState({ apps: [{ name: "Notes", pid: 9, bundle_id: "com.apple.Notes", frontmost: true }] });
  assert.equal((await s.tool("screenshot", {})).ok, true, "a deny on an app that is not in front does not block a capture");
});

test("a runner that cannot read the focused control says the focus gate is unavailable", async (t) => {
  const s = await boot(t, { env: { CODEWHALE_CU_TEST_REMOTE: "1" }, state: { owner: null, focus_unsupported: true } });
  s.setControl({ focused: { role: "AXButton", label: "Delete account", app: { name: "FakeApp", pid: 4242 } } });
  const pressed = await s.tool("key", { text: "return" });
  assert.equal(pressed.ok, true, JSON.stringify(pressed));
  assert.equal(pressed.focus_gate, "unavailable");
  const plain = await s.tool("key", { text: "tab" });
  assert.equal(plain.ok, true);
  assert.equal(plain.focus_gate, undefined);
});

const NOTES = { name: "Notes", pid: 9, bundle_id: "com.apple.Notes", frontmost: true };

test("an app being bound does not turn a display or region capture into an app capture", { skip: process.platform !== "darwin" }, async (t) => {
  const s = await boot(t, { state: { apps: [{ ...FAKE, frontmost: false }, NOTES] } });
  await bound(s, "FakeApp");
  await s.tool("consent", { action: "deny", app: "Notes" });
  for (const args of [{ display: 1 }, { region: [0, 0, 10, 10] }]) {
    const r = await s.tool("screenshot", args);
    assert.equal(r.error?.code, "app_denied", JSON.stringify(args));
  }
  const recording = await s.tool("recording", { action: "start" });
  assert.equal(recording.error?.code, "app_denied");
  assert.deepEqual(s.calls("screenshot"), []);
  assert.deepEqual(s.calls("recording_start"), []);
  const followed = await s.tool("screenshot", {});
  assert.equal(followed.ok, true, JSON.stringify(followed));
});

test("on Linux a window index does not scope a recording to an app", async (t) => {
  const s = await boot(t, { env: { NODE_OPTIONS: `--require ${path.join(ROOT, "tests", "fixtures", "platform-linux.cjs")}` } });
  for (const args of [{}, { window_id: 0 }, { window_id: 1 }]) {
    const r = await s.tool("recording", { action: "start", ...args });
    assert.equal(r.error?.code, "consent_required", JSON.stringify(args));
  }
  assert.deepEqual(s.calls("recording_start"), []);
});

const OTHER = { name: "OtherApp", pid: 555, bundle_id: "com.other.app", frontmost: false };

test("a failed launch by pid is remembered by the app it named, so it cannot wedge the binding", async (t) => {
  const s = await boot(t, { state: { owner: null, apps: [FAKE, OTHER] } });
  await bound(s, "FakeApp");
  await s.tool("consent", { action: "allow", app: "OtherApp" });
  s.setState({ apps: [FAKE, OTHER], owner: null, open_error: { code: "launch_failed" } });
  assert.equal((await s.tool("open_application", { pid: 555 })).error?.code, "launch_failed");
  s.setState({ apps: [FAKE], owner: null });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.ok, true, JSON.stringify(typed));
});

test("repeated failed launches are remembered once, not once per attempt", async (t) => {
  const s = await boot(t, { state: { owner: null, apps: [FAKE, OTHER] } });
  await bound(s, "FakeApp");
  await s.tool("consent", { action: "allow", app: "OtherApp" });
  s.setState({ apps: [FAKE, OTHER], owner: null, open_error: { code: "launch_failed" } });
  for (let i = 0; i < 12; i++) await s.tool("open_application", { pid: 555 });
  const before = s.calls("list_apps").length;
  assert.equal((await s.tool("type", { text: "hello" })).ok, true);
  assert.ok(s.calls("list_apps").length - before <= 1, `list_apps calls for one action: ${s.calls("list_apps").length - before}`);
});

test("a launch with no resolved app is judged afterwards even when nothing was bound before", async (t) => {
  const s = await boot(t, { state: { owner: null } });
  await s.tool("consent", { action: "allow", app: "OtherApp" });
  s.setControl({ open_without_resolved: true });
  assert.equal((await s.tool("open_application", { name: "OtherApp" })).ok, true);
  await s.tool("consent", { action: "deny", app: "OtherApp" });
  const typed = await s.tool("type", { text: "hello" });
  assert.equal(typed.error?.code, "app_denied");
  assert.deepEqual(s.calls("type"), []);
});
