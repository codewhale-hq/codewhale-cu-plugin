// One request handler for every out-of-process runner of the backends: the
// ssh remote agent (one request per process) and the desktop app daemon (one
// long-lived process). Only tools in ALLOWED execute, so neither the ssh
// transport nor the app socket can ever become a generic shell.
import fs from "node:fs";
import crypto from "node:crypto";
import url from "node:url";
import { exec } from "./remote-runtime.mjs";
import { withSignal, throwIfAborted } from "./exec.mjs";
import { checkAppScript } from "./app-script-policy.mjs";
import { launchRefusal } from "./launch-policy.mjs";
import * as consent from "./consent.mjs";
import { stateDir } from "./registry.mjs";
import { liveMarker, visible, DECLINED_MESSAGE } from "./native-prompt.mjs";

export const ALLOWED = new Set([
  "preview", "platform", "probe", "list_displays", "switch_display", "list_apps", "list_sessions", "list_windows",
  "open_application", "kill_app", "set_window_frame", "get_app_state", "resolve_element", "screenshot", "zoom",
  "browser_start", "browser_status", "browser_navigate", "browser_click", "browser_type", "browser_screenshot", "browser_stop",
  "left_click", "double_click", "triple_click", "right_click", "middle_click",
  "mouse_move", "left_click_drag", "left_mouse_down", "left_mouse_up", "scroll",
  "type", "key", "hold_key", "set_value", "focus", "get_value", "select_text", "perform_action", "invoke_menu",
  "read_clipboard", "write_clipboard", "cursor_position", "input_owner", "focused_control",
  "recordingStart", "recordingStop", "recordingStatus", "recordingList",
  "app_script",
]);

/** app_script runs osascript where this handler executes. The remote agent is
 *  the exception that proves the transport rule: it must never become a shell,
 *  so scripting is honored on the local computer (computerId "local") only. */
const LOCAL_ONLY_TOOLS = new Set(["app_script"]);

const backends = new Map();
const heldPointers = new Map();
const appWriters = new Map();
const INPUT_IDLE_MS = Math.max(1_000, Number(process.env.CODEWHALE_CU_INPUT_IDLE_MS) || 60_000);
const INPUT_MUTATIONS = new Set([
  "open_application", "left_click", "double_click", "triple_click", "right_click", "middle_click", "mouse_move",
  "left_click_drag", "left_mouse_down", "left_mouse_up", "scroll", "type", "key", "hold_key", "set_value", "focus", "select_text", "perform_action", "invoke_menu",
]);
let queue = Promise.resolve();

async function backend(computerId, sessionId, persistentInputOwner) {
  const key = `${computerId}:${sessionId}`;
  if (!backends.has(key)) {
    // Same test hook as src/transport.mjs, so the out-of-process route can be
    // driven end to end against a recording backend (never set in production).
    const test = process.env.CODEWHALE_CU_TEST_BACKEND;
    const mod = await import(test ? url.pathToFileURL(test).href : `./backends/${process.platform}.mjs`);
    backends.set(key, mod.create({ exec: { ...exec, persistentInputOwner }, computer: { id: computerId, transport: "local", platform: process.platform } }));
  }
  return backends.get(key);
}

const sessions = new Map();
let controlMode = "ready";
let controlGeneration = 0;
let cleanupPending = false;

/** Human-facing state contains app identity and action names, never task text. */
export function controlStatus() {
  return { mode: controlMode, cleanupPending, sessions: [...sessions.entries()]
    .filter(([, s]) => !s.closed && (s.displayTarget ?? s.target))
    .map(([key, s]) => ({ sessionId: key.slice(key.indexOf(":") + 1), target: s.displayTarget ?? s.target, mode: s.mode, action: s.action ?? null })) };
}

// Called only by the launcher's inherited control channel, never an MCP tool.
// Abort before queuing cleanup so even a held gesture yields to the person.
export async function setControlMode(mode) {
  if (!["ready", "paused", "stopped"].includes(mode)) throw new Error("Unknown control mode");
  if (mode === "ready") {
    if (cleanupPending) throw new Error("Input is still being released; try again in a moment.");
    controlMode = mode;
    return controlStatus();
  }
  controlMode = mode;
  const generation = ++controlGeneration;
  cleanupPending = true;
  const results = await Promise.allSettled([...sessions.keys()].map((key) => {
    const colon = key.indexOf(":");
    return releaseSessionInput(key.slice(colon + 1), key.slice(0, colon), { close: mode === "stopped" });
  }));
  const failure = results.find((r) => r.status === "rejected");
  // A cleanup failure stays blocked. Resume cannot hide owned input.
  if (failure) throw failure.reason;
  if (generation === controlGeneration) cleanupPending = false;
  return controlStatus();
}

function enqueue(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

function inputOwnerIdle(key) {
  const owner = sessions.get(key);
  return !owner || owner.closed || (!owner.requests.size && Date.now() - owner.touched > INPUT_IDLE_MS);
}

function dropAppWriters(key) {
  for (const [app, writer] of appWriters) if (writer.key === key) appWriters.delete(app);
}

/** Cancel this host's work, then release only input held by its backend. */
export function releaseSessionInput(sessionId, computerId = "local", { close = false } = {}) {
  const key = `${computerId}:${sessionId}`;
  let session = sessions.get(key);
  if (!session) {
    if (!close) return Promise.resolve();
    session = { requests: new Set(), closed: true, touched: Date.now() };
    sessions.set(key, session);
  }
  if (close) session.closed = true;
  for (const controller of session.requests) controller.abort();
  return enqueue(async () => {
    try {
      await withSignal(null, () => backends.get(key)?.releaseInput?.());
      if (heldPointers.get(computerId) === key) heldPointers.delete(computerId);
      dropAppWriters(key);
      if (close) await withSignal(null, () => backends.get(key)?.closeSession?.());
      if (close) backends.delete(key);
    } finally { session.touched = Date.now(); }
  });
}

export function closeSession(sessionId, computerId = "local") {
  consent.withSession(sessionId, () => consent.dropSession(computerId));
  for (const [token, entry] of appScriptTokens) if (entry.sessionId === sessionId) appScriptTokens.delete(token);
  return releaseSessionInput(sessionId, computerId, { close: true });
}

/**
 * A freshly granted session owner supersedes a closed-session tombstone:
 * without this, a daemon that re-leases a session id (the old owner socket
 * died with the previous daemon) would keep aborting every request on it.
 * In-flight requests from the dead owner stay aborted; the tombstone is the
 * only thing removed.
 */
export function reopenSession(sessionId, computerId = "local") {
  sessions.delete(`${computerId}:${sessionId}`);
}

export function closeAllSessions() {
  return Promise.allSettled([...sessions.keys()].map((key) => {
    const colon = key.indexOf(":");
    return closeSession(key.slice(colon + 1), key.slice(0, colon));
  }));
}

/**
 * Content-free session registry view for agents: which sessions are live,
 * what each is bound to, what it is doing right now, whether any session
 * holds a pointer or the input claim on its app, and which processes own
 * each session. App identity, action names and process ids only — task text
 * never reaches this process, so none can leak. Read-only by construction.
 */
export function summarizeSessions({ ownerOf, self } = {}) {
  const live = [...sessions.entries()].filter(([, s]) => !s.closed);
  return {
    control: controlMode,
    count: live.length,
    inputIdleSec: INPUT_IDLE_MS / 1000,
    sessions: live.map(([key, s]) => {
      const colon = key.indexOf(":");
      const computerId = key.slice(0, colon);
      const sessionId = key.slice(colon + 1);
      return {
        target: s.target ?? null,
        mode: s.mode ?? null,
        action: s.action ?? null,
        ageSec: Math.max(0, Math.round((Date.now() - s.touched) / 1000)),
        inputHeld: heldPointers.get(computerId) === key,
        writing: Number.isInteger(s.target?.pid) && appWriters.get(`${computerId}:${s.target.pid}`)?.key === key && !inputOwnerIdle(key),
        ...(ownerOf ? { owner: ownerOf(sessionId) ?? null } : {}),
        ...(self ? { self: sessionId === self } : {}),
      };
    }),
  };
}

/** App identities a request names directly, for the consent ledger. */
function namedApps(tool, args) {
  if (tool !== "open_application" && tool !== "kill_app") return [];
  const refs = [];
  if (typeof args.bundle_id === "string" && args.bundle_id.trim()) refs.push({ bundle_id: args.bundle_id.trim() });
  if (typeof args.name === "string" && args.name.trim()) refs.push({ name: args.name.trim() });
  if (Number.isInteger(args.pid) && args.pid > 0) refs.push({ pid: args.pid });
  return refs;
}

const BOUND_TARGET_TOOLS = new Set([
  "get_app_state", "find_elements", "wait_for", "list_windows", "screenshot", "zoom",
  "recording_start", "recordingStart", "preview", "invoke_menu", "set_window_frame",
  "type", "key", "hold_key",
  "left_click", "double_click", "triple_click", "right_click", "middle_click",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "scroll",
  "set_value", "focus", "get_value", "select_text", "perform_action", "resolve_element",
]);
const IMPLICIT_FRONTMOST_TOOLS = new Set(["get_app_state", "find_elements", "wait_for", "list_windows", "set_window_frame", "recording_start", "recordingStart", "resolve_element"]);
const KEYBOARD_INPUT_TOOLS = new Set(["type", "key", "hold_key"]);
const POINTER_INPUT_TOOLS = new Set(["left_click", "double_click", "triple_click", "right_click", "middle_click", "mouse_move", "scroll", "left_mouse_down"]);
const SELECTOR_TOOLS = new Set(["list_windows", "get_app_state", "resolve_element", "screenshot", "set_value", "select_text", "perform_action", "focus", "get_value"]);
const WINDOW_INDEX_TOOLS = new Set(["resolve_element", "set_value", "select_text", "perform_action", "focus", "get_value"]);

const SCRIPT_TOKEN_TTL_MS = 60_000;
const appScriptTokens = new Map();
let daemonPromptOpen = false;

function scriptDigest(language, script) {
  return crypto.createHash("sha256").update(`${language ?? "applescript"}\0${String(script ?? "")}`).digest("hex");
}

function pruneAppScriptTokens(nowMs) {
  for (const [token, entry] of appScriptTokens) {
    if (entry.expiresAt <= nowMs) appScriptTokens.delete(token);
  }
}

export function issueAppScriptToken(language, script, nowMs = Date.now()) {
  pruneAppScriptTokens(nowMs);
  const token = crypto.randomBytes(16).toString("hex");
  appScriptTokens.set(token, { hash: scriptDigest(language, script), expiresAt: nowMs + SCRIPT_TOKEN_TTL_MS, sessionId: consent.currentSession() });
  return token;
}

export function consumeAppScriptToken(token, language, script, nowMs = Date.now()) {
  pruneAppScriptTokens(nowMs);
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return false;
  const entry = appScriptTokens.get(token);
  if (!entry) return false;
  if (entry.sessionId !== consent.currentSession()) return false;
  if (entry.hash !== scriptDigest(language, script)) return false;
  appScriptTokens.delete(token);
  return true;
}

function validAppRefShape(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
  const keys = Object.keys(ref);
  if (!keys.length || keys.some((k) => k !== "pid" && k !== "name" && k !== "bundle_id")) return false;
  if ("pid" in ref && !(Number.isInteger(ref.pid) && ref.pid > 0 && ref.pid <= 0x7fffffff)) return false;
  if ("name" in ref && !(typeof ref.name === "string" && ref.name.trim())) return false;
  if ("bundle_id" in ref && !(typeof ref.bundle_id === "string" && ref.bundle_id.trim())) return false;
  return true;
}

function hasMalformedOrUnsupportedSelector(tool, args) {
  const platform = process.env.CU_SELECTOR_PLATFORM || process.platform;
  const appRef = args.app_ref !== undefined ? args.app_ref : args.target?.app_ref;
  const windowId = args.window_id !== undefined ? args.window_id : args.target?.window_id;
  const windowIndex = args.windowIndex !== undefined ? args.windowIndex : args.target?.windowIndex;
  if (SELECTOR_TOOLS.has(tool) && appRef !== undefined && !validAppRefShape(appRef)) return true;
  if (platform === "harmonyos" && SELECTOR_TOOLS.has(tool)) {
    if (appRef !== undefined || windowId !== undefined) return true;
    if (WINDOW_INDEX_TOOLS.has(tool) && windowIndex !== undefined && windowIndex !== 0) return true;
  }
  if (platform === "linux" && SELECTOR_TOOLS.has(tool)) {
    if (windowId !== undefined) return true;
    if (WINDOW_INDEX_TOOLS.has(tool) && windowIndex !== undefined && windowIndex !== 0) return true;
    if (appRef !== undefined && (Object.keys(appRef).some((k) => k !== "name") || typeof appRef.name !== "string" || !appRef.name.trim())) return true;
  }
  return false;
}

function expandRefFields(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return [];
  const out = [];
  if (typeof ref.bundle_id === "string" && ref.bundle_id.trim()) out.push({ bundle_id: ref.bundle_id.trim() });
  if (typeof ref.name === "string" && ref.name.trim()) out.push({ name: ref.name.trim() });
  if (Number.isInteger(ref.pid) && ref.pid > 0) out.push({ pid: ref.pid });
  return out;
}

export async function resolveConsentApp(ref, { computerId = "local", listApps } = {}) {
  if (!validAppRefShape(ref)) {
    throw Object.assign(new Error("consent allow_app needs a valid app identity (name, bundle_id or pid)"), { code: "consent_identity_ambiguous" });
  }
  const fetchApps = listApps ?? (async () => {
    const inst = await backend(computerId, "direct", false);
    if (typeof inst?.list_apps !== "function") return [];
    const res = await inst.list_apps({ all: true });
    return Array.isArray(res) ? res : Array.isArray(res?.apps) ? res.apps : null;
  });
  let apps;
  try { apps = await fetchApps(); } catch (err) {
    throw Object.assign(new Error(err?.message ?? "the running applications could not be listed"), { code: err?.code ?? "observe_failed" });
  }
  if (!Array.isArray(apps)) {
    throw Object.assign(new Error("the running applications could not be listed"), { code: "observe_failed" });
  }
  const wanted = ["pid", "bundle_id", "name"].filter((field) => ref[field] != null).map((field) => consent.appKeys({ [field]: ref[field] })[0]);
  const running = apps.map((app) => ({ app, keys: new Set(consent.appKeys(app)) }));
  const desc = [ref.name, ref.bundle_id, ref.pid != null ? `pid ${ref.pid}` : null].filter(Boolean).join(", ");
  if (ref.pid == null && wanted.length === 1 && running.every((entry) => !entry.keys.has(wanted[0]))) {
    const refusal = launchRefusal(ref, process.platform, { remote: computerId !== "local" });
    if (refusal) throw Object.assign(new Error(refusal.message), { code: refusal.code });
    return { resolved: ref, keys: consent.appKeys(ref), running: false };
  }
  const hits = running.filter((entry) => wanted.every((key) => entry.keys.has(key)));
  if (hits.length !== 1) {
    throw Object.assign(new Error(hits.length
      ? `${desc} matches ${hits.length} running applications (${hits.slice(0, 5).map(({ app }) => `${app.name ?? app.bundle_id} pid ${app.pid}`).join(", ")}); pass pid to choose one, then ask again`
      : `${desc} does not resolve to a single running application; call list_apps, then ask again`), { code: "consent_identity_ambiguous" });
  }
  const { app } = hits[0];
  const resolved = {
    ...(typeof app.name === "string" && app.name ? { name: app.name } : {}),
    ...(typeof app.bundle_id === "string" && app.bundle_id ? { bundle_id: app.bundle_id } : {}),
    ...(Number.isInteger(app.pid) && app.pid > 0 ? { pid: app.pid } : {}),
  };
  return { resolved, keys: consent.appKeys(resolved), running: true };
}

function cleanLine(text, limit = 240) {
  let out = "";
  for (const ch of String(text ?? "")) {
    if (out.length >= limit) break;
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff || code === 0x2028 || code === 0x2029) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out.trim().slice(0, limit);
}

export function createConsentController({
  now = () => performance.now(),
  epochNow = () => Date.now(),
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearSchedule = (t) => clearTimeout(t),
  onStateChange = () => {},
  resolveApp = (ref) => resolveConsentApp(ref),
  promptTimeoutMs = 120_000,
  gapMs = 2_000,
  perMinute = 5,
} = {}) {
  let helperConsent = false;
  let active = null;
  let closedAt = -Infinity;
  const started = [];

  const updateGlobalPending = (open) => { daemonPromptOpen = open; };

  function finishActive(decision, auth) {
    if (!active || active.answered) return;
    const current = active;
    current.answered = true;
    active = null;
    updateGlobalPending(false);
    clearSchedule(current.timer);
    closedAt = now();
    onStateChange();
    if (decision === "allow" && auth === "local") {
      current.resolve(consent.withSession(current.sessionId, () => current.onAllow(epochNow())));
    } else {
      if (decision === "deny" && auth === "none") consent.withSession(current.sessionId, () => current.onDeny?.());
      current.resolve({ ok: false, error: { code: decision === "cancel" ? "cancelled" : "consent_declined", message: decision === "cancel" ? "The computer session ended before the user decided." : DECLINED_MESSAGE } });
    }
  }

  return {
    get helperConsent() { return helperConsent; },
    get pending() { return active !== null && !active.answered; },
    cancel(sessionId) {
      if (active && (sessionId === undefined || active.sessionId === sessionId)) finishActive("cancel", "none");
    },
    activePromptPayload() {
      if (!active || active.answered) return null;
      return {
        id: active.id,
        expiresAt: active.expiresAt,
        headline: active.headline,
        reason: active.reason,
        lines: active.lines,
        ...(active.host ? { host: active.host } : {}),
      };
    },
    handleControlMessage(msg) {
      if (!msg || typeof msg !== "object") return { handled: false, sendStatus: false };
      if (msg.command === "capabilities") {
        if (msg.consent === 1) helperConsent = true;
        return { handled: true, sendStatus: true };
      }
      if (msg.command === "consent_decision") {
        if (!helperConsent || !active || active.answered) return { handled: true, sendStatus: false };
        if (typeof msg.consent !== "string" || msg.consent !== active.id) return { handled: true, sendStatus: false };
        if (epochNow() >= active.expiresAt) {
          finishActive("deny", "expired");
          return { handled: true, sendStatus: false };
        }
        const allowed = msg.decision === "allow" && msg.auth === "local";
        finishActive(allowed ? "allow" : "deny", allowed ? "local" : String(msg.auth ?? "none"));
        return { handled: true, sendStatus: false };
      }
      return { handled: false, sendStatus: false };
    },
    async deny(req) {
      if (req?.scope === "foreground") {
        consent.recordForeground("local", "deny", { remember: false });
        return { ok: true, scope: "foreground", decision: "deny" };
      }
      let app = req?.app ?? req;
      let keys = Array.isArray(req?.keys) ? req.keys.filter((k) => typeof k === "string") : consent.appKeys(app);
      if (!keys.length) return { ok: false, error: { code: "bad_args", message: "consent_deny needs an app identity or scope:\"foreground\"" } };
      if (!Array.isArray(req?.keys)) {
        try { const resolved = await resolveApp(app); app = resolved.resolved; keys = resolved.keys; }
        catch (error) { return { ok: false, error: { code: error.code ?? "consent_identity_ambiguous", message: error.message } }; }
      }
      consent.record("local", keys, "deny", { remember: false, name: app?.name ?? null });
      return { ok: true, scope: "app", decision: "deny", app, keys };
    },
    revoke(req) {
      if (req?.scope === "foreground") {
        if (consent.foregroundDecision("local").state === "allowed") consent.revokeForeground("local");
        return { ok: true, scope: "foreground" };
      }
      const keys = Array.isArray(req?.keys) ? req.keys.filter((k) => typeof k === "string") : consent.appKeys(req?.app ?? req);
      if (!keys.length) return { ok: false, error: { code: "bad_args", message: "consent_revoke needs an app identity or scope:\"foreground\"" } };
      if (consent.decisionFor("local", keys).state === "allowed") consent.revoke("local", keys);
      return { ok: true, scope: "app", keys };
    },
    async request(req, { signal } = {}) {
      const generation = controlGeneration;
      if (!helperConsent) {
        return { ok: false, error: { code: "consent_needs_user", message: "The running Codewhale Computer Use helper does not support the approval panel; update and restart the Computer Use app." } };
      }
      if (active || liveMarker({ fs, dir: stateDir() })?.state === "open") {
        return { ok: false, error: { code: "consent_pending", message: "A Computer Use approval dialog is already open on this Mac; wait for the person to answer it." } };
      }
      const trusted = consent.status("local").host;
      if (trusted?.trusted && ["allow_app", "allow_foreground"].includes(req?.kind)) {
        if (req.kind === "allow_foreground") return consent.foregroundDecision("local").state === "allowed"
          ? { ok: true, decision: "allow", scope: "foreground", persisted: trusted.persisted }
          : { ok: false, error: { code: "foreground_denied", message: "Foreground control is excluded. The user can change exclusions in Computer Use." } };
        try {
          const { resolved, keys } = await resolveApp(req.app);
          return consent.decisionFor("local", keys).state === "allowed"
            ? { ok: true, decision: "allow", app: resolved, keys, persisted: trusted.persisted }
            : { ok: false, error: { code: "app_denied", message: "This app is excluded. The user can change exclusions in Computer Use." } };
        } catch (error) { return { ok: false, error: { code: error.code ?? "consent_identity_ambiguous", message: error.message } }; }
      }
      const checkRate = () => {
        const t = now();
        if (t < closedAt + gapMs) {
          return { ok: false, error: { code: "consent_rate_limited", message: "An approval dialog just closed. Do not ask again right away.", retry_after_s: Math.max(1, Math.ceil((closedAt + gapMs - t) / 1000)) } };
        }
        while (started.length && started[0] <= t - 60_000) started.shift();
        if (started.length >= perMinute) {
          return { ok: false, error: { code: "consent_rate_limited", message: `${perMinute} approval dialogs were shown in the last minute. Do not ask again right away.`, retry_after_s: Math.max(1, Math.ceil((started[0] + 60_000 - t) / 1000)) } };
        }
        return null;
      };
      const earlyRate = checkRate();
      if (earlyRate && !(req?.kind === "app_script" && consent.status("local").host?.trusted && earlyRate.error.code === "consent_rate_limited" && earlyRate.error.retry_after_s <= 2)) return earlyRate;
      if (earlyRate) {
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, earlyRate.error.retry_after_s * 1000);
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }

      let headline;
      let reason;
      let lines = [];
      let onAllow;
      let onDeny;
      let host;
      const kind = req?.kind;
      if (kind === "trust_host") {
        const label = cleanLine(String(req.host?.label || "This connection"), 80);
        const publicKey = req.host?.publicKey;
        if (publicKey != null && (typeof publicKey !== "string" || !/^[A-Za-z0-9+/]{59}=$/.test(publicKey))) {
          return { ok: false, error: { code: "bad_args", message: "Host pairing needs a valid public key." } };
        }
        host = { publicKey: publicKey ?? null, label, persistent: req.host?.persistent === true && publicKey != null, exclusions: Array.isArray(req.host?.exclusions) ? req.host.exclusions : [] };
        headline = `Let ${label} use your Mac?`;
        reason = `approve computer access for ${label}`;
        lines = ["Can read app contents, take screenshots, use the clipboard, and control the keyboard and pointer.", "Changing apps or models will not ask again. You can stop computer use at any time from the menu bar."];
        lines.push(host.persistent ? "Access stays on until you turn it off in Computer Use settings." : "Access ends when this connection closes.");
        if (host.exclusions.length) lines.push("Existing app and foreground exclusions will be retained.");
        onAllow = () => ({ ok: true, decision: "allow", scope: "host", persisted: host.persistent });
      } else if (kind === "allow_app") {
        let resolvedApp;
        try { resolvedApp = await resolveApp(req.app); } catch (err) {
          return { ok: false, error: { code: err?.code ?? "consent_identity_ambiguous", message: String(err?.message ?? err) } };
        }
        const { resolved, keys } = resolvedApp;
        const appLabel = visible(resolved.name ?? resolved.bundle_id ?? `pid ${resolved.pid}`, 45, { cut: true }).slice(1, -1);
        headline = cleanLine(`Allow Computer Use to see and operate ${appLabel}.`, 240);
        reason = cleanLine(`approve Computer Use access to ${appLabel}`, 90);
        if (resolved.name != null) lines.push(cleanLine(`App name: ${visible(resolved.name, 120, { what: "the app name" })}`, 240));
        if (resolved.bundle_id != null) lines.push(cleanLine(`Bundle id: ${visible(resolved.bundle_id, 180, { what: "the bundle id" })}`, 240));
        if (resolved.pid != null) lines.push(cleanLine(`Process id: ${Number(resolved.pid)} (this session only)`, 240));
        if (resolvedApp.running === false) lines.push("App is not running. Access applies only to the name or bundle id shown above.");
        lines.push("Scope: this session only");
        onDeny = () => consent.record("local", keys, "deny", { remember: false, name: resolved.name ?? null });
        onAllow = () => {
          consent.record("local", keys, "allow", { remember: false, name: resolved.name ?? null });
          return { ok: true, decision: "allow", app: resolved, keys, persisted: false };
        };
      } else if (kind === "allow_foreground") {
        headline = "Allow Computer Use to share your pointer and keyboard (foreground control).";
        reason = "approve Computer Use foreground control";
        lines = ["Scope: shared desktop (foreground control), this session only"];
        onDeny = () => consent.recordForeground("local", "deny", { remember: false });
        onAllow = () => {
          consent.recordForeground("local", "allow", { remember: false });
          return { ok: true, decision: "allow", scope: "foreground", persisted: false };
        };
      } else if (kind === "app_script") {
        if (typeof req.script !== "string" || !req.script.trim()) {
          return { ok: false, error: { code: "bad_args", message: "app_script needs a non-empty script string" } };
        }
        if (req.language != null && !["applescript", "javascript"].includes(req.language)) {
          return { ok: false, error: { code: "bad_args", message: 'app_script language must be "applescript" or "javascript"' } };
        }
        const policy = checkAppScript(req.script, req.language);
        if (policy.refused) {
          return { ok: false, error: { code: "script_refused", message: `app_script refused: ${policy.refused}` } };
        }
        for (const ref of policy.targets) {
          if (consent.decisionFor("local", consent.appKeys(ref)).state === "denied") {
            return { ok: false, error: { code: "app_denied", message: `the user denied access to ${ref.name ?? ref.bundle_id ?? `pid ${ref.pid}`} on this computer` } };
          }
          if (consent.hostExclusions("local").some(key => key !== "scope:foreground")) {
            try {
              const resolved = await resolveApp(ref);
              if (consent.decisionFor("local", resolved.keys).state !== "allowed") return { ok: false, error: { code: "app_denied", message: "This script targets an excluded app." } };
            } catch { return { ok: false, error: { code: "app_denied", message: "This script's app identity could not be checked against excluded apps." } }; }
          }
        }
        let escapedScript;
        try {
          escapedScript = visible(req.script, 1000, { what: "the script" });
        } catch (err) {
          return { ok: false, error: { code: err?.code ?? "script_too_long", message: String(err?.message ?? err) } };
        }
        const targetNames = policy.targets.map((t) => visible(t.name ?? t.bundle_id, 60, { cut: true })).join(", ");
        headline = "Run this app script.";
        reason = "approve running this Computer Use app script";
        lines.push(cleanLine(`Language: ${visible(req.language ?? "applescript", 20, { what: "the language" })}`, 240));
        lines.push(cleanLine(`Apps it names: ${targetNames || "none"}`, 240));
        const fullScriptLine = `Script: ${escapedScript}`;
        for (let offset = 0; offset < fullScriptLine.length && lines.length < 8; offset += 220) {
          lines.push(cleanLine(fullScriptLine.slice(offset, offset + 220), 240));
        }
        onAllow = (allowNowMs) => {
          for (const t of policy.targets) {
            const keys = consent.appKeys(t);
            if (keys.length) consent.record("local", keys, "allow", { remember: false, name: t.name ?? null });
          }
          const approvalToken = issueAppScriptToken(req.language, req.script, allowNowMs);
          return { ok: true, decision: "allow", approvalToken, targets: policy.targets };
        };
      } else {
        return { ok: false, error: { code: "bad_args", message: `unknown consent_request kind "${String(kind ?? "")}"` } };
      }

      if (!helperConsent) {
        return { ok: false, error: { code: "consent_needs_user", message: "The running Codewhale Computer Use helper does not support the approval panel; update and restart the Computer Use app." } };
      }
      if (active || liveMarker({ fs, dir: stateDir() })?.state === "open") {
        return { ok: false, error: { code: "consent_pending", message: "A Computer Use approval dialog is already open on this Mac; wait for the person to answer it." } };
      }
      const lateRate = checkRate();
      if (lateRate) return lateRate;
      if (signal?.aborted || generation !== controlGeneration || controlMode !== "ready") {
        return { ok: false, error: { code: "cancelled", message: "the request ended before the user decided" } };
      }

      const id = crypto.randomBytes(16).toString("hex");
      const expiresAt = epochNow() + promptTimeoutMs;
      started.push(now());
      return new Promise((resolve) => {
        const onAbort = () => {
          if (active?.id === id) {
            const current = active;
            current.answered = true;
            active = null;
            updateGlobalPending(false);
            clearSchedule(current.timer);
            closedAt = now();
            onStateChange();
          }
          resolve({ ok: false, error: { code: "cancelled", message: "the request ended before the user decided" } });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = schedule(() => {
          if (active?.id === id) finishActive("deny", "expired");
        }, promptTimeoutMs);
        active = {
          id,
          sessionId: consent.currentSession(),
          expiresAt,
          headline: cleanLine(headline, 240),
          reason: cleanLine(reason, 90),
          lines: lines.slice(0, 8).map((l) => cleanLine(l, 240)).filter(Boolean),
          answered: false,
          timer,
          onAllow,
          onDeny,
          host,
          resolve: (res) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(res);
          },
        };
        updateGlobalPending(true);
        onStateChange();
      });
    },
  };
}

/**
 * The runner's own policy, applied whoever sent the request: the MCP server,
 * or any other process that reaches this socket.
 */
function policyRefusal(tool, args, computerId) {
  if (computerId === "local" && tool !== "list_sessions" && !(tool === "list_apps" && args.all !== true && args.installed !== true)
      && (daemonPromptOpen || liveMarker({ fs, dir: stateDir() })?.state === "open")) {
    return { code: "consent_pending", message: "A Computer Use approval dialog is open on this Mac; this runner refuses input and observation from every caller until the person answers it." };
  }
  let targets = namedApps(tool, args);
  if (tool === "open_application") {
    const refusal = launchRefusal(args, process.platform, { remote: computerId !== "local" });
    if (refusal) return refusal;
  }
  if (tool === "app_script") {
    const policy = checkAppScript(args.script, args.language);
    if (policy.refused) return { code: "script_refused", message: `app_script refused: ${policy.refused}` };
    targets = policy.targets;
  }
  for (const ref of targets) {
    if (consent.decisionFor(computerId, consent.appKeys(ref)).state === "denied") {
      return { code: "app_denied", message: `the user denied access to ${ref.name ?? ref.bundle_id ?? `pid ${ref.pid}`} on this computer` };
    }
  }
  return null;
}

async function listBackendApps(instance, installed = false) {
  if (typeof instance?.list_apps !== "function") return null;
  try {
    const res = await instance.list_apps({ all: true, ...(installed ? { installed: true } : {}) });
    return Array.isArray(res) ? res : Array.isArray(res?.apps) ? res.apps : null;
  } catch {
    return null;
  }
}

async function decisionForLocalRef(instance, computerId, ref, cachedApps) {
  const keys = consent.appKeys(ref);
  if (!keys.length) return { state: "undecided", ref };
  const direct = consent.decisionFor(computerId, keys);
  const restricted = consent.hostExclusions(computerId).some(key => key !== "scope:foreground");
  if (direct.state === "denied" || (direct.state === "allowed" && direct.via !== "scope:host" && !restricted)) return { state: direct.state, ref };
  const apps = cachedApps.value === undefined ? (cachedApps.value = await listBackendApps(instance)) : cachedApps.value;
  if (!Array.isArray(apps)) return { state: restricted ? "undecided" : direct.state, ref };
  const wantName = ref.name?.trim().replace(/\.app$/i, "").toLowerCase();
  const wantBundle = ref.bundle_id?.trim().toLowerCase();
  const matches = (a) => (ref.pid == null || a.pid === ref.pid)
    && (!wantBundle || String(a.bundle_id ?? "").trim().toLowerCase() === wantBundle)
    && (!wantName || String(a.name ?? "").trim().replace(/\.app$/i, "").toLowerCase() === wantName);
  let hits = apps.filter(matches);
  if (!hits.length && restricted && ref.pid == null) hits = (await listBackendApps(instance, true) ?? []).filter(matches);
  if (hits.length !== 1) return { state: restricted || hits.length > 1 ? "undecided" : direct.state, ref };
  const [hit] = hits;
  const resolved = { name: hit.name ?? null, pid: hit.pid ?? null, bundle_id: hit.bundle_id ?? null };
  const widened = consent.decisionFor(computerId, consent.appKeys(resolved));
  return { state: widened.state, ref: resolved };
}

function refRefusal(verdict, ref) {
  const desc = ref?.name ?? ref?.bundle_id ?? (ref?.pid ? `pid ${ref.pid}` : "the application");
  if (verdict === "denied") {
    return { code: "app_denied", message: `the user denied access to ${desc} on this computer` };
  }
  return { code: "consent_required", message: `Codewhale needs the user's permission to use ${desc} on this computer.` };
}

async function localConsentRefusal(tool, args, computerId, session, instance) {
  if (computerId !== "local") return null;
  if (hasMalformedOrUnsupportedSelector(tool, args)) return null;
  const appExclusions = consent.hostExclusions(computerId).filter(key => key !== "scope:foreground");
  if (appExclusions.length && tool.startsWith("browser_")) return { code: "app_denied", message: "Browser automation cannot identify excluded desktop apps. Use an allowed app through its accessibility controls." };

  if (tool === "app_script") {
    if (appExclusions.length) {
      const policy = checkAppScript(args.script, args.language);
      const cached = { value: undefined };
      for (const ref of policy.targets) {
        const verdict = await decisionForLocalRef(instance, computerId, ref, cached);
        if (verdict.state !== "allowed") return { code: "app_denied", message: "This script's app identity is excluded or could not be verified." };
      }
    }
    if (!consumeAppScriptToken(args.approvalToken, args.language, args.script)) {
      return { code: "consent_required", message: "app_script requires a fresh single-use approval token from the user." };
    }
    return null;
  }

  const cachedApps = { value: undefined };

  if (tool === "open_application" || tool === "kill_app") {
    const refs = namedApps(tool, args);
    if (!refs.length) {
      if (tool === "open_application" && args.activate === true) {
        return { code: "consent_required", message: "Foreground selection needs a named application approved by the user." };
      }
      return null;
    }
    for (const ref of refs) {
      const { state, ref: known } = await decisionForLocalRef(instance, computerId, ref, cachedApps);
      if (state !== "allowed") return refRefusal(state, known);
    }
    if (tool === "open_application" && args.activate === true && consent.foregroundDecision(computerId).state === "denied") {
      return { code: "foreground_denied", message: "the user denied shared-desktop (foreground) control on this computer" };
    }
    return null;
  }

  const explicitRefs = [];
  if (args.app_ref && typeof args.app_ref === "object") {
    explicitRefs.push(...expandRefFields(args.app_ref));
  }
  for (const field of ["target", "from_target", "to"]) {
    const t = args[field];
    if (!t || typeof t !== "object") continue;
    const isElement = t.type === "element" || t.strategy === "a11y" || t.strategy === "a11y-center" || Array.isArray(t.path);
    if (t.app_ref && typeof t.app_ref === "object") {
      const fields = expandRefFields(t.app_ref);
      if (fields.length) explicitRefs.push(...fields);
      else if (isElement && !(session.targetRef ?? session.target)) return { code: "consent_required", message: "Element target requires an approved application." };
    } else if (isElement && !(session.targetRef ?? session.target)) {
      return { code: "consent_required", message: "Element target requires an approved application." };
    }
  }

  for (const ref of explicitRefs) {
    const { state, ref: known } = await decisionForLocalRef(instance, computerId, ref, cachedApps);
    if (state !== "allowed") return refRefusal(state, known);
  }

  const wholeScreen = args.app_ref == null && (
    (tool === "screenshot" && (!explicitRefs.length && !(session.targetRef ?? session.target) || args.display != null || args.region != null))
    || (tool === "zoom" && !explicitRefs.length && !(session.targetRef ?? session.target))
    || ((tool === "recordingStart" || tool === "recording_start") && (args.window_id == null || process.platform !== "darwin")));

  if (wholeScreen) {
    if (appExclusions.length) return { code: "app_denied", message: "Whole-screen capture may show an excluded app. Capture one allowed app with app_ref." };
    if (!consent.anyAllowed(computerId)) {
      return { code: "consent_required", message: "No application on this computer has the user's approval yet, and a whole-screen capture shows every app on it." };
    }
    const apps = cachedApps.value === undefined ? (cachedApps.value = await listBackendApps(instance)) : cachedApps.value;
    const front = Array.isArray(apps) ? apps.find((a) => a.frontmost === true && Number.isInteger(a.pid) && a.pid > 0) : null;
    if (front) {
      const { state, ref: known } = await decisionForLocalRef(instance, computerId, front, cachedApps);
      if (state === "denied") return refRefusal("denied", known);
    }
    return null;
  }

  if (!explicitRefs.length && BOUND_TARGET_TOOLS.has(tool)) {
    const bound = session.targetRef ?? session.target;
    if (bound) {
      const { state, ref: known } = await decisionForLocalRef(instance, computerId, bound, cachedApps);
      if (state !== "allowed") return refRefusal(state, known);
      return null;
    }
    if (tool === "preview") return null;
    if ((KEYBOARD_INPUT_TOOLS.has(tool) || POINTER_INPUT_TOOLS.has(tool) || tool === "left_click_drag") && typeof instance?.input_owner === "function") {
      try {
        const at = args.target && Number.isFinite(args.target.x) && Number.isFinite(args.target.y) ? { x: args.target.x, y: args.target.y } : undefined;
        const owner = await instance.input_owner({ kind: KEYBOARD_INPUT_TOOLS.has(tool) ? "keyboard" : "pointer", ...(at ? { point: at } : {}) });
        if (owner === null) return null;
        if (owner && typeof owner === "object") {
          const keys = [
            ...consent.appKeys({ name: owner.name }),
            ...consent.appKeys({ name: owner.comm }),
            ...consent.appKeys({ pid: owner.pid }),
            ...(Array.isArray(owner.aliases) ? owner.aliases.flatMap((name) => consent.appKeys({ name })) : []),
          ];
          const verdict = consent.decisionFor(computerId, [...new Set(keys)], { pidName: owner.name ?? null });
          if (verdict.state !== "allowed") return refRefusal(verdict.state, owner);
          return null;
        }
      } catch {}
    }
    if (!consent.anyAllowed(computerId)) {
      return { code: "consent_required", message: "No application is approved for this session." };
    }
    if (IMPLICIT_FRONTMOST_TOOLS.has(tool) && typeof instance?.list_apps === "function") {
      const apps = cachedApps.value === undefined ? (cachedApps.value = await listBackendApps(instance)) : cachedApps.value;
      const front = Array.isArray(apps) ? apps.find((a) => a.frontmost === true && Number.isInteger(a.pid) && a.pid > 0) : null;
      if (!front) return { code: "consent_required", message: "No application is named, bound or identifiably frontmost." };
      const { state, ref: known } = await decisionForLocalRef(instance, computerId, front, cachedApps);
      if (state !== "allowed") return refRefusal(state, known);
      return null;
    }
    if (typeof instance?.open_application === "function") {
      return { code: "consent_required", message: "No application is bound to this session; call open_application for an approved app first." };
    }
  }

  return null;
}

/**
 * Execute one {tool, args} request on this machine's backend. Never throws:
 * every outcome is a receipt object with `ok`.
 */
export async function handle(req, { computerId = "local", sessionId = "direct", signal, persistentInputOwner = false, requestConsent, onStateChange = () => {} } = {}) {
  const tool = req?.tool;
  if (!ALLOWED.has(tool)) {
    return { ok: false, error: { code: "tool_not_allowed", message: `tool "${tool}" is not in the remote allow-list` } };
  }
  if (LOCAL_ONLY_TOOLS.has(tool) && computerId !== "local") {
    return { ok: false, error: { code: "unsupported_on_transport", message: `"${tool}" runs on the local computer only — a remote agent stays a computer-use channel, never a shell` } };
  }
  if (tool === "platform") return { ok: true, platform: process.platform };
  const refusal = policyRefusal(tool, req.args ?? {}, computerId);
  if (refusal) return { ok: false, platform: process.platform, tool, error: refusal };
  if (controlMode !== "ready") return { ok: false, error: { code: `control_${controlMode}`, message: `Computer Use is ${controlMode} by the user. Wait for them to resume it in the menu bar.` } };
  const generation = controlGeneration;
  const key = `${computerId}:${sessionId}`;
  let session = sessions.get(key);
  if (!session) {
    // Retain closed-session tombstones briefly, and bound abandoned sessions
    // when a host is killed without a graceful MCP disconnect.
    for (const [id, old] of sessions) {
      if (old.requests.size || Date.now() - old.touched <= (old.closed ? 300_000 : 3_600_000)) continue;
      if (backends.has(id)) {
        const colon = id.indexOf(":");
        try { await closeSession(id.slice(colon + 1), id.slice(0, colon)); }
        catch (err) { return { ok: false, error: { code: "input_release_failed", message: String(err?.message ?? err) } }; }
      } else sessions.delete(id);
    }
    if ([...sessions.values()].filter((entry) => !entry.closed).length >= 256) return { ok: false, error: { code: "session_limit", message: "Too many active computer sessions; close unused hosts or restart the helper." } };
    session = { requests: new Set(), closed: false, touched: Date.now() };
    sessions.set(key, session);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted || session.closed) controller.abort();
  session.requests.add(controller);
  // One desktop can execute only one input gesture at a time. The queue spans
  // sockets and sessions; a disconnected/cancelled request is checked again
  // when its slot arrives, before it can post any input.
  try {
    return await enqueue(() => withSignal(controller.signal, async () => {
      throwIfAborted();
      if (generation !== controlGeneration || controlMode !== "ready") throw Object.assign(new Error("Computer control was interrupted by the user."), { code: "cancelled" });
      const instance = await backend(computerId, sessionId, persistentInputOwner);
      throwIfAborted();
      let rawArgs = req.args ?? {};
      let consentRefusal = await localConsentRefusal(tool, rawArgs, computerId, session, instance);
      if (consentRefusal?.code === "consent_required" && computerId === "local" && tool === "open_application" && typeof requestConsent === "function" && namedApps(tool, rawArgs).length) {
        if (rawArgs.activate === true && consent.foregroundDecision(computerId).state === "denied") return { ok: false, platform: process.platform, tool, error: { code: "foreground_denied", message: "the user denied foreground control on this computer" } };
        const app = Object.fromEntries(["name", "bundle_id", "pid"].filter((field) => rawArgs[field] != null).map((field) => [field, rawArgs[field]]));
        const approved = await requestConsent({ kind: "allow_app", app }, controller.signal);
        if (!approved?.ok) return { ok: false, platform: process.platform, tool, error: approved?.error ?? { code: "consent_declined", message: DECLINED_MESSAGE } };
        throwIfAborted();
        consentRefusal = await localConsentRefusal(tool, rawArgs, computerId, session, instance);
      }
      if (consentRefusal?.code === "consent_required" && computerId === "local" && tool === "app_script" && typeof requestConsent === "function" && !Object.hasOwn(rawArgs, "approvalToken")) {
        const approved = await requestConsent({ kind: "app_script", language: rawArgs.language, script: rawArgs.script }, controller.signal);
        if (!approved?.ok) return { ok: false, platform: process.platform, tool, error: approved?.error ?? { code: "consent_declined", message: DECLINED_MESSAGE } };
        throwIfAborted();
        rawArgs = { ...rawArgs, approvalToken: approved.approvalToken };
        consentRefusal = await localConsentRefusal(tool, rawArgs, computerId, session, instance);
      }
      if (consentRefusal) return { ok: false, platform: process.platform, tool, error: consentRefusal };
      throwIfAborted();
      session.action = tool;
      if (session.target && BOUND_TARGET_TOOLS.has(tool) && !rawArgs.app_ref && !rawArgs.target?.app_ref) session.displayTarget = session.target;
      onStateChange();
      if (tool === "open_application") { session.target = null; session.targetRef = null; session.displayTarget = null; session.mode = null; dropAppWriters(key); }
      const holder = heldPointers.get(computerId);
      if (INPUT_MUTATIONS.has(tool) && holder && holder !== key) {
        if (!inputOwnerIdle(holder)) {
          return { ok: false, error: { code: "input_busy", message: "Another computer session owns a held pointer; release it or close that session before sending input." } };
        }
        await withSignal(null, () => backends.get(holder)?.releaseInput?.());
        if (heldPointers.get(computerId) === holder) heldPointers.delete(computerId);
      }
      const app = INPUT_MUTATIONS.has(tool) && tool !== "open_application" && Number.isInteger(session.target?.pid) ? `${computerId}:${session.target.pid}` : null;
      const writer = app ? appWriters.get(app) : null;
      if (writer && writer.key !== key && !inputOwnerIdle(writer.key)) {
        return { ok: false, error: { code: "input_busy", message: `Another computer session is sending input to ${session.target.name}. Wait for it to finish or work in another app; its claim lapses after ${INPUT_IDLE_MS / 1000} s without a request from that session (list_sessions shows who holds it).` } };
      }
      if (app) appWriters.set(app, { key });
      const fn = instance[tool];
      if (typeof fn !== "function") {
        return { ok: false, error: { code: "unsupported_on_platform", message: `"${tool}" is not implemented on ${process.platform}` } };
      }
      // Preserve ownership across calls, not just during the serialized
      // request. Another host's click/up must not release this host's press.
      if (tool === "left_mouse_down") heldPointers.set(computerId, key);
      let callArgs = rawArgs;
      if (tool === "app_script" && callArgs && typeof callArgs === "object" && "approvalToken" in callArgs) {
        const { approvalToken: _token, ...rest } = callArgs;
        callArgs = rest;
      }
      let data;
      try { data = await fn(callArgs); throwIfAborted(); }
      catch (error) {
        if (["left_mouse_down", "left_mouse_up", "mouse_move"].includes(tool) && heldPointers.get(computerId) === key) {
          await withSignal(null, () => instance.releaseInput?.());
          if (heldPointers.get(computerId) === key) heldPointers.delete(computerId);
        }
        throw error;
      }
      if (tool === "left_mouse_up" && heldPointers.get(computerId) === key) heldPointers.delete(computerId);
      if (tool === "open_application" && data?.resolved) {
        session.target = { name: String(data.resolved.name ?? "Application").slice(0, 128), pid: data.resolved.pid };
        session.displayTarget = session.target;
        session.targetRef = data.resolved;
        session.mode = data.shared_pointer || data.activate ? "foreground" : "background";
        if (computerId === "local") {
          consent.alias(computerId, consent.appKeys(data.resolved), { persisted: false, name: data.resolved.name ?? null });
        }
      }
      if (tool === "get_app_state" && data?.found && Number.isInteger(data.pid) && data.pid > 0) session.displayTarget = { name: String(data.name ?? "Application").slice(0, 128), pid: data.pid };
      return { ok: true, platform: process.platform, tool, data };
    }));
  } catch (err) {
    return { ok: false, platform: process.platform, tool, error: { code: err?.code ?? "tool_error", message: String(err?.message ?? err), ...(err?.inputMayHaveBeenSent || err?.requestDispatched ? { request_dispatched: true } : {}) } };
  } finally {
    signal?.removeEventListener("abort", abort);
    session.requests.delete(controller);
    session.action = null;
    session.touched = Date.now();
    onStateChange();
  }
}
