// Per-app consent: the app, not the tool, is the unit of trust on the local
// computer. Unit tests pin the ledger; server tests prove the gate refuses
// before backend dispatch, cannot be sidestepped by re-spelling the app, and
// that app approval covers explicit foreground selection without overriding a deny.
import { hostKeysLine, attest, attestParams, TEST_LEDGER_KEY, ledgerMac } from "./fixtures/host-decision.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";
import * as consent from "../src/consent.mjs";
import { createConsentController, resolveConsentApp, issueAppScriptToken, consumeAppScriptToken } from "../src/app-handler.mjs";
import { appRequest, hello } from "../src/app-socket.mjs";
import { dockerAvailable } from "../src/spawn.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FAKE_OSASCRIPT = url.pathToFileURL(path.join(ROOT, "tests", "fixtures", "fake-osascript.mjs")).href;
const DOCKER = await dockerAvailable();
const NEED_DOCKER = { skip: !DOCKER && "docker daemon not available" };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cu-consent-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let tmpSeq = 0;
function freshDir() {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${tmpSeq++}-`));
  process.env.CODEWHALE_CU_STATE_DIR = dir;
  return dir;
}
// The unit tests run as the host would configure the plugin: remembered
// allows are signed with the ledger key.
consent.setLedgerKey(Buffer.from(TEST_LEDGER_KEY, "hex"));
// Every test gets a clean store and a clean session map key space.
let cidSeq = 0;
const cid = () => `c${cidSeq++}`;

// ---------- unit: the ledger ----------

test("appKeys normalize identity; parseAppArg reads every spelling", () => {
  assert.deepEqual(consent.appKeys({ name: "Safari", bundle_id: "Com.Apple.Safari", pid: 42 }),
    ["bundle:com.apple.safari", "name:safari", "pid:42"]);
  assert.deepEqual(consent.appKeys({}), []);
  assert.deepEqual(consent.appKeys(null), []);
  assert.deepEqual(consent.parseAppArg({ app: "pid:77" }), ["pid:77"]);
  assert.deepEqual(consent.parseAppArg({ app: "77" }), ["pid:77"]);
  assert.deepEqual(consent.parseAppArg({ app: "com.apple.Safari" }), ["bundle:com.apple.safari"]);
  assert.deepEqual(consent.parseAppArg({ app: "Safari.app" }), ["name:safari"]);
  assert.deepEqual(consent.parseAppArg({ app: "My App" }), ["name:my app"]);
  // Explicit fields win over the app string entirely.
  assert.deepEqual(consent.parseAppArg({ app: "Other", name: "Chosen" }), ["name:chosen"]);
});

test("record + decisionFor: allow/deny per computer, newest decision wins", () => {
  freshDir();
  const id = cid();
  assert.equal(consent.decisionFor(id, ["name:calc"]).state, "undecided");
  consent.record(id, ["name:calc"], "allow");
  assert.equal(consent.decisionFor(id, ["name:calc"]).state, "allowed");
  // A different computer sees nothing.
  assert.equal(consent.decisionFor(cid(), ["name:calc"]).state, "undecided");
  consent.record(id, ["name:calc"], "deny");
  assert.equal(consent.decisionFor(id, ["name:calc"]).state, "denied");
});

test("session and persisted layers overlay: a later session decision wins over 'always'", () => {
  freshDir();
  const id = cid();
  consent.record(id, ["name:mail"], "deny", { remember: true });
  assert.equal(consent.decisionFor(id, ["name:mail"]).state, "denied");
  // A session allow recorded later outranks the persisted deny.
  consent.record(id, ["name:mail"], "allow");
  const d = consent.decisionFor(id, ["name:mail"]);
  assert.equal(d.state, "allowed");
  assert.equal(d.persisted, false);
});

test("pid keys are session-only — a pid never persists to consent.json", () => {
  const dir = freshDir();
  const id = cid();
  consent.record(id, ["name:thing", "pid:4242"], "allow", { remember: true });
  const file = JSON.parse(fs.readFileSync(path.join(dir, "consent.json"), "utf8"));
  assert.ok(file.computers[id].apps["name:thing"]);
  assert.equal(file.computers[id].apps["pid:4242"], undefined, "pid must not persist");
  assert.ok(consent.decisionFor(id, ["pid:4242"]).state === "allowed", "session still sees the pid key");
});

test("alias folds a resolved identity's other spellings into the same decision", () => {
  freshDir();
  const id = cid();
  consent.record(id, ["name:safari"], "allow");
  // open_application resolved com.apple.Safari — the same allow now covers it.
  consent.alias(id, ["bundle:com.apple.safari", "pid:501"], { persisted: false, name: "Safari" });
  assert.equal(consent.decisionFor(id, ["bundle:com.apple.safari"]).state, "allowed");
  assert.equal(consent.decisionFor(id, ["pid:501"]).state, "allowed");
});

test("revoke removes decisions at both layers; dropSession keeps persisted", () => {
  const dir = freshDir();
  const id = cid();
  consent.record(id, ["name:a"], "allow", { remember: true });
  consent.record(id, ["name:b"], "allow");
  consent.revoke(id, ["name:a", "name:b"]);
  assert.equal(consent.decisionFor(id, ["name:a"]).state, "undecided");
  assert.equal(consent.decisionFor(id, ["name:b"]).state, "undecided");
  consent.record(id, ["name:c"], "allow", { remember: true });
  consent.record(id, ["name:d"], "allow");
  consent.dropSession(id);
  assert.equal(consent.decisionFor(id, ["name:c"]).state, "allowed", "persisted survives a route teardown");
  assert.equal(consent.decisionFor(id, ["name:d"]).state, "undecided", "session decision dies with the route");
  assert.ok(fs.existsSync(path.join(dir, "consent.json")));
});

test("foreground is its own scope: record, deny, revoke, status", () => {
  freshDir();
  const id = cid();
  assert.equal(consent.foregroundDecision(id).state, "undecided");
  consent.recordForeground(id, "allow");
  assert.equal(consent.foregroundDecision(id).state, "allowed");
  consent.recordForeground(id, "deny", { remember: true });
  assert.equal(consent.foregroundDecision(id).state, "denied");
  consent.revokeForeground(id);
  assert.equal(consent.foregroundDecision(id).state, "undecided");
  const st = consent.status(id);
  assert.equal(st.foreground, null);
  assert.deepEqual(Object.keys(st.apps), []);
});

test("status merges persisted and session entries and labels their source", () => {
  freshDir();
  const id = cid();
  consent.record(id, ["name:persisted-app"], "allow", { remember: true, name: "Persisted App" });
  consent.record(id, ["name:session-app"], "deny", { name: "Session App" });
  consent.recordForeground(id, "allow");
  const st = consent.status(id);
  assert.equal(st.apps["name:persisted-app"].source, "persisted");
  assert.equal(st.apps["name:session-app"].source, "session");
  assert.equal(st.apps["name:session-app"].decision, "deny");
  assert.equal(st.foreground.state, "allowed");
});

// ---------- wire: the gate, over the real server ----------

async function boot(t, env = {}, { hostKeys = true, attested = true, elicitation = null } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-consent-srv-"));
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-consent-rec-"));
  const child = spawn("node", ["--import", FAKE_OSASCRIPT, path.join(ROOT, "mcp", "server.mjs")], {
    env: { ...process.env, CODEWHALE_CU_NATIVE_PROMPT: "", CODEWHALE_CU_STATE_DIR: stateDir, CODEWHALE_CU_RECORDINGS_DIR: recDir, CODEWHALE_CU_APP: "off", CODEWHALE_CU_TEST_BACKEND: path.join(ROOT, "tests", "fixtures", "fake-backend.mjs"), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (hostKeys) child.stdin.write(hostKeysLine());
  t.after(() => { try { child.stdin.end(); } catch {} child.kill("SIGTERM"); fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(recDir, { recursive: true, force: true }); });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === "elicitation/create" && elicitation) {
        if (typeof elicitation === "function") elicitation(msg);
        else child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { action: elicitation } }) + "\n");
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const rpc = (method, params, timeoutMs = 20_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: attested ? attestParams(method, params) : params }) + "\n");
    });
  };
  const tool = async (name, args = {}, timeoutMs) => JSON.parse((await rpc("tools/call", { name, arguments: args }, timeoutMs)).result.content[0].text);
  const send = (params) => rpc("tools/call", params).then((r) => JSON.parse(r.result.content[0].text));
  const sendWire = message => child.stdin.write(JSON.stringify(message) + "\n");
  return { rpc, tool, send, sendWire, stateDir };
}

test("first app contact refuses consent_required before any backend work", async (t) => {
  const s = await boot(t);
  const r = await s.tool("open_application", { name: "FakeApp" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "consent_required");
  assert.match(r.error.message, /consent \{action:"allow"\|"deny"/);
  const st = await s.tool("consent", { action: "status" });
  assert.equal(st.ok, true);
  assert.deepEqual(st.apps, {});
});

test("a deny cannot be sidestepped by re-spelling the same app", async (t) => {
  const s = await boot(t);
  // The recording backend resolves the alias without opening a real app.
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const opened = await s.tool("open_application", { name: "FakeApp" });
  assert.equal(opened.ok, true);
  const denied = await s.tool("consent", { action: "deny", app: "FakeApp" });
  assert.equal(denied.ok, true);
  assert.equal(denied.decision, "deny");
  for (const args of [{ name: "FakeApp" }, { bundle_id: "com.fake.app" }, { name: "FakeApp.app" }]) {
    const r = await s.tool("open_application", args);
    assert.equal(r.error?.code, "app_denied", JSON.stringify(args));
  }
  // A destructive tool honors the same deny — it cannot terminate the app.
  const kill = await s.tool("kill_app", { name: "FakeApp" });
  assert.equal(kill.error?.code, "app_denied");
});

test("app approval covers activate:true; explicit foreground denial still wins", async (t) => {
  const s = await boot(t);
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const fg = await s.tool("open_application", { name: "FakeApp", activate: true });
  assert.equal(fg.ok, true, JSON.stringify(fg));
  assert.equal((await s.tool("consent", { action: "status" })).foreground, null);
  const deniedFg = await s.tool("consent", { action: "deny", scope: "foreground" });
  assert.equal(deniedFg.scope, "foreground");
  const again = await s.tool("open_application", { name: "FakeApp", activate: true });
  assert.equal(again.error?.code, "foreground_denied");
  const deniedBg = await s.tool("open_application", { name: "FakeApp", activate: false });
  assert.equal(deniedBg.ok, true);
  await s.tool("consent", { action: "revoke", scope: "foreground" });
  const opened = await s.tool("open_application", { name: "FakeApp", activate: true });
  assert.equal(opened.ok, true);
  assert.equal(opened.shared_pointer, true);
  // Background re-open needs no foreground consent — the bound app carries it.
  const bg = await s.tool("open_application", { name: "FakeApp", activate: false });
  assert.equal(bg.ok, true);
});

test("foreground app approval stays scoped to the target on every local platform", async (t) => {
  const s = await boot(t, { CODEWHALE_CU_TEST_BACKEND: path.join(ROOT, "tests", "fixtures", "fake-backend.mjs") });
  await s.tool("consent", { action: "allow", app: "FakeApp" });
  const fg = await s.tool("open_application", { name: "FakeApp", activate: true });
  assert.equal(fg.ok, true, JSON.stringify(fg));
  const other = await s.tool("open_application", { name: "OtherApp", activate: true });
  assert.equal(other.error?.code, "consent_required");
  const unnamed = await s.tool("open_application", { activate: true });
  assert.equal(unnamed.error?.code, "consent_required");
  const opened = await s.tool("open_application", { name: "FakeApp", activate: true });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.shared_pointer, true);
  await s.tool("consent", { action: "revoke", app: "FakeApp" });
  const revoked = await s.tool("open_application", { name: "FakeApp", activate: true });
  assert.equal(revoked.error?.code, "consent_required");
});

test("remember:true persists; consent status shows the ledger", async (t) => {
  const s = await boot(t);
  const r = await s.tool("consent", { action: "allow", app: "Finder", remember: true });
  assert.equal(r.persisted, true);
  const file = JSON.parse(fs.readFileSync(path.join(s.stateDir, "consent.json"), "utf8"));
  assert.equal(file.computers.local.apps["name:finder"].decision, "allow");
  const st = await s.tool("consent", { action: "status" });
  assert.equal(st.apps["name:finder"].source, "persisted");
  const revoked = await s.tool("consent", { action: "revoke", app: "Finder" });
  assert.equal(revoked.ok, true);
  assert.equal(consent.decisionFor("local", ["name:finder"]).state, "undecided");
});

test("remote computers are covered by the transport, not the app ledger", async (t) => {
  const s = await boot(t);
  const reg = await s.tool("computer", { action: "register", id: "faraway", transport: "ssh", host: "192.0.2.1", installAgent: false });
  assert.equal(reg.ok, true);
  const st = await s.tool("consent", { action: "status", computer: "faraway" });
  assert.equal(st.ok, true);
  // open_application may fail at transport level — never at consent.
  const r = await s.tool("open_application", { name: "x", computer: "faraway" }, 40_000);
  assert.notEqual(r.error?.code, "consent_required");
  assert.notEqual(r.error?.code, "app_denied");
});

test("spawned computers are task-owned — the app ledger never gates them", { skip: NEED_DOCKER.skip }, async (t) => {
  const s = await boot(t);
  const id = `consent-${Date.now()}`;
  const spawned = await s.tool("computer", { action: "spawn", id, transport: "docker" }, 60_000);
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const r = await s.tool("open_application", { name: "xterm" });
  assert.notEqual(r.error?.code, "consent_required", "an owned computer must never consult the user's app ledger");
  const st = await s.tool("consent", { action: "status", computer: id });
  assert.equal(st.ok, true);
});

// ---------- the user's own decision ----------

test("consent allow without a host decision is refused", async (t) => {
  const s = await boot(t, {}, { attested: false });
  const r = await s.tool("consent", { action: "allow", app: "FakeApp" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "consent_needs_user");
  for (const [name, args] of [["consent_allow", { app: "FakeApp" }], ["consent", { action: "revoke", app: "FakeApp" }], ["app_script", { script: "return 1" }], ["computer_register", { computer: "box", transport: "local" }]]) {
    const refused = await s.tool(name, args);
    assert.equal(refused.error?.code, "consent_needs_user", name);
  }
  // Narrowing needs no decision.
  assert.equal((await s.tool("consent", { action: "deny", app: "OtherApp" })).ok, true);
  const opened = await s.tool("open_application", { name: "FakeApp" });
  assert.equal(opened.error?.code, "consent_required");
});

test("consent allow with a valid decision MAC succeeds; replayed nonce is refused", async (t) => {
  const s = await boot(t, {}, { attested: false });
  const params = attest({ name: "consent", arguments: { action: "allow", app: "FakeApp" } });
  assert.equal((await s.send(params)).ok, true);
  const replayed = await s.send(params);
  assert.equal(replayed.error?.code, "consent_needs_user");
  // A MAC for other arguments does not cover these.
  const forged = attest({ name: "consent", arguments: { action: "allow", app: "OtherApp" } });
  forged.arguments = { action: "allow", app: "Terminal" };
  assert.equal((await s.send(forged)).error?.code, "consent_needs_user");
  // A MAC under another key does not verify.
  const wrongKey = attest({ name: "consent", arguments: { action: "allow", app: "Terminal" } }, "33".repeat(32));
  assert.equal((await s.send(wrongKey)).error?.code, "consent_needs_user");
});

test("a decision is refused when the host sent no key, and keys are read only from the first message", async (t) => {
  const s = await boot(t, {}, { hostKeys: false });
  // Keys arriving after the first message are ignored.
  await s.rpc("ping", {});
  const late = await s.rpc("codewhale/host_keys", { decision_key: "11".repeat(32) }, 300).catch(() => null);
  void late;
  const r = await s.tool("consent", { action: "allow", app: "FakeApp" });
  assert.equal(r.error?.code, "consent_needs_user");
});

test("a client with elicitation decides for other hosts", async (t) => {
  for (const [answer, ok] of [["accept", true], ["decline", false]]) {
    const s = await boot(t, {}, { hostKeys: false, attested: false, elicitation: answer });
    await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } });
    const r = await s.tool("consent", { action: "allow", app: "FakeApp" });
    assert.equal(r.ok, ok, `${answer}: ${JSON.stringify(r)}`);
    if (!ok) assert.equal(r.error.code, "consent_declined");
  }
});

test("planted consent.json allow entry without MAC is ignored; deny is honored", () => {
  const dir = freshDir();
  const id = cid();
  const at = new Date().toISOString();
  const good = { decision: "allow", at };
  fs.writeFileSync(path.join(dir, "consent.json"), JSON.stringify({ version: 1, computers: { [id]: {
    apps: {
      "name:planted": { decision: "allow", at },
      "name:forged": { decision: "allow", at, mac: "00".repeat(32) },
      "name:signed": { ...good, mac: ledgerMac(id, "name:signed", good) },
      "name:blocked": { decision: "deny", at },
    },
    foreground: { decision: "allow", at },
  } } }));
  assert.equal(consent.decisionFor(id, ["name:planted"]).state, "undecided");
  assert.equal(consent.decisionFor(id, ["name:forged"]).state, "undecided");
  assert.equal(consent.decisionFor(id, ["name:signed"]).state, "allowed");
  assert.equal(consent.decisionFor(id, ["name:blocked"]).state, "denied");
  assert.equal(consent.foregroundDecision(id).state, "undecided");
});

test("confirm token requires a host decision", async (t) => {
  const s = await boot(t, {}, { attested: false });
  const r = await s.tool("consent", { action: "allow", confirm: "confirm-000000000000000000" });
  assert.equal(r.error?.code, "consent_needs_user");
});

test("run_actions app_script step needs a host decision", async (t) => {
  const s = await boot(t);
  const r = await s.tool("run_actions", { steps: [{ tool: "app_script", arguments: { script: "return 1" } }] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "consent_needs_user");
});


test("cancelled user elicitation releases dispatch and cannot grant consent later", async (t) => {
  let sawPrompt;
  const prompt = new Promise(resolve => { sawPrompt = resolve; });
  const s = await boot(t, {}, { hostKeys: false, attested: false, elicitation: sawPrompt });
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } });
  s.sendWire({ jsonrpc: "2.0", id: "cancelled-consent", method: "tools/call", params: { name: "consent", arguments: { action: "allow", app: "FakeApp" } } });
  const request = await Promise.race([prompt, new Promise((_, reject) => setTimeout(() => reject(new Error("elicitation was not shown")), 2_000))]);
  s.sendWire({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancelled-consent" } });
  // The unanswered card no longer holds the serialized tool queue.
  const before = await s.tool("consent", { action: "status" }, 1_000);
  assert.deepEqual(before.apps, {});
  s.sendWire({ jsonrpc: "2.0", id: request.id, result: { action: "accept" } });
  const after = await s.tool("consent", { action: "status" }, 1_000);
  assert.deepEqual(after.apps, {}, "a late accept cannot grant the cancelled request");
});

// ---------- Option A: daemon consent controller & socket enforcement ----------

test("daemon consent controller: capability gating, prompt push shape/sanitation, and decision matrix", async () => {
  freshDir();
  consent.dropSession("local");
  let monoNow = 10_000;
  let wallNow = 1_700_000_000_000;
  const states = [];
  const timers = [];
  const runningApps = [
    { name: "Notes\u202e\nApp", bundle_id: "com.apple.Notes", pid: 777 },
  ];
  let ctl;
  ctl = createConsentController({
    now: () => monoNow,
    epochNow: () => wallNow,
    schedule: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearSchedule: (t) => { if (t) t.cleared = true; },
    onStateChange: () => states.push(ctl.activePromptPayload()),
    resolveApp: (ref) => resolveConsentApp(ref, { listApps: async () => runningApps }),
  });

  // Before capabilities: helperConsent is false, requests refuse consent_needs_user, decisions are ignored.
  assert.equal(ctl.helperConsent, false);
  const preCap = await ctl.request({ kind: "allow_app", app: { name: "Notes\u202e\nApp" } });
  assert.equal(preCap.ok, false);
  assert.equal(preCap.error.code, "consent_needs_user");
  ctl.handleControlMessage({ command: "consent_decision", consent: "0".repeat(32), decision: "allow", auth: "local" });
  assert.equal(consent.anyAllowed("local"), false);

  // Announce capabilities.
  const capRes = ctl.handleControlMessage({ command: "capabilities", consent: 1 });
  assert.deepEqual(capRes, { handled: true, sendStatus: true });
  assert.equal(ctl.helperConsent, true);

  // Request allow_app -> pushes sanitized prompt state.
  const reqPromise = ctl.request({ kind: "allow_app", app: { pid: 777 } });
  await new Promise((r) => setImmediate(r));
  const pushed = ctl.activePromptPayload();
  assert.ok(pushed, "prompt must be active");
  assert.match(pushed.id, /^[0-9a-f]{32}$/);
  assert.equal(pushed.expiresAt, wallNow + 120_000);
  assert.ok(pushed.headline.length <= 240 && !/[\r\n\u202e]/.test(pushed.headline));
  assert.ok(pushed.reason.length <= 90 && !/[\r\n\u202e]/.test(pushed.reason));
  assert.ok(Array.isArray(pushed.lines) && pushed.lines.length <= 8);
  assert.ok(pushed.lines.some((l) => l.includes("\\u202e") || l.includes("\\n")), "control/bidi chars in app name are visibly escaped");

  // Decision with wrong id is ignored.
  ctl.handleControlMessage({ command: "consent_decision", consent: "f".repeat(32), decision: "allow", auth: "local" });
  assert.ok(ctl.activePromptPayload(), "wrong id must not close the active prompt");

  // Decision with allow but auth !== "local" is treated as deny.
  for (const badAuth of ["none", "failed", "expired", undefined]) {
    const p = ctl.activePromptPayload() ? reqPromise : ctl.request({ kind: "allow_app", app: { pid: 777 } });
    await new Promise((r) => setImmediate(r));
    const cur = ctl.activePromptPayload();
    ctl.handleControlMessage({ command: "consent_decision", consent: cur.id, decision: "allow", auth: badAuth });
    const res = await p;
    assert.equal(res.ok, false, `auth=${badAuth} must decline`);
    assert.equal(res.error.code, "consent_declined");
    assert.equal(ctl.activePromptPayload(), null);
    assert.equal(consent.anyAllowed("local"), false);
    monoNow += 65_000;
  }

  // Expired prompt declines even if helper sends allow + local.
  const expPromise = ctl.request({ kind: "allow_app", app: { pid: 777 } });
  await new Promise((r) => setImmediate(r));
  const expPrompt = ctl.activePromptPayload();
  wallNow = expPrompt.expiresAt;
  ctl.handleControlMessage({ command: "consent_decision", consent: expPrompt.id, decision: "allow", auth: "local" });
  const expRes = await expPromise;
  assert.equal(expRes.ok, false);
  assert.equal(expRes.error.code, "consent_declined");
  assert.equal(consent.anyAllowed("local"), false);
  monoNow += 65_000;

  // Valid allow + auth: "local" grants session allow; second decision on same id is ignored.
  const okPromise = ctl.request({ kind: "allow_app", app: { pid: 777 } });
  await new Promise((r) => setImmediate(r));
  const okPrompt = ctl.activePromptPayload();
  ctl.handleControlMessage({ command: "consent_decision", consent: okPrompt.id, decision: "allow", auth: "local" });
  const okRes = await okPromise;
  assert.equal(okRes.ok, true);
  assert.equal(okRes.decision, "allow");
  assert.equal(consent.decisionFor("local", ["bundle:com.apple.notes"]).state, "allowed");
  assert.equal(consent.decisionFor("local", ["pid:777"]).state, "allowed");
  // Replay with deny on the already-answered id does nothing.
  ctl.handleControlMessage({ command: "consent_decision", consent: okPrompt.id, decision: "deny", auth: "none" });
  assert.equal(consent.decisionFor("local", ["bundle:com.apple.notes"]).state, "allowed");
  consent.dropSession("local");
});

test("daemon consent controller: single-flight, 2s gap, and 5/min rate limit", async () => {
  freshDir();
  consent.dropSession("local");
  let monoNow = 100_000;
  let wallNow = 1_700_000_000_000;
  const ctl = createConsentController({
    now: () => monoNow,
    epochNow: () => wallNow,
    schedule: () => ({}),
    clearSchedule: () => {},
    resolveApp: async () => ({ resolved: { name: "Calc", bundle_id: "com.apple.calculator", pid: 501 }, keys: ["bundle:com.apple.calculator", "name:calc", "pid:501"] }),
  });
  ctl.handleControlMessage({ command: "capabilities", consent: 1 });

  // Single-flight: second request while first is open gets consent_pending.
  const first = ctl.request({ kind: "allow_foreground" });
  await new Promise((r) => setImmediate(r));
  const concurrent = await ctl.request({ kind: "allow_foreground" });
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.error.code, "consent_pending");

  // Answer first -> 2s gap blocks immediate follow-up even after an allow.
  ctl.handleControlMessage({ command: "consent_decision", consent: ctl.activePromptPayload().id, decision: "allow", auth: "local" });
  assert.equal((await first).ok, true);
  monoNow += 1_000;
  const duringGap = await ctl.request({ kind: "allow_foreground" });
  assert.equal(duringGap.ok, false);
  assert.equal(duringGap.error.code, "consent_rate_limited");
  assert.equal(duringGap.error.retry_after_s, 1);

  // 4 more prompts at +2.5s intervals succeed (total 5 in the minute); the 6th is rate-limited.
  for (let i = 1; i < 5; i++) {
    monoNow += 2_500;
    const p = ctl.request({ kind: "allow_foreground" });
    await new Promise((r) => setImmediate(r));
    ctl.handleControlMessage({ command: "consent_decision", consent: ctl.activePromptPayload().id, decision: "deny", auth: "none" });
    assert.equal((await p).error.code, "consent_declined");
  }
  monoNow += 2_500;
  const sixth = await ctl.request({ kind: "allow_foreground" });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.error.code, "consent_rate_limited");
  assert.ok(sixth.error.retry_after_s >= 1);

  // Once a full minute has passed since the first prompt, a new prompt is allowed.
  monoNow += 60_000;
  const afterWindow = ctl.request({ kind: "allow_foreground" });
  await new Promise((r) => setImmediate(r));
  assert.ok(ctl.activePromptPayload());
  ctl.handleControlMessage({ command: "consent_decision", consent: ctl.activePromptPayload().id, decision: "deny", auth: "none" });
  await afterWindow;
  consent.dropSession("local");
});

test("daemon consent controller: identity ambiguity refusal and app_script token binding", async () => {
  freshDir();
  consent.dropSession("local");
  const apps = [
    { name: "Safari", bundle_id: "com.apple.Safari", pid: 101 },
    { name: "Mail", bundle_id: "com.apple.mail", pid: 102 },
    { name: "Twin", bundle_id: "com.example.twin", pid: 201 },
    { name: "Twin", bundle_id: "com.example.twin", pid: 202 },
  ];
  let monoNow = 200_000;
  const ctl = createConsentController({
    now: () => monoNow,
    epochNow: () => 1_700_000_000_000,
    schedule: () => ({}),
    clearSchedule: () => {},
    resolveApp: (ref) => resolveConsentApp(ref, { listApps: async () => apps }),
  });
  ctl.handleControlMessage({ command: "capabilities", consent: 1 });

  // Disagreed name + bundle_id, duplicate running app without pid, and missing app all refuse consent_identity_ambiguous.
  for (const badApp of [
    { name: "Safari", bundle_id: "com.apple.mail" },
    { name: "Safari", pid: 102 },
    { name: "Twin" },
    { name: "NotRunning" },
    { pid: 9999 },
    {},
  ]) {
    const r = await ctl.request({ kind: "allow_app", app: badApp });
    assert.equal(r.ok, false, JSON.stringify(badApp));
    assert.equal(r.error.code, "consent_identity_ambiguous", JSON.stringify(badApp));
  }

  // app_script policy check runs before the prompt; invisible chars are visibly escaped; oversized scripts refuse.
  const shellEscape = await ctl.request({ kind: "app_script", script: 'do shell script "id"' });
  assert.equal(shellEscape.error?.code, "script_refused");
  const tooLong = await ctl.request({ kind: "app_script", script: `tell application "Safari" to return "${"a".repeat(1200)}"` });
  assert.equal(tooLong.error?.code, "script_too_long");

  const scriptText = 'tell application "Safari" to return "hi\u200b"';
  const scriptPromise = ctl.request({ kind: "app_script", language: "applescript", script: scriptText });
  await new Promise((r) => setImmediate(r));
  const payload = ctl.activePromptPayload();
  assert.ok(payload.lines.some((l) => /\\u200b/i.test(l)), "zero-width space must be rendered as a visible escape");
  ctl.handleControlMessage({ command: "consent_decision", consent: payload.id, decision: "allow", auth: "local" });
  const approved = await scriptPromise;
  assert.equal(approved.ok, true);
  assert.match(approved.approvalToken, /^[0-9a-f]{32}$/);

  // Token is bound to language + script, single-use, and expires after 60s.
  assert.equal(consumeAppScriptToken(approved.approvalToken, "javascript", scriptText, monoNow), false, "wrong language must not consume or pass");
  assert.equal(consumeAppScriptToken(approved.approvalToken, "applescript", scriptText + " ", monoNow), false, "modified script must not pass");
  assert.equal(consumeAppScriptToken(approved.approvalToken, "applescript", scriptText, monoNow), true, "exact match passes once");
  assert.equal(consumeAppScriptToken(approved.approvalToken, "applescript", scriptText, monoNow), false, "replayed token is refused");

  const expiring = issueAppScriptToken("applescript", 'return "ttl"', 1_000);
  assert.equal(consumeAppScriptToken(expiring, "applescript", 'return "ttl"', 61_001), false, "expired token is refused");
  consent.dropSession("local");
});

test("daemon socket attack test: unconsented client cannot act, model-style consent_request cannot self-approve, and mid-session revoke/deny is enforced", { timeout: 20_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "daemon-attack-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\cu-attack-${process.pid}-${Date.now()}`
    : path.join(dir, "app.sock");
  const callsFile = path.join(dir, "backend-calls.jsonl");
  const stateFile = path.join(dir, "backend-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    apps: [{ name: "FakeApp", pid: 4242, bundle_id: "com.fake.app", frontmost: true }],
  }));

  const env = {
    ...process.env,
    CODEWHALE_CU_STATE_DIR: dir,
    CODEWHALE_CU_APP_SOCKET: endpoint,
    CODEWHALE_CU_APP_WARM: "off",
    CODEWHALE_CU_TEST_BACKEND: path.join(ROOT, "tests", "fixtures", "fake-backend.mjs"),
    FAKE_BACKEND_CALLS: callsFile,
    FAKE_BACKEND_STATE: stateFile,
    CODEWHALE_CU_CONTROL_FD: "3",
  };
  delete env.CODEWHALE_CU_APP;
  delete env.CODEWHALE_CU_NATIVE_PROMPT;

  const prevStateDir = process.env.CODEWHALE_CU_STATE_DIR;
  const prevSocket = process.env.CODEWHALE_CU_APP_SOCKET;
  process.env.CODEWHALE_CU_STATE_DIR = dir;
  process.env.CODEWHALE_CU_APP_SOCKET = endpoint;

  const daemon = spawn(process.execPath, [path.join(ROOT, "app", "daemon.mjs")], {
    env,
    stdio: ["ignore", "ignore", "pipe", "overlapped"],
  });
  let daemonErr = "";
  daemon.stderr.on("data", (c) => { daemonErr += c; });
  const control = daemon.stdio[3];
  control.setEncoding("utf8");
  let controlBuf = "";
  const controlStates = [];
  control.on("data", (chunk) => {
    controlBuf += chunk;
    let nl;
    while ((nl = controlBuf.indexOf("\n")) !== -1) {
      const line = controlBuf.slice(0, nl).trim();
      controlBuf = controlBuf.slice(nl + 1);
      if (line) controlStates.push(JSON.parse(line));
    }
  });

  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.destroy();
    control.destroy();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exit = new Promise((r) => daemon.once("exit", r));
      daemon.kill("SIGTERM");
      await exit;
    }
    if (prevStateDir === undefined) delete process.env.CODEWHALE_CU_STATE_DIR;
    else process.env.CODEWHALE_CU_STATE_DIR = prevStateDir;
    if (prevSocket === undefined) delete process.env.CODEWHALE_CU_APP_SOCKET;
    else process.env.CODEWHALE_CU_APP_SOCKET = prevSocket;
  });

  const waitUntil = async (pred, label = "condition") => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timed out waiting for ${label}: ${daemonErr}`);
  };
  await waitUntil(async () => !!(await hello({ timeoutMs: 150 })), "daemon hello");

  // 1. Old-helper fallback: before capabilities, consentProtocol is 0 and MCP server refuses with update hint.
  const infoBefore = await hello();
  assert.equal(infoBefore.controlProtocol, 2);
  assert.equal(infoBefore.consentProtocol, 0);
  const sOld = await boot(t, { CODEWHALE_CU_STATE_DIR: dir, CODEWHALE_CU_APP_SOCKET: endpoint, CODEWHALE_CU_APP: "on" }, { hostKeys: false, attested: false });
  const oldRefusal = await sOld.tool("consent", { action: "allow", app: "FakeApp" });
  assert.equal(oldRefusal.ok, false);
  assert.equal(oldRefusal.error.code, "consent_needs_user");
  assert.match(oldRefusal.error.message, /Update and restart the Codewhale Computer Use app/);

  // 2. Helper announces consent capability on fd 3.
  control.write(JSON.stringify({ id: 1, command: "capabilities", consent: 1 }) + "\n");
  await waitUntil(async () => (await hello())?.consentProtocol === 1, "consentProtocol === 1");

  // 3. Attack test: a second app-socket client opens its own session lease with no allow.
  const attackerSession = "attacker-client";
  const opened = await appRequest({ tool: "open_session", sessionId: attackerSession }, { keepOpen: true });
  sockets.push(opened.socket);
  const attackerToken = opened.reply.leaseToken;
  const attackCall = (tool, args = {}) => appRequest({ tool, args, sessionId: attackerSession, leaseToken: attackerToken });

  for (const [tool, args] of [
    ["open_application", { name: "FakeApp" }],
    ["get_app_state", { app_ref: { name: "FakeApp" } }],
    ["list_windows", { app_ref: { pid: 4242 } }],
    ["left_click", { target: { type: "element", index: 1, path: [0, 1], app_ref: { name: "FakeApp" } } }],
    ["left_click", { target: { type: "element", index: 1, path: [0, 1] } }],
    ["screenshot", {}],
    ["app_script", { script: 'tell application "FakeApp" to return "pwn"' }],
    ["app_script", { script: 'tell application "FakeApp" to return "pwn"', approvalToken: "0".repeat(32) }],
  ]) {
    const r = await attackCall(tool, args);
    assert.equal(r.ok, false, `attacker ${tool} must fail: ${JSON.stringify(r)}`);
    assert.equal(r.error.code, "consent_required", `attacker ${tool} must refuse consent_required: ${JSON.stringify(r)}`);
  }

  // Attacker sends a model-style consent_request that nobody answers on fd 3, and cannot self-approve over app.sock.
  const forgedDecision = await attackCall("consent_decision", { consent: "0".repeat(32), decision: "allow", auth: "local" });
  assert.equal(forgedDecision.ok, false);
  assert.equal(forgedDecision.error.code, "tool_not_allowed");

  const abortUnanswered = new AbortController();
  const unanswered = appRequest({ tool: "consent_request", kind: "allow_app", app: { name: "FakeApp" } }, { signal: abortUnanswered.signal }).catch((e) => e);
  await waitUntil(() => controlStates.some((st) => st.consent?.id), "prompt pushed to fd 3");

  // While the unanswered prompt is open, attacker actions get consent_pending.
  const whilePending = await attackCall("open_application", { name: "FakeApp" });
  assert.equal(whilePending.ok, false);
  assert.equal(whilePending.error.code, "consent_pending");

  // Cancel the unanswered request and wait out the 2s gap; attacker still has no allow.
  abortUnanswered.abort();
  await unanswered;
  await waitUntil(() => controlStates.at(-1)?.consent === null, "prompt cleared on abort");
  for (const [tool, args] of [
    ["open_application", { name: "FakeApp" }],
    ["get_app_state", { app_ref: { name: "FakeApp" } }],
    ["screenshot", {}],
    ["app_script", { script: 'tell application "FakeApp" to return "pwn"' }],
  ]) {
    const r = await attackCall(tool, args);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "consent_required", `after unanswered consent_request, ${tool} must still refuse consent_required`);
  }

  // 4. Legitimate approval through the helper control channel, followed by mid-session revoke and deny enforcement.
  await new Promise((r) => setTimeout(r, 2_100));
  const allowPromise = sOld.tool("consent", { action: "allow", app: "FakeApp" });
  await waitUntil(() => controlStates.at(-1)?.consent?.id, "MCP allow prompt pushed");
  const promptId = controlStates.at(-1).consent.id;
  control.write(JSON.stringify({ command: "consent_decision", consent: promptId, decision: "allow", auth: "local" }) + "\n");
  const allowReceipt = await allowPromise;
  assert.equal(allowReceipt.ok, true, JSON.stringify(allowReceipt));
  assert.equal(allowReceipt.persisted, false, "daemon-granted allows are session-only");

  assert.equal((await sOld.tool("open_application", { name: "FakeApp" })).ok, true);
  assert.equal((await sOld.tool("get_app_state", { app_ref: { name: "FakeApp" } })).ok, true);
  assert.equal((await sOld.tool("screenshot", {})).ok, true);

  // Mid-session revoke removes the allow in the daemon too.
  const revoked = await sOld.tool("consent", { action: "revoke", app: "FakeApp" });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  const afterRevoke = await attackCall("get_app_state", { app_ref: { name: "FakeApp" } });
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.error.code, "consent_required");

  // Mid-session deny blocks the app in the daemon with app_denied.
  const denied = await sOld.tool("consent", { action: "deny", app: "FakeApp" });
  assert.equal(denied.ok, true, JSON.stringify(denied));
  const afterDeny = await attackCall("open_application", { name: "FakeApp" });
  assert.equal(afterDeny.ok, false);
  assert.equal(afterDeny.error.code, "app_denied");
});

