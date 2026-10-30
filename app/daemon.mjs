#!/usr/bin/env node
// Codewhale Computer Use — the desktop app process.
//
// A long-lived daemon that runs the platform backend on this machine and
// answers one-line JSON requests over a per-user local socket (see
// src/app-socket.mjs). The app bundles built by scripts/build-app.mjs launch
// exactly this file, so the OS attributes every osascript / screencapture /
// UI-automation call to the app: grant Accessibility and Screen Recording to
// "Codewhale Computer Use" once and every host that speaks to the plugin
// inherits it.
//
// Env (set by the launchers inside the bundles):
//   CODEWHALE_CU_APP_BUNDLE   absolute path of the installed bundle
//   CODEWHALE_CU_APP_LAUNCH   JSON argv that re-launches the bundle detached
//   CODEWHALE_CU_STATE_DIR    state dir (defaults to ~/.codewhale-cu)
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { handle, closeSession, closeAllSessions, releaseSessionInput, reopenSession, ALLOWED, controlStatus, setControlMode, summarizeSessions, createConsentController } from "../src/app-handler.mjs";
import { runBackgroundCheck } from "./background-check.mjs";
import { checkForUpdate, prepareUpdate, restartWithUpdate, readUpdateResult } from "./updates.mjs";
import { APP_ID, APP_NAME, APP_VERSION, PLUGIN_ROOT, socketPath, runInfoPath, writeRegistration, defaultLaunch, hello, runtimeFingerprint } from "../src/app-socket.mjs";
import { stateDir } from "../src/registry.mjs";
import * as consent from "../src/consent.mjs";
import { isStrict, approvalMode } from "../src/approval-mode.mjs";

const startedAt = new Date().toISOString();
const bundle = process.env.CODEWHALE_CU_APP_BUNDLE || null;
let controlOwner = false;
let hostTrustEnabled = false;
let hostTrustError = null;
let trustedHosts = new Map();
let notifyHostExclusion = () => {};
let notifyControlState = () => {};
const consentController = createConsentController({ onStateChange: () => notifyControlState() });
const log = (msg) => process.stderr.write(`${new Date().toISOString()} ${APP_NAME}: ${msg}\n`);
let build = null;
try { build = runtimeFingerprint(); } catch (error) { log(`could not fingerprint the runtime: ${error.message}`); }

function appInfo() {
  return { id: APP_ID, name: APP_NAME, version: APP_VERSION, build, pluginRoot: PLUGIN_ROOT, sessionProtocol: 2, backgroundProtocol: 1, controlProtocol: 2, consentProtocol: consentController.helperConsent ? 1 : 0, hostTrustProtocol: hostTrustEnabled ? 1 : 0, approval: approvalMode(), controlOwner, pid: process.pid, platform: process.platform, node: process.version, bundle, startedAt, socket: socketPath() };
}

if (await hello({ timeoutMs: 1_500 })) {
  log(`already running on ${socketPath()}; exiting`);
  process.exit(0);
}

const sock = socketPath();
fs.mkdirSync(stateDir(), { recursive: true });
if (process.platform !== "win32") {
  try { fs.unlinkSync(sock); } catch {} // stale file from an unclean exit; nobody answered hello above
}

const leases = new Map();
const exclusionWrites = new Set();
function hostPublicKey(value) {
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]{59}=$/.test(value)) return null;
    const der = Buffer.from(value, "base64");
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && key.export({ format: "der", type: "spki" }).equals(der) ? key : null;
  } catch { return null; }
}
function updateHostTrust(message) {
  const previous = trustedHosts;
  trustedHosts = new Map();
  hostTrustError = typeof message.error === "string" ? message.error : null;
  if (!hostTrustError && (!Array.isArray(message.hosts) || message.hosts.length > 32)) hostTrustError = "Saved computer trust is invalid. Open Computer Use to review it.";
  if (!hostTrustError && Array.isArray(message.hosts) && message.hosts.length <= 32) {
    for (const host of message.hosts) {
      if (!hostPublicKey(host?.publicKey) || trustedHosts.has(host.publicKey) || typeof host.label !== "string" || host.label.length > 80 || !["allow", "revoked"].includes(host.decision) || !Array.isArray(host.exclusions) || host.exclusions.length > 128 || new Set(host.exclusions).size !== host.exclusions.length || host.exclusions.some(key => typeof key !== "string" || key.length > 480 || key !== key.toLowerCase() || !/^(?:scope:foreground|name:[^\u0000-\u001f\u007f]+|bundle:[a-z0-9._-]+)$/.test(key))) {
        trustedHosts.clear(); hostTrustError = "Saved computer trust is invalid. Open Computer Use to review it."; break;
      }
      trustedHosts.set(host.publicKey, host);
    }
  }
  for (const [sessionId, lease] of leases) {
    if (!lease.host?.persistent) continue;
    const before = previous.get(lease.host.publicKey);
    const after = trustedHosts.get(lease.host.publicKey);
    if (before?.decision === "allow" && after?.decision !== "allow") {
      lease.revoked = true; lease.controller.abort(); consentController.cancel(sessionId);
      closeSession(sessionId).catch(error => log(`revoked host cleanup: ${error.message}`));
    } else if (lease.approved && after?.decision === "allow") {
      if (before?.exclusions.some(key => !after.exclusions.includes(key))) consent.withSession(sessionId, () => consent.clearSessionDenials("local"));
      consent.setHostAccess(sessionId, { persisted: true, exclusions: after.exclusions });
      if (after.exclusions.some(key => !before?.exclusions.includes(key))) {
        lease.controller.abort(); lease.controller = new AbortController(); consentController.cancel(sessionId);
        releaseSessionInput(sessionId).catch(error => log(`excluded app cleanup: ${error.message}`));
      }
    }
  }
  for (const pending of exclusionWrites) {
    const saved = trustedHosts.get(pending.publicKey);
    if (hostTrustError || saved?.decision !== "allow") pending.finish(new Error(hostTrustError || "Computer trust was revoked before the exclusion could be saved."));
    else if (pending.keys.every(key => saved.exclusions.includes(key))) pending.finish();
  }
}
function persistExclusions(publicKey, keys) {
  if (!keys.length) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const pending = { publicKey, keys, finish(error) {
      exclusionWrites.delete(pending); clearTimeout(timer);
      if (error) reject(error); else resolve(true);
    } };
    const timer = setTimeout(() => {
      updateHostTrust({ error: "Computer access is blocked because the app exclusion could not be saved. Reopen Computer Use to check Keychain access.", hosts: [] });
    }, 5_000);
    exclusionWrites.add(pending);
    notifyHostExclusion(publicKey, keys);
  });
}
async function ensureHostTrust(sessionId, signal) {
  if (!hostTrustEnabled) return null;
  const lease = leases.get(sessionId);
  if (!lease) return { code: "session_owner_required", message: "The computer session ended." };
  if (lease.host && !lease.authenticated) return { code: "host_auth_required", message: "This connection has not proved its pairing key. Restart the MCP connection." };
  if (lease.revoked) return { code: "host_revoked", message: "Computer access was revoked. Only the user can allow it again in Computer Use." };
  if (lease.denied) return { code: "consent_declined", message: "The user declined computer access for this connection. Do not ask again." };
  if ([...exclusionWrites].some(pending => pending.publicKey === lease.host?.publicKey)) return { code: "host_trust_pending", message: "A computer permission change is being saved. Wait for it to finish." };
  if (hostTrustError && lease.host?.persistent) return { code: "host_trust_unavailable", message: hostTrustError };
  let saved = lease.host?.persistent ? trustedHosts.get(lease.host.publicKey) : null;
  if (saved?.decision === "revoked") return { code: "host_revoked", message: "Computer access was revoked. Only the user can allow it again in Computer Use." };
  if (saved?.decision !== "allow" && (!lease.approved || (lease.implicit && isStrict()))) {
    if (controlStatus().mode !== "ready") return { code: `control_${controlStatus().mode}`, message: "Computer Use is paused or stopped by the user." };
    lease.exclusions = consent.legacyExclusions("local");
    if (isStrict()) {
      const approval = await consent.withSession(sessionId, () => consentController.request({ kind: "trust_host", host: { ...(lease.host ?? { label: "This connection", persistent: false }), exclusions: lease.exclusions } }, { signal }));
      if (!approval.ok) {
        if (approval.error?.code === "consent_declined") lease.denied = true;
        return approval.error;
      }
      if (signal.aborted || lease.revoked || leases.get(sessionId) !== lease) return { code: "cancelled", message: "The connection ended before computer access was granted." };
      saved = lease.host?.persistent ? trustedHosts.get(lease.host.publicKey) : null;
      if (lease.host?.persistent && saved?.decision !== "allow") return { code: "host_trust_unavailable", message: "The native helper could not save the pairing. Nothing was approved." };
      lease.implicit = false;
    } else if (!lease.approved) lease.implicit = true;
  }
  lease.approved = true;
  consent.setHostAccess(sessionId, { persisted: saved?.decision === "allow", exclusions: saved?.exclusions ?? lease.exclusions ?? [] });
  return null;
}
let shuttingDown = false;
let backgroundCheck = null;
let checking = false;
let update = readUpdateResult();
let updating = false;
let controlError = null;
const controlFile = path.join(stateDir(), "control.json");
async function userControl(mode) {
  if (mode !== "ready") consentController.cancel();
  const work = setControlMode(mode);
  if (mode === "ready") await work;
  const temporary = `${controlFile}.${process.pid}.tmp`;
  let storageError;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ mode }), { mode: 0o600 });
    fs.renameSync(temporary, controlFile);
  } catch (error) { storageError = error; }
  const result = await work;
  if (storageError) throw new Error("Control changed, but its restart preference could not be saved. Check disk space before reopening the app.");
  return result;
}
try {
  const saved = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  if (saved.mode !== "ready") await setControlMode(["paused", "stopped"].includes(saved.mode) ? saved.mode : "stopped");
} catch (error) { if (error.code !== "ENOENT") await setControlMode("stopped"); }

// An inherited socketpair joins the menu-bar owner and its child. This has
// no filesystem endpoint, no reusable credential and no MCP equivalent.
// Losing the human control process fails closed before accepting more work.
if (process.env.CODEWHALE_CU_CONTROL_FD === "3") {
  const control = new net.Socket({ fd: 3, readable: true, writable: true });
  controlOwner = true;
  delete process.env.CODEWHALE_CU_CONTROL_FD;
  let input = "";
  control.setEncoding("utf8");
  const status = () => ({ ...controlStatus(), approval: approvalMode(), version: APP_VERSION, checking, backgroundCheck, error: controlError,
    consent: consentController.activePromptPayload(),
    update: update ? { available: update.available, version: update.version, message: update.message, busy: updating } : null });
  const send = (id, error) => {
    if (error) controlError = String(error.message ?? error).slice(0, 400);
    if (!control.destroyed) control.write(JSON.stringify({ id, ...status() }) + "\n");
  };
  notifyControlState = () => send(undefined);
  notifyHostExclusion = (publicKey, keys) => {
    if (!control.destroyed) control.write(JSON.stringify({ host_exclusion: { publicKey, keys } }) + "\n");
  };
  control.on("data", chunk => {
    input += chunk;
    if (input.length > 65536) { control.destroy(); return; }
    let newline;
    while ((newline = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newline); input = input.slice(newline + 1);
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      const { id, command } = request;
      if (command === "host_trust_state") { updateHostTrust(request); send(id); continue; }
      if (command === "revoke_host" && hostPublicKey(request.publicKey)) {
        updateHostTrust({ hosts: [...trustedHosts.values()].map(host => host.publicKey === request.publicKey ? { ...host, decision: "revoked" } : host) });
        send(id); continue;
      }
      if (command === "capabilities") hostTrustEnabled = request.hostTrust === 1;
      const c = consentController.handleControlMessage(request);
      if (c.handled) {
        if (command === "capabilities") {
          try { if (fs.existsSync(runInfoPath())) fs.writeFileSync(runInfoPath(), JSON.stringify(appInfo(), null, 2) + "\n"); } catch {}
        }
        if (c.sendStatus) send(id);
        continue;
      }
      if (command === "status") send(id);
      else if (command === "stop_session") {
        const lease = leases.get(request.sessionId);
        if (!lease) { send(id); continue; }
        lease.stopped = true; lease.controller.abort(); consentController.cancel(request.sessionId);
        closeSession(request.sessionId).then(() => send(id)).catch(error => send(id, error));
      }
      else if (["pause", "resume", "stop"].includes(command)) {
        const mode = { pause: "paused", resume: "ready", stop: "stopped" }[command];
        userControl(mode).then(() => {
          controlError = null;
          if (mode === "stopped") {
            // Keep old owner sockets alive but invalidate their leases. An
            // already queued request can never silently obtain a fresh one.
            for (const lease of leases.values()) { lease.stopped = true; lease.controller.abort(); }
          }
          send(id);
        }).catch(error => send(id, error));
      } else if (command === "check") {
        if (checking || controlStatus().sessions.some(s => s.action)) { send(id, new Error("Wait for the current action to finish before running the check.")); continue; }
        checking = true; backgroundCheck = null; send(id);
        runBackgroundCheck({ bundle, onStateChange: notifyControlState }).then(result => { backgroundCheck = result; }).catch(error => {
          backgroundCheck = { ok: false, message: error.message };
        }).finally(() => { checking = false; send(id); });
      } else if (command === "updates" && !updating) {
        updating = true; update = { available: false, message: "Checking for updates…" }; send(id);
        checkForUpdate().then(result => { update = result; }).catch(error => { update = { available: false, message: error.message }; }).finally(() => { updating = false; send(id); });
      } else if (command === "install_update" && update?.available && !updating && bundle) {
        updating = true; update.message = "Downloading and verifying the update…"; send(id);
        prepareUpdate(update).then(async prepared => {
          await userControl("stopped");
          await restartWithUpdate(prepared, bundle);
          update.message = "Restarting Computer Use…"; send(id);
        }).catch(error => { updating = false; update.message = error.message; send(id); });
      } else send(id, new Error("Unknown or unavailable control command"));
    }
  });
  control.on("error", () => {});
  control.on("close", () => {
    controlOwner = false;
    // Persist the stop and abort active input synchronously, then retire the
    // listener. Reopening the menu app must be able to start a new owner.
    userControl("stopped").catch(error => log(`control owner cleanup: ${error.message}`));
    shutdown("control owner disconnected");
  });
}
async function serve(conn) {
  let buf = "";
  let chain = Promise.resolve();
  const controller = new AbortController();
  let ownedSession = null;
  conn.on("close", () => {
    controller.abort();
    if (ownedSession && leases.get(ownedSession)?.socket === conn) {
      leases.get(ownedSession).controller.abort();
      leases.delete(ownedSession);
      consentController.cancel(ownedSession);
      closeSession(ownedSession).catch((err) => log(`disconnected session input cleanup failed: ${err.message}`));
    }
  });
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  conn.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        if (controller.signal.aborted) return;
        let req;
        try { req = JSON.parse(line); } catch { return conn.write(JSON.stringify({ ok: false, error: { code: "bad_payload", message: "request is not JSON" } }) + "\n"); }
        let reply;
        if (shuttingDown) reply = { ok: false, error: { code: "app_shutting_down", message: "Computer Use helper is shutting down" } };
        else if (req?.tool === "hello") reply = { ok: true, app: appInfo() };
        else if (req?.tool === "platform") reply = await handle(req);
        else if (!ALLOWED.has(req?.tool) && !["open_session", "authenticate_session", "close_session", "release_session_input", "consent_request", "consent_deny", "consent_revoke", "consent_status"].includes(req?.tool)) reply = await handle(req);
        else if (typeof req?.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(req.sessionId)) {
          reply = { ok: false, error: { code: "session_required", message: "Update the MCP server: every computer request must carry its session identity." } };
        } else if (req.tool === "open_session") {
          if (ownedSession || leases.has(req.sessionId)) reply = { ok: false, error: { code: "session_owned", message: "Computer session already has an owner" } };
          else if (leases.size >= 256) reply = { ok: false, error: { code: "session_limit", message: "Too many active computer sessions" } };
          else if (hostTrustEnabled && req.host != null && !hostPublicKey(req.host.publicKey)) reply = { ok: false, error: { code: "host_auth_failed", message: "The pairing public key is invalid." } };
          else {
            ownedSession = req.sessionId;
            const leaseToken = crypto.randomUUID();
            // A capability grant (set by the MCP server from CODEWHALE_CU_GRANT)
            // narrows this lease for its whole life: the daemon refuses tools
            // the grant does not name, so narrowing survives the socket.
            const grant = Array.isArray(req.grant) && req.grant.length ? new Set(req.grant.map((t) => String(t))) : null;
            const pid = (value) => Number.isInteger(value) && value > 0 ? value : null;
            const owner = { pid: pid(req.owner?.pid), host_pid: pid(req.owner?.host_pid) };
            const host = hostTrustEnabled && req.host ? { publicKey: req.host.publicKey, label: String(req.host.label || "This connection").slice(0, 80), persistent: req.host.persistent === true } : null;
            const challenge = host ? crypto.randomBytes(32).toString("hex") : null;
            leases.set(ownedSession, { socket: conn, token: leaseToken, controller: new AbortController(), grant, owner: owner.pid || owner.host_pid ? owner : null, host, challenge, challengeExpiresAt: Date.now() + 30_000 });
            reopenSession(ownedSession);
            reply = { ok: true, leaseToken, ...(grant ? { grant: [...grant] } : {}), ...(hostTrustEnabled ? { hostTrustProtocol: 1, ...(challenge ? { challenge } : {}) } : {}) };
          }
        } else if (!leases.has(req.sessionId) || leases.get(req.sessionId).token !== req.leaseToken) {
          reply = { ok: false, error: { code: "session_owner_required", message: "Computer request needs its live session owner lease; update or restart the MCP server" } };
        } else if (req.tool === "authenticate_session") {
          const lease = leases.get(req.sessionId);
          const challenge = lease.challenge;
          lease.challenge = null;
          let valid = false;
          try {
            const signature = typeof req.proof === "string" ? Buffer.from(req.proof, "base64") : Buffer.alloc(0);
            const message = `net.codewhale.computer-use.host.v1\0${req.sessionId}\0${lease.token}\0${challenge}\0${req.publicKey}`;
            valid = !!challenge && Date.now() < lease.challengeExpiresAt && req.publicKey === lease.host?.publicKey && signature.length === 64 && signature.toString("base64") === req.proof && crypto.verify(null, Buffer.from(message), hostPublicKey(req.publicKey), signature);
          } catch {}
          lease.authenticated = valid;
          reply = valid ? { ok: true, authenticated: true } : { ok: false, error: { code: "host_auth_failed", message: "The connection could not prove its pairing key. Restart the MCP connection." } };
        } else if (leases.get(req.sessionId).grant && !leases.get(req.sessionId).grant.has(req.tool === "consent_request" ? (req.kind === "app_script" ? "app_script" : "consent_allow") : req.tool) && !["close_session", "release_session_input", "consent_deny", "consent_revoke", "consent_status"].includes(req.tool)) {
          // Cleanup must never be blocked by a grant; everything else is.
          reply = { ok: false, error: { code: "not_granted", message: `this session's capability grant does not include "${req.tool}"` } };
        } else if (req.tool === "consent_status") {
          const lease = leases.get(req.sessionId);
          const saved = lease.host?.persistent && lease.authenticated ? trustedHosts.get(lease.host.publicKey) : null;
          const trusted = !lease.revoked && !lease.stopped && !hostTrustError && saved?.decision !== "revoked" && (saved?.decision === "allow" || (lease.approved === true && !lease.implicit && !lease.host?.persistent) || (!isStrict() && lease.implicit !== false));
          reply = consent.withSession(req.sessionId, () => ({ ok: true, ...consent.status("local"), host: { trusted, persisted: saved?.decision === "allow", label: saved?.label ?? lease.host?.label ?? null, revoked: lease.revoked === true || saved?.decision === "revoked", exclusions: saved?.exclusions ?? lease.exclusions ?? [] } }));
        } else if (req.tool === "list_sessions") {
          // Content-free registry view over the live sessions. Available even
          // when the user has paused or stopped other sessions: seeing who is
          // driving is exactly what a model needs to explain machine state.
          // Same envelope as every backend reply so the server reads `data`.
          reply = { ok: true, platform: process.platform, tool: req.tool, data: summarizeSessions({ ownerOf: (id) => leases.get(id)?.owner, self: req.sessionId }) };
        } else if (leases.get(req.sessionId).stopped && !["close_session", "release_session_input"].includes(req.tool)) {
          reply = { ok: false, error: { code: "control_stopped", message: "The user stopped this computer session. Start a new task after they allow control in the menu bar." } };
        } else if (["close_session", "release_session_input"].includes(req.tool)) {
          try {
            if (req.tool === "close_session") {
              leases.get(req.sessionId).stopped = true;
              leases.get(req.sessionId).controller.abort();
              consentController.cancel(req.sessionId);
              await closeSession(req.sessionId);
            }
            else await releaseSessionInput(req.sessionId);
            reply = { ok: true, closed: req.tool === "close_session", inputReleased: true };
          } catch (err) {
            reply = { ok: false, error: { code: "input_release_failed", message: String(err?.message ?? err) } };
          }
        } else if (hostTrustEnabled && !["probe", "consent_deny", "consent_revoke"].includes(req.tool) && (reply = await ensureHostTrust(req.sessionId, AbortSignal.any([controller.signal, leases.get(req.sessionId).controller.signal])))) {
          reply = { ok: false, error: reply };
        } else if (req.tool === "consent_request" && req.kind === "trust_host") {
          reply = { ok: false, error: { code: "bad_args", message: "Host trust is requested automatically by the helper." } };
        } else if (["consent_request", "consent_deny", "consent_revoke"].includes(req.tool)) {
          const lease = leases.get(req.sessionId);
          const mode = controlStatus().mode;
          if (req.tool === "consent_request" && mode !== "ready") reply = { ok: false, error: { code: `control_${mode}`, message: `Computer Use is ${mode} by the user.` } };
          else reply = await consent.withSession(req.sessionId, () => req.tool === "consent_request"
            ? consentController.request(req, { signal: AbortSignal.any([controller.signal, lease.controller.signal]) })
            : req.tool === "consent_deny" || hostTrustEnabled ? consentController.deny(req) : consentController.revoke(req));
          const host = lease.host;
          if (leases.get(req.sessionId) !== lease || controller.signal.aborted) reply = { ok: false, error: { code: "cancelled", message: "The connection ended before the permission change completed." } };
          if (["consent_deny", "consent_revoke"].includes(req.tool) && reply.ok && host?.persistent && lease.authenticated && trustedHosts.get(host.publicKey)?.decision === "allow") {
            const keys = req.scope === "foreground" ? ["scope:foreground"] : (reply.keys ?? []).filter(key => !key.startsWith("pid:"));
            try { reply.persisted = await persistExclusions(host.publicKey, keys); }
            catch (error) { reply = { ok: false, error: { code: "host_trust_unavailable", message: error.message } }; }
          }
        } else reply = await consent.withSession(req.sessionId, () => handle(req, {
          computerId: "local", sessionId: req.sessionId, signal: AbortSignal.any([controller.signal, leases.get(req.sessionId).controller.signal]), persistentInputOwner: true,
          requestConsent: consentController.helperConsent ? (request, signal) => consentController.request(request, { signal }) : undefined,
          onStateChange: notifyControlState,
        }));
        if (!conn.destroyed) conn.write(JSON.stringify(reply) + "\n");
      }).catch(error => {
        log(`request failed: ${error?.code ?? "internal_error"}`);
        if (!conn.destroyed) conn.write(JSON.stringify({ ok: false, error: { code: "outcome_unknown", message: "The helper could not complete this request. Observe the current state before retrying.", request_dispatched: true } }) + "\n");
      });
    }
  });
}

const connections = new Set();
const server = net.createServer(conn => {
  connections.add(conn);
  conn.once("close", () => connections.delete(conn));
  serve(conn);
});
server.on("error", (err) => { log(`socket error: ${err.message}`); process.exit(1); });
server.listen(sock, () => {
  if (process.platform !== "win32") { try { fs.chmodSync(sock, 0o600); } catch {} }
  fs.writeFileSync(runInfoPath(), JSON.stringify(appInfo(), null, 2) + "\n");
  if (bundle) {
    // Launching the bundle once is what registers it: the MCP server reads this
    // record to bring the app up on demand.
    try {
      const launch = process.env.CODEWHALE_CU_APP_LAUNCH ? JSON.parse(process.env.CODEWHALE_CU_APP_LAUNCH) : defaultLaunch(bundle);
      writeRegistration({ id: APP_ID, path: bundle, launch });
    } catch (err) { log(`could not record launch command: ${err.message}`); }
  }
  log(`v${APP_VERSION} listening on ${sock}${bundle ? ` (bundle ${bundle})` : " (bare, no bundle identity)"}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}; shutting down`);
  server.close();
  // Windows keeps a named-pipe instance bound while accepted connections
  // remain open. Retire those owners before allowing a replacement listener.
  // Their close handlers abort work; closeAllSessions still awaits cleanup.
  for (const conn of connections) conn.destroy();
  const timer = setTimeout(() => process.exit(1), 3_000);
  const results = await closeAllSessions();
  clearTimeout(timer);
  for (const result of results) {
    if (result.status === "rejected") log(`input cleanup failed: ${result.reason?.message ?? result.reason}`);
  }
  try {
    if (JSON.parse(fs.readFileSync(runInfoPath(), "utf8")).pid === process.pid) fs.unlinkSync(runInfoPath());
  } catch {}
  // net.Server owns its Unix socket and removes it on close. Cleanup may
  // finish after a replacement has bound the path; never unlink its socket.
  process.exit(0);
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => shutdown(s));
