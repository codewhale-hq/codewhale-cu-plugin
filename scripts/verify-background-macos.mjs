#!/usr/bin/env node
// A disposable AppKit app behind the user's work; effects come from its own
// oracle, foreground/pointer samples from an independent observer with a 10 ms polling interval.
// After human approval, the default trial has no activation, shared pointer input, recording, or user app cleanup.
// --switch-mid-action adds a SEPARATE trial that intentionally activates an
// owned decoy while a process-directed held key is pending on the target.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import crypto from "node:crypto";

if (process.platform !== "darwin") throw new Error("macOS is required");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bundleAt = process.argv.indexOf("--bundle");
const bundle = bundleAt >= 0 ? path.resolve(process.argv[bundleAt + 1]) : null;
const switchMidAction = process.argv.includes("--switch-mid-action");
const installedHelper = process.argv.includes("--installed-helper");
const persistentHost = process.argv.includes("--persistent-host");
const waitForRevoke = process.argv.includes("--wait-for-revoke");
if (installedHelper && !bundle) throw new Error("--installed-helper requires --bundle with the installed app path");
if (waitForRevoke && !persistentHost) throw new Error("--wait-for-revoke requires --persistent-host");
const hostLedgerKey = persistentHost ? crypto.randomBytes(32) : null;
const root = bundle ? path.join(bundle, "Contents", "Resources", "plugin") : repoRoot;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cu-background-"));
const outAt = process.argv.indexOf("--out");
const output = outAt >= 0 ? path.resolve(process.argv[outAt + 1]) : path.join(scratch, "receipt.json");
const receipt = { source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  sourceHashes: Object.fromEntries(["mcp/server.mjs", "src/backends/darwin.mjs", "src/backends/darwin-accessibility.m"].map(rel=>[rel,crypto.createHash("sha256").update(fs.readFileSync(path.join(root,rel))).digest("hex")])),
  startedAt: new Date().toISOString(), route: installedHelper ? "installed-helper-mcp" : bundle ? "packaged-daemon-mcp" : "source-installed-helper-mcp", approvalScope: persistentHost ? "host" : "connection", persistenceVerified: false, checks: [], consents: [], actions: [], samples: [] };
if (hostLedgerKey) {
  const seed = Buffer.from(crypto.hkdfSync("sha256", hostLedgerKey, Buffer.alloc(0), "net.codewhale.computer-use.host.v1", 32));
  const encoded = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const publicKey = crypto.createPublicKey(crypto.createPrivateKey({ key: encoded, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  seed.fill(0); encoded.fill(0);
  receipt.pairing = { label: "Codewhale release check", fingerprint: crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16), helperKeyLabel: publicKey.toString("base64").slice(44, 56), cleanupRequired: false };
}
const children = [];
const ownedApps = [];
const clients = [];
let persistentApproved = false;
let helperProcess = null;
let sampling = true;
const start = (cmd, args, options) => { const child = spawn(cmd, args, options); children.push(child); return child; };
const compile = (source, name) => {
  const bin = path.join(scratch, name);
  execFileSync("clang", ["-fobjc-arc", "-Os", "-framework", "Cocoa", "-framework", "ApplicationServices", path.join(repoRoot, source), "-o", bin]);
  return bin;
};
async function until(read, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { const result = read(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
const parseLines = (stream, consume) => {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => { buffer += chunk; let at;
    while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) consume(JSON.parse(line)); }
  });
};
try {
  const probe = start(compile("parity/darwin-probe.m", "probe"), ["--watch"], { stdio: ["ignore", "pipe", "inherit"] });
  parseLines(probe.stdout, sample => { if (sampling) receipt.samples.push(sample); });
  let initial = await until(() => {
    if(probe.exitCode !== null || probe.signalCode !== null) throw new Error(`Desktop observer exited: ${probe.signalCode ?? probe.exitCode}`);
    return receipt.samples[0];
  }, "desktop observer");
  const fixtureBinary = compile("parity/fixtures/native-macos.m", "fixture");
  const oracleFile = path.join(scratch, "state.json");
  const oracle = () => { try { return JSON.parse(fs.readFileSync(oracleFile, "utf8")); } catch { return null; } };
  const env = { ...process.env, CODEWHALE_CU_APP: "on", CODEWHALE_CU_STATE_DIR: path.join(scratch, "state"), CODEWHALE_CU_RECORDINGS_DIR: scratch, CODEWHALE_CU_APP_WARM: "off" };
  delete env.CODEWHALE_CU_APP_SOCKET;
  delete env.CODEWHALE_CU_TEST_BACKEND;
  delete env.CODEWHALE_CU_TEST_REMOTE;
  delete env.CODEWHALE_CU_APP_BUNDLE;
  if (installedHelper || !bundle) {
    const { hello } = await import(pathToFileURL(path.join(root, "src/app-socket.mjs")).href);
    const app = await hello();
    assert.equal(app?.id, "net.codewhale.computer-use", "installed helper is running");
    if (bundle) assert.equal(app.bundle, bundle, "helper is serving the specified installed bundle");
    assert.ok(app.controlProtocol >= 2, "installed helper has current human controls");
    assert.ok(app.consentProtocol >= 1, "installed helper has native consent");
    assert.ok(app.hostTrustProtocol >= 1, "installed helper supports host trust");
    env.CODEWHALE_CU_APP_SOCKET = app.socket;
    receipt.helper = app;
  } else if (bundle) {
    env.CODEWHALE_CU_APP_BUNDLE = bundle;
    helperProcess = start(path.join(bundle, "Contents", "MacOS", "codewhale-cu"), [], { env, stdio: ["ignore", "ignore", "inherit"] });
    receipt.helper = await until(() => {
      try {
        const app = JSON.parse(fs.readFileSync(path.join(env.CODEWHALE_CU_STATE_DIR, "app-run.json"), "utf8"));
        return app.consentProtocol >= 1 && app.controlProtocol >= 2 && app.hostTrustProtocol >= 1 ? app : null;
      } catch { return null; }
    }, "isolated packaged helper with native host trust");
  }
  const startClient = async trial => {
    const server = start(process.execPath, [path.join(root, "mcp/server.mjs")], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let seq = 0;
    const pending = new Map();
    parseLines(server.stdout, message => pending.get(message.id)?.(message));
    if (hostLedgerKey) {
      const decisionKey = crypto.randomBytes(32);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "codewhale/host_keys", params: { decision_key: decisionKey.toString("hex"), ledger_key: hostLedgerKey.toString("hex") } }) + "\n");
      decisionKey.fill(0);
    }
    const rpc = async (method, params, timeoutMs = 70_000) => {
      const id = ++seq;
      const message = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs);
        pending.set(id, result => { clearTimeout(timeout); pending.delete(id); resolve(result); });
        server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
      assert.ok(message.result, JSON.stringify(message.error));
      return message;
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Codewhale release check", version: "1.0" } });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tool = async (name, args = {}, setupStage = null) => {
      const startedAt = new Date().toISOString();
      const sampleStart = receipt.samples.length;
      const setup = setupStage ? { trial, stage: setupStage, tool: name, startedAt, sampleStart, scope: receipt.approvalScope, persistenceVerified: receipt.persistenceVerified } : null;
      if (setup && setupStage !== "revoke-poll") receipt.consents.push(setup);
      let message;
      try { message = await rpc("tools/call", { name, arguments: args }, setupStage === "host-approval" || name === "open_application" ? 130_000 : 70_000); }
      catch (error) { if (setup) Object.assign(setup, { finishedAt: new Date().toISOString(), sampleEnd: receipt.samples.length, ok: false, error: error.message }); throw error; }
      const data = JSON.parse(message.result?.content?.find(item => item.type === "text")?.text ?? "null");
      if (setup) Object.assign(setup, { finishedAt: new Date().toISOString(), sampleEnd: receipt.samples.length, ok: data?.ok, error: data?.error, ...(data?.host ? { host: data.host } : {}) });
      else if (!["get_app_state", "screenshot"].includes(name)) receipt.actions.push({ trial, name, data });
      assert.ok(data?.ok, `${name}: ${JSON.stringify(data ?? message.error)}`);
      return data;
    };
    tool.close = async () => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { server.kill("SIGKILL"); reject(new Error("MCP connection did not close cleanly")); }, 5_000);
        server.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`MCP connection exited: ${signal ?? code}`)); });
        server.stdin.end();
      });
    };
    clients.push(tool);
    const before = await tool("consent_status", {}, "host-status-before");
    const savedApproval = persistentHost && persistentApproved;
    assert.equal(before.host?.trusted, savedApproval, savedApproval ? "the new MCP connection finds the saved host approval before requesting content" : "the fresh connection starts without approval");
    assert.equal(before.host?.persisted, savedApproval, savedApproval ? "the helper retained the host approval" : "this pairing has no saved approval");
    if (!savedApproval) process.stderr.write(`Approve Codewhale release check in the native Computer Use panel for the ${trial} ${persistentHost ? "Trust until revoked" : "connection-only"} trial.\n`);
    if (persistentHost) receipt.pairing.cleanupRequired = true;
    await tool("list_apps", { all: true }, savedApproval ? "stored-trust-content" : "host-approval");
    const approval = await tool("consent_status", {}, "host-status-after");
    assert.equal(approval.host?.trusted, true, "the helper records the real native approval");
    assert.equal(approval.host?.persisted, persistentHost, persistentHost ? "the helper persisted the user-approved pairing" : "this run does not verify persistent trust");
    if (persistentHost) { persistentApproved = true; receipt.pairing.cleanupRequired = true; }
    return tool;
  };
  const tool = await startClient("no-interference");
  const observe = () => tool("get_app_state"); // must stay on the bound background app
  const target = (state, predicate) => {
    const element = state.elements.find(predicate);
    assert.ok(element, "expected accessible control");
    return { type: "element", state_id: state.state_id, index: element.index };
  };
  let quietSince = Date.now();
  let lastSample = receipt.samples.at(-1);
  await until(() => {
    const current = receipt.samples.at(-1);
    if (!current || current.frontmost_pid !== lastSample?.frontmost_pid || current.pointer.x !== lastSample?.pointer.x || current.pointer.y !== lastSample?.pointer.y) quietSince = Date.now();
    lastSample = current;
    return Date.now() - quietSince >= 2_100;
  }, "desktop is still after native approval");
  receipt.sampleStart = receipt.samples.length;
  initial = await until(() => receipt.samples[receipt.sampleStart], "post-approval desktop observer");
  const fixture = start(fixtureBinary, [oracleFile, "--background"], { stdio: "ignore" });
  await until(() => oracle()?.origin, "background fixture");
  receipt.targetPid = fixture.pid;
  assert.notEqual(initial.frontmost_pid, fixture.pid, "the fixture remains in the background after approval");
  await tool("open_application", { pid: fixture.pid, activate: false });
  let state = await observe();
  assert.equal(state.pid, fixture.pid);
  receipt.checks.push("unqualified observation follows the selected background app");
  await tool("left_click", { target: target(state, e => e.role === "AXTextField" && e.value === "") });
  await tool("type", { text: "Background café 🐋" });
  await until(() => oracle()?.entry === "Background café 🐋", "Unicode input in target");
  state = await observe();
  await tool("left_click", { target: target(state, e => e.label === "Apply") });
  await until(() => oracle()?.applied === "Background café 🐋", "Apply button effect");
  receipt.checks.push("background field focus, Unicode typing and Apply button confirmed by fixture file");
  state = await observe();
  await tool("scroll", { target: target(state, e => e.role === "AXScrollArea"), direction: "down", amount: 5 });
  await until(() => oracle()?.scroll_top > 0, "background scroll effect");
  receipt.checks.push("background scroll confirmed by native scroll-view offset");
  state = await observe();
  const shot = await tool("screenshot"); // no app_ref: default must capture only fixture
  assert.equal(shot.app_ref.pid, fixture.pid, "capture receipt names the exact selected process");
  assert.ok(shot.points.w < initial.display.points.w, "default capture is the app window");
  receipt.checks.push("default screenshot captures the background app window");
  await tool("stop_computer_control");
  await delay(100);
  receipt.sampleEnd = receipt.samples.length;
  const observed = receipt.samples.slice(receipt.sampleStart, receipt.sampleEnd);
  const interference = observed.filter(sample => sample.frontmost_pid !== initial.frontmost_pid || sample.pointer.x !== initial.pointer.x || sample.pointer.y !== initial.pointer.y);
  receipt.sampleCount = observed.length;
  receipt.foregroundPid = initial.frontmost_pid;
  receipt.pointer = initial.pointer;
  receipt.interferenceSamples = interference.length;
  receipt.foregroundChanges = observed.filter(sample => sample.frontmost_pid !== initial.frontmost_pid).length;
  // A physical user move invalidates isolation evidence too; it is never
  // silently attributed to the agent or counted as a passing trial.
  if (interference.length === 0) receipt.checks.push("independent foreground/cursor observer saw no foreground or pointer change");
  if (switchMidAction) {
    const trial = receipt.switchMidAction = { ok: false, targetPid: fixture.pid };
    // A unique bundle lets the independent actuator verify this exact owned
    // process. AppKit/LaunchServices activation can be refused in background.
    const decoyFile = path.join(scratch, "decoy.json"), decoyBundle = path.join(scratch, "Switch Decoy.app");
    const decoyId = `net.codewhale.parity.decoy.${crypto.randomUUID()}`;
    const activateDecoy = compile("parity/fixtures/activate-macos.m", "activate-decoy");
    const decoyExecutable = path.join(decoyBundle, "Contents", "MacOS", "fixture");
    fs.mkdirSync(path.dirname(decoyExecutable), { recursive: true });
    fs.copyFileSync(fixtureBinary, decoyExecutable);
    fs.writeFileSync(path.join(decoyBundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${decoyId}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>Codewhale Switch Decoy</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
    start("open", ["-n", "-g", "-W", decoyBundle, "--args", decoyFile, "--background", "--entry", "Decoy must stay unchanged"], { stdio: "ignore" });
    const decoyState = () => { try { return JSON.parse(fs.readFileSync(decoyFile, "utf8")); } catch { return null; } };
    await until(() => decoyState()?.origin, "background decoy fixture");
    const decoy = { pid: decoyState().pid };
    assert.ok(Number.isSafeInteger(decoy.pid) && decoy.pid > 0, "owned decoy records its process identity");
    ownedApps.push(decoy.pid);
    trial.decoyPid = decoy.pid;
    const contents = value => Object.fromEntries(["entry", "applied", "menu", "selected", "keys", "keys_up", "key_down_count", "key_up_count", "scroll_top", "mouse_events", "second_clicks"].map(key => [key, value[key]]));
    trial.decoyBefore = contents(decoyState());
    const switchedTool = await startClient("switch-mid-action");
    await delay(2_100);
    trial.sampleStart = receipt.samples.length;
    trial.baseline = await until(() => receipt.samples[trial.sampleStart], "post-approval switch-trial observer");
    assert.notEqual(trial.baseline.frontmost_pid, fixture.pid, "the fixture remains in the background after approval");
    await switchedTool("open_application", { pid: fixture.pid, activate: false });
    const selected = await switchedTool("get_app_state");
    assert.equal(selected.pid, fixture.pid);
    await switchedTool("left_click", { target: target(selected, e => e.role === "AXTextField" && e.value === oracle().entry) });
    const before = oracle();
    let settled = false;
    const input = switchedTool("hold_key", { text: "z", duration: 3 }).finally(() => { settled = true; });
    input.catch(() => {}); // Assert below, even if another assertion fails first.
    await until(() => oracle()?.key_down_count > before.key_down_count, "target key-down while the input call is pending");
    assert.equal(settled, false, "input completed before the deliberate switch");
    assert.equal(oracle().key_up_count, before.key_up_count, "held input already released before the switch");
    trial.activationRequestedAt = new Date().toISOString();
    execFileSync(activateDecoy, [String(decoy.pid), decoyId], { timeout: 5_000 });
    await until(() => receipt.samples.at(-1)?.frontmost_pid === decoy.pid, "independent observer sees decoy activation");
    trial.observedSwitchIndex = receipt.samples.findIndex((sample, i) => i >= trial.sampleStart && sample.frontmost_pid === decoy.pid);
    trial.switchedWhileInputPending = !settled;
    assert.equal(trial.switchedWhileInputPending, true);
    assert.equal(oracle().key_up_count, before.key_up_count, "target key-up happened before the observed switch");
    trial.inputResult = await input;
    trial.inputCompletedAt = new Date().toISOString();
    trial.sampleAtInputCompletion = receipt.samples.length;
    await until(() => oracle()?.key_up_count > before.key_up_count, "target receives key-up after the observed switch");
    trial.targetAfter = contents(oracle());
    assert.equal(oracle().entry, `${before.entry}z`, "held input affected only the selected target");
    assert.equal(oracle().keys_up.at(-1), "z");
    await switchedTool("stop_computer_control");
    await delay(200);
    await until(() => receipt.samples.length > trial.sampleAtInputCompletion, "independent observer remains live after input completion");
    trial.decoyAfter = contents(decoyState());
    assert.deepEqual(trial.decoyAfter, trial.decoyBefore, "decoy contents or input events changed");
    trial.sampleEnd = receipt.samples.length;
    const observed = receipt.samples.slice(trial.sampleStart, trial.sampleEnd);
    trial.sampleCount = observed.length;
    trial.pointerChanges = observed.filter(sample => sample.pointer.x !== trial.baseline.pointer.x || sample.pointer.y !== trial.baseline.pointer.y).length;
    trial.unexpectedForegroundSamples = receipt.samples.slice(trial.sampleStart, trial.observedSwitchIndex).filter(sample => sample.frontmost_pid !== trial.baseline.frontmost_pid).length
      + receipt.samples.slice(trial.observedSwitchIndex, trial.sampleEnd).filter(sample => sample.frontmost_pid !== decoy.pid).length;
    assert.equal(trial.pointerChanges, 0, "pointer changed during deliberate-switch trial");
    assert.equal(trial.unexpectedForegroundSamples, 0, "input reclaimed focus or an unrelated foreground change occurred");
    trial.ok = true;
    receipt.checks.push("separate deliberate switch during pending held input: target key-up completed, decoy contents and pointer unchanged, focus stayed on decoy");
  }
  if (persistentHost) {
    sampling = false;
    probe.kill("SIGTERM");
    for (const client of clients) await client.close();
    if (helperProcess) {
      const previousPid = receipt.helper.pid;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("owned helper did not close for persistence verification")), 5_000);
        helperProcess.once("exit", () => { clearTimeout(timeout); resolve(); });
        helperProcess.kill("SIGTERM");
      });
      helperProcess = start(path.join(bundle, "Contents", "MacOS", "codewhale-cu"), [], { env, stdio: ["ignore", "ignore", "inherit"] });
      receipt.restartedHelper = await until(() => {
        try {
          const app = JSON.parse(fs.readFileSync(path.join(env.CODEWHALE_CU_STATE_DIR, "app-run.json"), "utf8"));
          return app.pid !== previousPid && app.hostTrustProtocol >= 1 ? app : null;
        } catch { return null; }
      }, "owned helper restarted and reloaded Keychain trust");
    }
    const reconnected = await startClient("persistent-reconnect");
    receipt.persistenceVerified = true;
    receipt.persistenceScope = helperProcess ? "new-mcp-process-restarted-helper" : "new-mcp-process-same-helper";
    receipt.checks.push(`a new MCP process with the same in-memory host key found persisted trust before a successful app-list request (${receipt.persistenceScope})`);
    receipt.pairing.cleanup = `Revoke Codewhale release check (Key ${receipt.pairing.helperKeyLabel}) in Computer Use. No private key is saved by this verifier.`;
    process.stderr.write(`${receipt.pairing.cleanup}\n`);
    if (waitForRevoke) {
      await reconnected("open_application", { pid: fixture.pid, activate: false });
      receipt.revocation = { requestedAt: new Date().toISOString(), observed: false };
      process.stderr.write("Waiting for your native Revoke action; only consent status will be read.\n");
      while (!receipt.revocation.observed) {
        const status = await reconnected("consent_status", {}, "revoke-poll");
        receipt.revocation.status = status.host;
        if (status.host?.revoked === true && status.host.trusted === false && status.host.persisted === false) {
          receipt.revocation.observed = true;
          receipt.revocation.observedAt = new Date().toISOString();
          receipt.pairing.cleanupRequired = false;
        } else await delay(1_000);
      }
      receipt.checks.push("status-only observation confirmed the user's native Revoke removed persisted trust");
    }
  }
  assert.equal(interference.length, 0, "foreground or cursor changed during the trial; inspect the samples");
  receipt.ok = true;
} catch (error) {
  receipt.ok = false;
  receipt.error = error.stack;
  process.exitCode = 1;
} finally {
  sampling = false;
  hostLedgerKey?.fill(0);
  if (receipt.pairing?.cleanupRequired) {
    receipt.pairing.cleanup = `Revoke Codewhale release check (Key ${receipt.pairing.helperKeyLabel}) in Computer Use. No private key is saved by this verifier.`;
    process.stderr.write(`${receipt.pairing.cleanup}\n`);
  }
  // LaunchServices owns the decoy process; its PID comes from the unique,
  // locally created fixture oracle, never a user's app lookup.
  for (const pid of ownedApps) {
    try { process.kill(pid, "SIGTERM"); } catch (error) {
      if (error.code !== "ESRCH") {
        (receipt.cleanupErrors ??= []).push(`Decoy ${pid}: ${error.message}`);
        receipt.ok = false; process.exitCode = 1;
      }
    }
  }
  // Let MCP close its leased session while the daemon is still available.
  // Stopping both at once would manufacture a cleanup failure after a good trial.
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
  }
  receipt.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ ...receipt, samples: undefined, actions: undefined, output }, null, 2));
}
