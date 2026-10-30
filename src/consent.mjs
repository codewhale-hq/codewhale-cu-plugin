// Per-app consent ledger: which applications this host may drive on each
// computer, and whether it may take the shared pointer/foreground at all.
//
// In strict approval mode (src/approval-mode.mjs) the app, not the tool, is the
// unit of trust: the first call that targets an app — binding input to it,
// observing it by name, or acting through a bound or element target — refuses
// with consent_required until a decision exists. In standard mode an app with
// no recorded decision is admitted by the callers in mcp/server.mjs and
// src/app-handler.mjs; the OS grants, Pause/Stop and explicit denies are the
// controls. A deny wins in both modes.
// Decisions are "allow" or "deny"; a bare grant lives for this server session,
// remember:true persists it to consent.json.
//
// Two scopes:
//   apps        — keyed by resolved identity (bundle id, name, pid)
//   foreground  — optional computer-wide override; app approval otherwise covers activation
//
// This is a model-level ledger, not an OS sandbox: a determined agent with
// another channel could still reach an app. What it buys is a deny the host can
// actually enforce on this surface.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { stateDir } from "./registry.mjs";
import { approvalMode } from "./approval-mode.mjs";

// Persisted allows are signed. consent.json is a file any process of this
// user can write, so an allow counts only when it carries a MAC under the
// ledger key the host keeps in its secret store (sent over the host channel,
// see server.mjs). Denies need no signature: they only narrow. Without a
// ledger key, allows live for the session only.
let ledgerKey = null;
export function setLedgerKey(key) { ledgerKey = Buffer.isBuffer(key) && key.length >= 32 ? key : null; }
export const persistsAllows = () => ledgerKey != null;
function entryMac(computerId, key, entry) {
  return crypto.createHmac("sha256", ledgerKey).update(`${computerId}\0${key}\0${entry.decision}\0${entry.at ?? ""}`).digest("hex");
}
function signed(computerId, key, entry) {
  return entry.decision === "allow" && ledgerKey ? { ...entry, mac: entryMac(computerId, key, entry) } : entry;
}
/** A persisted entry that may be honored: any deny, or an allow whose MAC verifies. */
function honored(computerId, key, entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.decision === "deny") return true;
  if (entry.decision !== "allow" || !ledgerKey || typeof entry.mac !== "string") return false;
  const expected = Buffer.from(entryMac(computerId, key, entry), "hex");
  const given = /^[0-9a-f]+$/i.test(entry.mac) ? Buffer.from(entry.mac, "hex") : Buffer.alloc(0);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const consentPath = () => path.join(stateDir(), "consent.json");

/** Computer and host session -> Map(key -> {decision, name?, at}); never persisted. */
const session = new Map();
const hostAccess = new Map();
const sessionScope = new AsyncLocalStorage();
export const currentSession = () => sessionScope.getStore();
export const withSession = (sessionId, operation) => sessionScope.run(sessionId, operation);
export function setHostAccess(sessionId, grant) {
  if (grant) hostAccess.set(sessionId, { persisted: grant.persisted === true, exclusions: new Set(grant.exclusions ?? []) });
  else hostAccess.delete(sessionId);
}
const hostGrant = (computerId) => computerId === "local" ? hostAccess.get(currentSession()) : null;
export const hostExclusions = (computerId) => [...(hostGrant(computerId)?.exclusions ?? [])];
export function clearSessionDenials(computerId) {
  const entries = session.get(sessionKey(computerId));
  for (const [key, entry] of entries ?? []) if (entry.decision === "deny") entries.delete(key);
}
const sessionKey = (computerId) => currentSession() == null ? computerId : `${computerId}:${currentSession()}`;
function sessionMap(computerId) {
  const key = sessionKey(computerId);
  let m = session.get(key);
  if (!m) { m = new Map(); session.set(key, m); }
  return m;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(consentPath(), "utf8"));
    if (!raw || typeof raw !== "object" || !raw.computers) throw new Error("bad shape");
    return raw;
  } catch {
    return { version: 1, computers: {} };
  }
}

function save(data) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = consentPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, consentPath());
}

/**
 * Identity keys for an app reference. name/bundle match the native resolver's
 * case-insensitive compare, so keys normalize lowercase. pid entries are
 * session-only — a pid never outlives its process, so persisting one would
 * grant (or deny) whichever app inherits the number next.
 */
export function appKeys(ref) {
  const keys = [];
  if (!ref || typeof ref !== "object") return keys;
  if (typeof ref.bundle_id === "string" && ref.bundle_id.trim()) keys.push(`bundle:${ref.bundle_id.trim().toLowerCase()}`);
  // A ".app" suffix is a filesystem spelling, not part of the name — the
  // native resolver strips it, and so must the ledger.
  if (typeof ref.name === "string" && ref.name.trim()) keys.push(`name:${ref.name.trim().replace(/\.app$/i, "").toLowerCase()}`);
  if (Number.isInteger(ref.pid) && ref.pid > 0) keys.push(`pid:${ref.pid}`);
  return keys;
}

/** Split a caller-supplied app string into identity keys. */
export function parseAppArg({ app, name, bundle_id, pid } = {}) {
  const ref = {};
  if (typeof bundle_id === "string" && bundle_id.trim()) ref.bundle_id = bundle_id.trim();
  if (typeof name === "string" && name.trim()) ref.name = name.trim();
  if (Number.isInteger(pid) && pid > 0) ref.pid = pid;
  if (typeof app === "string" && app.trim() && !Object.keys(ref).length) {
    const s = app.trim();
    if (/^pid:\d+$/i.test(s)) ref.pid = Number(s.slice(4));
    else if (/^\d+$/.test(s)) ref.pid = Number(s);
    // ".app" is a filename spelling and always means a name — it must be
    // checked before the reverse-DNS shape, which it also satisfies.
    else if (/\.app$/i.test(s)) ref.name = s.replace(/\.app$/i, "");
    // Reverse-DNS shape (com.foo.bar, no spaces) reads as a bundle id.
    else if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s) && !s.includes(" ")) ref.bundle_id = s;
    else ref.name = s;
  }
  return appKeys(ref);
}

function persistedEntries(computerId) {
  const apps = load().computers[computerId]?.apps ?? {};
  return Object.fromEntries(Object.entries(apps).filter(([key, entry]) => honored(computerId, key, entry)));
}
export function legacyExclusions(computerId) {
  const keys = Object.entries(persistedEntries(computerId)).filter(([key, entry]) => entry.decision === "deny" && /^(?:bundle:|name:)/.test(key)).map(([key]) => key);
  if (load().computers[computerId]?.foreground?.decision === "deny") keys.push("scope:foreground");
  return [...new Set(keys)];
}

/**
 * The newest decision among matching keys wins — session entries are checked
 * alongside persisted ones, so "always deny" followed by "allow once" yields
 * allow, and "always allow" followed by a session deny yields deny. Returns
 * {state: allowed|denied|undecided, via, persisted}.
 */
const comparable = (name) => (typeof name === "string" ? name.trim().replace(/\.app$/i, "").toLowerCase() : null);

export function decisionFor(computerId, keys, { pidName } = {}) {
  const host = hostGrant(computerId);
  const excluded = keys.find((key) => host?.exclusions.has(key));
  if (excluded) return { state: "denied", via: excluded, persisted: host.persisted };
  let best = null;
  const consider = (entry, key, persisted) => {
    if (!entry || (entry.decision !== "allow" && entry.decision !== "deny")) return;
    if (pidName !== undefined && key.startsWith("pid:") && entry.decision === "allow") {
      const approved = comparable(entry.name);
      if (!approved || approved !== comparable(pidName)) return;
    }
    // A session entry may itself be backed by disk (remember:true writes
    // both layers and marks the session copy) — durability is honest, not
    // just "which map won".
    const durable = persisted || entry.persisted === true;
    if (!best || String(entry.at ?? "") > String(best.at ?? "")) best = { ...entry, via: key, persisted: durable };
  };
  const sm = session.get(sessionKey(computerId));
  for (const key of keys) {
    consider(sm?.get(key), key, false);
    if (!host) consider(persistedEntries(computerId)[key], key, true);
  }
  if (!best) return host && keys.length ? { state: "allowed", via: "scope:host", persisted: host.persisted } : { state: "undecided" };
  return { state: best.decision === "deny" ? "denied" : "allowed", via: best.via, persisted: best.persisted, name: best.name ?? null };
}

/** Record a decision under every given key. Session-only unless remember. */
export function record(computerId, keys, decision, { remember = false, name = null } = {}) {
  if (!ID_RE.test(computerId)) throw Object.assign(new Error(`bad computer id "${computerId}"`), { code: "bad_args" });
  if (decision !== "allow" && decision !== "deny") throw Object.assign(new Error(`decision must be "allow" or "deny"`), { code: "bad_args" });
  const at = new Date().toISOString();
  const entry = { decision, at, ...(name ? { name } : {}) };
  // pid keys never persist — see appKeys. An allow persists only when it
  // can be signed.
  const persistable = keys.filter((k) => !k.startsWith("pid:"));
  const persist = remember && persistable.length > 0 && (decision === "deny" || ledgerKey != null);
  if (persist) {
    const data = load();
    const apps = (data.computers[computerId] ??= { apps: {} }).apps ??= {};
    for (const key of persistable) apps[key] = signed(computerId, key, { ...entry });
    save(data);
  }
  const sm = sessionMap(computerId);
  const backed = new Set(persist ? persistable : []);
  for (const key of keys) sm.set(key, { ...entry, ...(backed.has(key) ? { persisted: true } : {}) });
  return { keys, decision, persisted: persist };
}

/**
 * Copy an already-made decision onto a resolved identity's other keys — an
 * allow for "Safari" also covers bundle:com.apple.safari once open_application
 * resolves it, so the next request under a different spelling does not
 * re-prompt. Aliases land at the same layer (session or persisted) as the
 * decision they extend.
 */
export function alias(computerId, keys, { persisted = false, name = null } = {}) {
  const at = new Date().toISOString();
  const sm = sessionMap(computerId);
  const entry = { decision: "allow", at, ...(name ? { name } : {}) };
  let durableKeys = new Set();
  if (persisted && ledgerKey) {
    const data = load();
    const apps = (data.computers[computerId] ??= { apps: {} }).apps ??= {};
    for (const key of keys.filter((k) => !k.startsWith("pid:"))) {
      if (!honored(computerId, key, apps[key])) apps[key] = signed(computerId, key, { ...entry });
    }
    save(data);
    // A key already persisted as deny stays deny on disk — the marker only
    // goes on keys whose disk entry is actually this allow.
    durableKeys = new Set(keys.filter((k) => apps[k]?.decision === "allow" && honored(computerId, k, apps[k])));
  }
  for (const key of keys) sm.set(key, { ...entry, ...(durableKeys.has(key) ? { persisted: true } : {}) });
}

/** Remove every trace of the given keys (and foreground when asked) at both layers. */
export function revoke(computerId, keys) {
  const sm = session.get(sessionKey(computerId));
  let removed = 0;
  for (const key of keys) if (sm?.delete(key)) removed++;
  const data = load();
  const apps = data.computers[computerId]?.apps;
  if (apps) {
    for (const key of keys) if (delete apps[key]) removed++;
    save(data);
  }
  return { removed };
}

const launched = new Map();
export function noteLaunched(computerId, app) {
  if (!Number.isInteger(app?.pid) || app.pid <= 0) return;
  const key = sessionKey(computerId);
  if (!launched.has(key)) launched.set(key, new Map());
  launched.get(key).set(app.pid, { bundle_id: app.bundle_id ?? null, name: app.name ?? null });
}
export function ownsKill(computerId, apps, want) {
  const stripped = (name) => String(name ?? "").trim().replace(/\.app$/i, "").toLowerCase();
  const hits = (Array.isArray(apps) ? apps : []).filter((a) => (want.pid == null || a.pid === want.pid)
    && (!want.bundle_id || String(a.bundle_id ?? "").toLowerCase() === String(want.bundle_id).trim().toLowerCase())
    && (!want.name || stripped(a.name) === stripped(want.name)));
  if (hits.length !== 1) return false;
  const entry = launched.get(sessionKey(computerId))?.get(hits[0].pid);
  return !!entry && entry.bundle_id === (hits[0].bundle_id ?? null) && entry.name === (hits[0].name ?? null);
}
export const KILL_NOT_OWNED = "Computer Use quits only apps it launched in this session. Ask the user to quit this app themselves; in strict approval mode they can allow it for this app.";

export function anyDenied(computerId) {
  const host = hostGrant(computerId);
  if (host && [...host.exclusions].some((key) => key !== "scope:foreground")) return true;
  for (const [key, entry] of session.get(sessionKey(computerId)) ?? []) if (key !== "scope:foreground" && entry.decision === "deny") return true;
  return !host && Object.values(persistedEntries(computerId)).some((entry) => entry.decision === "deny");
}

export function anyAllowed(computerId) {
  if (hostGrant(computerId)) return true;
  for (const [key, entry] of session.get(sessionKey(computerId)) ?? []) if (key !== "scope:foreground" && entry.decision === "allow") return true;
  return Object.values(persistedEntries(computerId)).some((entry) => entry.decision === "allow");
}

export function foregroundDecision(computerId) {
  const host = hostGrant(computerId);
  if (host?.exclusions.has("scope:foreground")) return { state: "denied", persisted: host.persisted };
  const s = session.get(sessionKey(computerId))?.get("scope:foreground");
  const stored = load().computers[computerId]?.foreground;
  const p = !host && honored(computerId, "scope:foreground", stored) ? stored : null;
  const pick = [s && { ...s, persisted: s.persisted === true }, p && { ...p, persisted: true }]
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (!pick || (pick.decision !== "allow" && pick.decision !== "deny")) return host ? { state: "allowed", persisted: host.persisted } : { state: "undecided" };
  return { state: pick.decision === "deny" ? "denied" : "allowed", persisted: pick.persisted };
}

export function recordForeground(computerId, decision, { remember = false } = {}) {
  const at = new Date().toISOString();
  const persist = remember && (decision === "deny" || ledgerKey != null);
  sessionMap(computerId).set("scope:foreground", { decision, at, ...(persist ? { persisted: true } : {}) });
  if (persist) {
    const data = load();
    (data.computers[computerId] ??= {}).foreground = signed(computerId, "scope:foreground", { decision, at });
    save(data);
  }
  return { scope: "foreground", decision, persisted: persist };
}

export function revokeForeground(computerId) {
  const sm = session.get(sessionKey(computerId));
  let removed = sm?.delete("scope:foreground") ? 1 : 0;
  const data = load();
  if (data.computers[computerId]?.foreground) { delete data.computers[computerId].foreground; removed++; save(data); }
  return { removed };
}

/** Merged view for consent status: persisted entries overlaid with this session's. */
export function status(computerId) {
  const apps = {};
  if (!hostGrant(computerId)) for (const [key, entry] of Object.entries(persistedEntries(computerId))) apps[key] = { ...entry, source: "persisted" };
  for (const [key, entry] of session.get(sessionKey(computerId)) ?? []) {
    if (key === "scope:foreground") continue;
    apps[key] = { ...entry, source: entry.persisted === true ? "persisted" : "session" };
  }
  const fg = foregroundDecision(computerId);
  const host = hostGrant(computerId);
  return { computer: computerId, approval: approvalMode(), apps, foreground: fg.state === "undecided" ? null : fg, ...(host ? { host: { trusted: true, persisted: host.persisted, exclusions: [...host.exclusions] } } : {}) };
}

/** Drop this session's grants for a computer whose route went away. */
export function dropSession(computerId) {
  session.delete(sessionKey(computerId));
  launched.delete(sessionKey(computerId));
  if (computerId === "local") hostAccess.delete(currentSession());
}
