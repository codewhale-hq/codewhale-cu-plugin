// The desktop app is the local computer's out-of-process runner: a long-lived
// daemon that owns the OS permissions (macOS Accessibility / Screen Recording
// are granted to *it*, not to whichever terminal hosts the MCP server) and
// answers {tool, args} requests over a per-user local socket. This module is
// the client side plus the shared naming; app/daemon.mjs is the server side.
//
// Wire format: one JSON object per line, request then reply, same shape as
// the ssh remote agent. Only ALLOWED tools (src/app-handler.mjs) execute.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { stateDir } from "./registry.mjs";
import { parseGrant, BACKEND_METHOD, TOOLS } from "./tools.mjs";
import { ExecError, currentSignal, throwIfAborted, wait } from "./exec.mjs";

export const PLUGIN_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
export const APP_ID = "net.codewhale.computer-use";
export const APP_NAME = "Codewhale Computer Use";
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "plugin.json"), "utf8")).version;
const HOST_AUTH_DOMAIN = "net.codewhale.computer-use.host.v1";
let appHostIdentity = null;
let appHostLabel = "This connection";

export function setAppHostIdentity({ ledgerKey, label } = {}) {
  if (ledgerKey !== undefined) {
    if (!Buffer.isBuffer(ledgerKey) || ledgerKey.length !== 32) throw new TypeError("Host ledger key must contain 32 bytes");
    if (sessionLeases.size) throw new Error("Host identity cannot change while computer sessions are open");
    const seed = Buffer.from(crypto.hkdfSync("sha256", ledgerKey, Buffer.alloc(0), HOST_AUTH_DOMAIN, 32));
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    seed.fill(0);
    appHostIdentity = { privateKey, publicKey: crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64"), persistent: true };
  }
  if (typeof label === "string" && label.trim()) appHostLabel = label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
}

function hostIdentity() {
  if (!appHostIdentity) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    appHostIdentity = { privateKey, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), persistent: false };
  }
  return appHostIdentity;
}

export function appHostPublicKey() {
  const identity = hostIdentity();
  if (!identity.persistent) throw new Error("Managed helper ownership requires the existing persistent host identity");
  return identity.publicKey;
}

export function hostPublicKey(value) {
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]{59}=$/.test(value)) return null;
    const der = Buffer.from(value, "base64");
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && key.export({ format: "der", type: "spki" }).equals(der) ? key : null;
  } catch { return null; }
}

export function managedBundleIdentity(bundle) {
  const helperBundle = fs.realpathSync(bundle);
  if (!/\.app$/i.test(helperBundle) || !fs.statSync(helperBundle).isDirectory()) throw new Error("Managed helper bundle is invalid");
  let container = path.dirname(helperBundle);
  while (container !== path.dirname(container) && !/\.app$/i.test(container)) container = path.dirname(container);
  if (!/\.app$/i.test(container) || !path.relative(container, helperBundle).startsWith(`Contents${path.sep}`)) throw new Error("Managed helper must be physically inside its desktop application");
  return { helperBundle, container };
}

export function validateManagedRegistration(reg) {
  const managed = reg?.managed;
  if (managed == null) return null;
  const absolute = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && path.resolve(value) === value;
  const update = managed.update;
  if (typeof managed !== "object" || Array.isArray(managed) || managed.protocol !== 1 || !hostPublicKey(managed.publicKey) || !absolute(managed.container) || !absolute(managed.helperBundle) || reg.path !== managed.helperBundle ||
      !/\.app$/i.test(managed.container) || !/\.app$/i.test(managed.helperBundle) || !path.relative(managed.container, managed.helperBundle).startsWith(`Contents${path.sep}`) ||
      (update != null && (typeof update !== "object" || Array.isArray(update) || typeof update.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(update.id) || !["draining", "drained", "retired"].includes(update.phase) ||
        typeof update.currentBuild !== "string" || !/^[0-9a-f]{16}$/.test(update.currentBuild) || typeof update.nextBuild !== "string" || !/^[0-9a-f]{16}$/.test(update.nextBuild) || typeof update.nextVersion !== "string" || update.nextVersion.length > 32 || !/^\d+\.\d+\.\d+$/.test(update.nextVersion)))) {
    throw Object.assign(new ExecError("Managed helper registration is invalid; the desktop updater must recover it"), { code: "managed_update_invalid" });
  }
  return managed;
}

/** Strict x.y.z comparison: true only when candidate is a newer release than current. */
export function newerVersion(candidate, current) {
  const parse = (value) => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

/**
 * Whether a running helper at `helper` is stale next to this plugin at
 * `bundled`. The helper owns the modules it loaded at start, so only an older
 * helper serves a previous build; a newer notarized helper beside an older
 * built-in plugin is expected and must not be told to restart.
 */
export function helperStaleness(helper, bundled = APP_VERSION) {
  if (!newerVersion(bundled, helper)) return { stale: false, note: null };
  return { stale: true, note: `The running helper reports ${helper} but this plugin is ${bundled} — restart the Codewhale Computer Use app to load the current build.` };
}

const FINGERPRINT_ENTRIES = ["plugin.json", "app", "src"];

export function runtimeFingerprint(root = PLUGIN_ROOT) {
  const hash = crypto.createHash("sha256");
  const add = (relative) => {
    const file = path.join(root, relative);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!name.startsWith(".") && name !== "node_modules") add(path.join(relative, name));
      }
    } else if (stat.isFile()) hash.update(relative.split(path.sep).join("/")).update("\0").update(fs.readFileSync(file)).update("\0");
  };
  for (const entry of FINGERPRINT_ENTRIES) add(entry);
  return hash.digest("hex").slice(0, 16);
}

let pluginBuild;
function fingerprintOrNull(root) {
  try { return runtimeFingerprint(root); } catch { return null; }
}

export function helperBuildDrift(app, { bundled = (pluginBuild ??= fingerprintOrNull(PLUGIN_ROOT)), bundledVersion = APP_VERSION } = {}) {
  if (typeof app?.build !== "string") return { stale: false, skew: false, note: null };
  const installed = typeof app.pluginRoot === "string" && path.isAbsolute(app.pluginRoot) ? fingerprintOrNull(app.pluginRoot) : null;
  if (installed && installed !== app.build) {
    return { stale: true, skew: false, installed, note: `The running helper is build ${app.build}, but its app on disk is now build ${installed}: it was replaced after the helper started. Restart the Codewhale Computer Use app to load the installed build.` };
  }
  if (bundled && bundled !== app.build && app.version === bundledVersion) {
    return { stale: false, skew: true, bundled, note: `This plugin (build ${bundled}) and the running helper (build ${app.build}) are different builds of ${bundledVersion}. The helper runs its own installed code; reinstall it from this plugin if the two must match.` };
  }
  return { stale: false, skew: false, note: null };
}

function shortHash(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** Per-user socket endpoint, keyed by the state dir so isolated state dirs get isolated apps. */
export function socketPath() {
  if (process.env.CODEWHALE_CU_APP_SOCKET) return process.env.CODEWHALE_CU_APP_SOCKET;
  const dir = stateDir();
  if (process.platform === "win32") return `\\\\.\\pipe\\codewhale-cu-${shortHash(dir)}`;
  const preferred = path.join(dir, "app.sock");
  // sun_path is 104 bytes on macOS / 108 on Linux; fall back to a short tmp name.
  return Buffer.byteLength(preferred) < 100 ? preferred : path.join(os.tmpdir(), `codewhale-cu-${shortHash(dir)}.sock`);
}

/** Where the app records how to launch itself (written by the app on first launch). */
export function registrationPath() { return path.join(stateDir(), "app.json"); }
/** Where the running daemon records its pid/socket (written on listen, removed on exit). */
export function runInfoPath() { return path.join(stateDir(), "app-run.json"); }

export function readRegistration({ strict = false } = {}) {
  try {
    if (fs.statSync(registrationPath()).size > 16384) throw new Error("Helper registration exceeds its size limit");
    const reg = JSON.parse(fs.readFileSync(registrationPath(), "utf8"));
    if (!launchArgv({ ...reg, managed: null })) throw new Error("Helper registration has no valid bundle path");
    validateManagedRegistration(reg);
    return reg;
  } catch (error) { if (strict && error.code !== "ENOENT") throw error; return null; }
}

/**
 * The argv that starts the registered app: always the bundle's own launcher,
 * derived from its path. app.json is a file any process of this user can
 * write, so a `launch` argv stored there is never run.
 */
export function launchArgv(reg, platform = process.platform) {
  const bundle = reg?.path;
  if (typeof bundle !== "string" || !path.isAbsolute(bundle) || bundle.includes("\0")) return null;
  if (platform === "darwin" && !/\.app\/?$/i.test(bundle)) return null;
  try { if (validateManagedRegistration(reg)?.update) return null; } catch { return null; }
  return defaultLaunch(bundle, platform);
}

export function writeRegistration(reg) {
  fs.mkdirSync(stateDir(), { recursive: true });
  validateManagedRegistration(reg);
  const temporary = `${registrationPath()}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ ...reg, registeredAt: new Date().toISOString() }, null, 2) + "\n");
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, registrationPath());
    if (process.platform !== "win32") {
      fd = fs.openSync(stateDir(), "r"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/**
 * Send one request to the app and await its single-line reply.
 *
 * Once the request line is written the helper may already have acted on it,
 * so every failure after that point (timeout, cancel, a dropped connection, a
 * malformed reply) carries `requestDispatched: true`. The MCP server turns
 * that into `outcome_unknown` instead of a plain cancel that invites a blind
 * retry of an input action that may have landed.
 */
function requestConnection(request, { timeoutMs = 30_000, signal = currentSignal(), keepOpen = false } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath());
    let buf = "";
    let settled = false;
    let written = false;
    const failure = (message, code) => Object.assign(new ExecError(message), { code }, written ? { requestDispatched: true } : {});
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); if (!keepOpen || fn === reject) sock.destroy(); fn(v); };
    const abort = () => done(reject, failure("computer request cancelled", "cancelled"));
    const timer = setTimeout(() => done(reject, failure(`${APP_NAME}: request timed out after ${timeoutMs}ms`, "app_timeout")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    sock.on("error", (err) => done(reject, failure(`${APP_NAME} is not reachable at ${socketPath()}: ${err.code ?? err.message}`, "app_unavailable")));
    sock.on("connect", () => { written = true; sock.write(JSON.stringify(request) + "\n"); });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try { const reply = JSON.parse(buf.slice(0, nl)); done(resolve, keepOpen ? { reply, socket: sock } : reply); }
      catch { done(reject, failure(`${APP_NAME}: malformed reply`, "app_bad_reply")); }
    });
    sock.on("close", () => done(reject, failure(`${APP_NAME}: connection closed before a reply`, "app_unavailable")));
  });
}

export function appRequest(request, options) { return requestConnection(request, options); }

// A live socket is the session owner, independent of short-lived cancellable
// request sockets. The OS closes it even if the MCP process is killed; no PID
// lookup or reuse-prone process identity is needed to release held input.
// When the socket dies without close_session (an app update replaces the
// daemon and every socket it owned), the dead lease is dropped so the next
// request re-opens one instead of failing forever.
const sessionLeases = new Map();
export function openAppSession(sessionId) {
  if (!sessionLeases.has(sessionId)) {
    // Carry the capability grant to the daemon so a narrowed server cannot
    // smuggle ungranted tools past the boundary that actually sends input.
    // The daemon sees transport method names (probe, recordingStart, …), so
    // the grant is normalized through BACKEND_METHOD before it travels.
    const grant = parseGrant(process.env.CODEWHALE_CU_GRANT);
    const transportGrant = grant ? new Set([...grant].map((name) => BACKEND_METHOD[name] ?? name)) : null;
    if (transportGrant) {
      if (TOOLS.some(tool => grant.has(tool.name) && ["target", "from_target", "to"].some(field => tool.inputSchema.properties[field]))) transportGrant.add("resolve_element");
      if (["type", "key", "hold_key"].some(tool => grant.has(tool))) transportGrant.add("focused_control");
      if (["type", "key", "hold_key", "left_click", "double_click", "triple_click", "right_click", "middle_click", "left_click_drag", "mouse_move", "left_mouse_down", "scroll"].some(tool => grant.has(tool))) transportGrant.add("input_owner");
    }
    const identity = hostIdentity();
    const host = { publicKey: identity.publicKey, label: appHostLabel, persistent: identity.persistent };
    const pending = requestConnection({ tool: "open_session", sessionId, host, owner: { pid: process.pid, host_pid: process.ppid }, ...(transportGrant ? { grant: [...transportGrant] } : {}) }, { timeoutMs: 3_000, signal: null, keepOpen: true }).then(async ({ reply, socket }) => {
      if (!reply?.ok || typeof reply.leaseToken !== "string") {
        socket.destroy();
        throw Object.assign(new ExecError(reply?.error?.message ?? "Computer session lease was refused"), { code: reply?.error?.code ?? "app_session_closed" });
      }
      const lease = { token: reply.leaseToken, socket, closed: socket.destroyed, deliberate: false };
      socket.once("close", () => {
        lease.closed = true;
        if (sessionLeases.get(sessionId) === pending && !lease.deliberate) sessionLeases.delete(sessionId);
      });
      // Library clients need not keep Node alive solely for an idle lease.
      socket.unref();
      try {
        if (Number(reply.hostTrustProtocol) >= 1) {
          if (typeof reply.challenge !== "string" || !/^[0-9a-f]{64}$/.test(reply.challenge)
              || typeof sessionId !== "string" || sessionId.includes("\0") || reply.leaseToken.includes("\0")) {
            throw Object.assign(new ExecError("Computer helper returned an invalid host challenge"), { code: "app_bad_reply" });
          }
          const message = Buffer.from([HOST_AUTH_DOMAIN, sessionId, reply.leaseToken, reply.challenge, identity.publicKey].join("\0"));
          const proof = crypto.sign(null, message, identity.privateKey).toString("base64");
          const authenticated = await appRequest({ tool: "authenticate_session", sessionId, leaseToken: lease.token, publicKey: identity.publicKey, proof }, { timeoutMs: 3_000, signal: null });
          if (!authenticated?.ok) throw Object.assign(new ExecError(authenticated?.error?.message ?? "Computer host authentication was refused"), { code: authenticated?.error?.code ?? "host_authentication_required" });
        }
        if (socket.destroyed) throw Object.assign(new ExecError("Computer session closed during authentication"), { code: "app_session_closed" });
      } catch (error) {
        socket.destroy();
        throw error;
      }
      return lease;
    }).catch((error) => {
      // Opening a lease sends no input, so its failure is never
      // outcome-unknown for the action that was waiting on it.
      if (error && typeof error === "object") delete error.requestDispatched;
      throw error;
    });
    // A refused or unreachable open is retried on the next request, not cached.
    pending.catch(() => { if (sessionLeases.get(sessionId) === pending) sessionLeases.delete(sessionId); });
    sessionLeases.set(sessionId, pending);
  }
  return sessionLeases.get(sessionId);
}

export async function appSessionRequest(request, options = {}) {
  throwIfAborted(options.signal === undefined ? currentSignal() : options.signal);
  let lease = await openAppSession(request.sessionId);
  if (lease.closed) {
    if (lease.deliberate) throw Object.assign(new ExecError("Computer session was closed; start a new session to continue"), { code: "app_session_closed" });
    // The fresh lease is on a daemon that holds no input for this session,
    // so nothing the old lease held can replay across the reconnect.
    lease = await openAppSession(request.sessionId);
    if (lease.closed) throw Object.assign(new ExecError("Computer session lease could not be re-established with the helper; retry the request"), { code: "app_session_closed" });
  }
  try { return await appRequest({ ...request, leaseToken: lease.token }, options); }
  finally { if (request.tool === "close_session") { lease.deliberate = true; lease.socket.destroy(); } }
}

/** App identity if it is running, else null. Cheap: one connect. */
export async function hello({ timeoutMs = 2_000 } = {}) {
  try {
    const r = await appRequest({ tool: "hello" }, { timeoutMs });
    return r?.ok && r.app ? r.app : null;
  } catch { return null; }
}

/** How each OS re-launches an installed bundle so it is its own responsible process. */
export function defaultLaunch(bundlePath, platform = process.platform) {
  if (platform === "darwin") return ["open", "-g", "-a", bundlePath];
  if (platform === "win32") return ["powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", path.join(bundlePath, "launch.ps1")];
  return [path.join(bundlePath, "bin", "codewhale-computer-use")];
}

/** Start the registered app detached (LaunchServices on macOS so TCC attributes it to the app). */
export function launchApp(reg) {
  const argv = launchArgv(reg);
  if (!argv) return null;
  const [cmd, ...args] = argv;
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
  return child.pid ?? null;
}

async function launchManagedBundle(bundlePath, publicKey) {
  const env = [...(publicKey ? [`CODEWHALE_CU_DESKTOP_OWNER_KEY=${publicKey}`] : []), ...["CODEWHALE_CU_STATE_DIR", "CODEWHALE_CU_APP_SOCKET"].filter(name => process.env[name]).map(name => `${name}=${process.env[name]}`)];
  const child = spawn("/usr/bin/open", ["-n", "-g", ...env.flatMap(value => ["--env", value]), "-a", bundlePath], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new ExecError("LaunchServices could not launch the managed helper"))); });
}

export async function bootstrapManagedApp({ bundlePath, expectedBuild, expectedVersion } = {}) {
  throwIfAborted();
  if (process.platform !== "darwin" || typeof expectedBuild !== "string" || !/^[0-9a-f]{16}$/.test(expectedBuild) || typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw Object.assign(new ExecError("Managed helper bootstrap requires an exact macOS helper build and version"), { code: "bad_args" });
  }
  const publicKey = appHostPublicKey();
  const identity = managedBundleIdentity(bundlePath);
  const root = path.join(identity.helperBundle, "Contents", "Resources", "plugin");
  const reg = readRegistration({ strict: true });
  if (reg?.managed && (reg.managed.publicKey !== publicKey || reg.managed.container !== identity.container || reg.managed.helperBundle !== identity.helperBundle || reg.managed.update)) {
    throw Object.assign(new ExecError("An existing managed helper owner or transaction must be recovered before bootstrap"), { code: "managed_update_owner_required" });
  }
  if (runtimeFingerprint(root) !== expectedBuild || JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")).version !== expectedVersion) {
    throw Object.assign(new ExecError("The nested helper does not match the desktop package metadata"), { code: "managed_update_identity_mismatch" });
  }
  let app = await hello();
  const matches = value => value?.managedUpdateProtocol === 1 && value.managed?.publicKey === publicKey && value.managed?.container === identity.container && value.managed?.phase === "idle" && value.bundle === identity.helperBundle && value.build === expectedBuild && value.version === expectedVersion;
  if (app) {
    if (matches(app)) return app;
    throw Object.assign(new ExecError("An unowned or different helper is running; close it through its native controls before first managed setup"), { code: "managed_update_owner_required" });
  }
  await launchManagedBundle(identity.helperBundle, publicKey);
  const deadline = Date.now() + 8_000;
  do {
    app = await hello({ timeoutMs: 1_000 });
    if (app) {
      if (!matches(app)) throw Object.assign(new ExecError("The launched helper did not prove the expected desktop ownership and build"), { code: "managed_update_identity_mismatch" });
      return app;
    }
    await wait(100);
  } while (Date.now() < deadline);
  throw Object.assign(new ExecError("The managed helper did not register; its native controls and ownership must be available before use"), { code: "app_unavailable" });
}

export async function launchManagedApp({ updateId, action = "complete" } = {}) {
  throwIfAborted();
  const reg = readRegistration({ strict: true });
  const managed = validateManagedRegistration(reg);
  if (!managed?.update || managed.update.id !== updateId || managed.publicKey !== appHostPublicKey() || !["complete", "abort"].includes(action)) {
    throw Object.assign(new ExecError("Managed helper recovery requires its authenticated desktop and pending transaction"), { code: "managed_update_owner_required" });
  }
  const identity = managedBundleIdentity(reg.path);
  const root = path.join(identity.helperBundle, "Contents", "Resources", "plugin");
  const expected = action === "complete" ? managed.update.nextBuild : managed.update.currentBuild;
  if (identity.container !== managed.container || identity.helperBundle !== managed.helperBundle || runtimeFingerprint(root) !== expected ||
      (action === "complete" && JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")).version !== managed.update.nextVersion)) {
    throw Object.assign(new ExecError("Installed helper does not match the managed update; recover the containing application before launching"), { code: "managed_update_identity_mismatch" });
  }
  let app = await hello();
  if (!app) await launchManagedBundle(reg.path);
  const deadline = Date.now() + 8_000;
  do {
    app ??= await hello({ timeoutMs: 1_000 });
    if (app) {
      if (app.build !== expected || app.bundle !== reg.path || app.managedUpdateProtocol !== 1 || app.managed?.updateId !== updateId) {
        throw Object.assign(new ExecError("A different helper is running; the desktop updater must recover it without terminating unknown owners"), { code: "managed_update_identity_mismatch" });
      }
      return app;
    }
    await wait(100);
  } while (Date.now() < deadline);
  throw Object.assign(new ExecError("The exact managed helper did not start; its pending transaction remains fenced"), { code: "app_unavailable" });
}

let lastLaunchAt = 0;

/**
 * Decide how the local computer is driven this call: through the app when it
 * is running (or registered and launchable). macOS requires helper setup;
 * other platforms can run directly. Set CODEWHALE_CU_APP=off to force direct.
 */
export async function ensureApp({ launch = true } = {}) {
  if (process.env.CODEWHALE_CU_APP === "off") return { via: "direct", reason: "CODEWHALE_CU_APP=off" };
  let app = await hello();
  throwIfAborted();
  if (app?.managed?.phase && app.managed.phase !== "idle") throw Object.assign(new ExecError("Computer Use is waiting for its desktop updater to complete or recover an update"), { code: "managed_update_pending" });
  if (app) return { via: "app", app };
  const reg = readRegistration();
  if (reg?.managed?.update) throw Object.assign(new ExecError("The containing desktop must complete or recover its pending Computer Use update"), { code: "managed_update_pending" });
  if (!reg) {
    if (process.platform === "darwin") throw Object.assign(new ExecError(`Install ${APP_NAME} from https://codewhale.net/computer-use and open it once to finish macOS permission setup. Then retry; its native approval and Pause/Stop controls must be available before computer access.`), { code: "app_setup_required" });
    return { via: "direct", reason: `${APP_NAME} is not installed. Input and screen permissions belong to the current host.` };
  }
  if (typeof reg.path === "string" && !fs.existsSync(reg.path)) {
    throw Object.assign(new ExecError(`${APP_NAME} is registered at ${reg.path}, but that app is missing. Reinstall it and open it once to refresh ${registrationPath()}.`), { code: "app_missing" });
  }
  if (!launch || Date.now() - lastLaunchAt < 15_000) {
    throw Object.assign(new ExecError(`${APP_NAME} is installed but not responding. Open it from Applications and retry; its controls must remain in charge of input.`), { code: "app_unavailable" });
  }
  lastLaunchAt = Date.now();
  launchApp(reg);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await wait(250);
    app = await hello({ timeoutMs: 1_000 });
    throwIfAborted();
    if (app) return { via: "app", app, launched: true };
  }
  throw Object.assign(new ExecError(`${APP_NAME} did not answer within 8s. Open it from Applications and check its status before retrying.`), { code: "app_unavailable" });
}
