import { hostKeysLine, attestParams } from "./fixtures/host-decision.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";

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
