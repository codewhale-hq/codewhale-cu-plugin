// Interim, opt-in: the user's own decision through a native macOS dialog, for
// hosts that can neither attest a decision nor elicit one. osascript shows the
// dialog; the request text, title and button labels reach it only as argv, so
// nothing a model wrote ever becomes script source. While it is open, a
// 0600 marker in the plugin's state directory makes every plugin session
// refuse input, observation and other decisions. Any other program running as
// the user can still press Allow; the launch design is a helper-owned panel.

export const OSASCRIPT = "/usr/bin/osascript";
export const DIALOG_TITLE = "Codewhale Computer Use";
export const MARKER_FILE = "native-prompt.lock";
const DENY = "Deny";
const ALLOW = "Allow";
export const DECLINED_MESSAGE = "the user did not approve this — do not retry it; continue without it or ask them";
export const DIALOG_SCRIPT = Object.freeze([
  "on run argv",
  "set answer to display dialog (item 1 of argv) with title (item 2 of argv) buttons {item 3 of argv, item 4 of argv} default button 1 cancel button 1 with icon caution giving up after ((item 5 of argv) as integer)",
  "if gave up of answer then return \"timeout\"",
  "return button returned of answer",
  "end run",
]);
const OPEN_WHILE_PENDING = new Set(["stop_computer_control", "consent_status", "list_apps"]);

const PENDING_MESSAGE = "A Computer Use approval dialog is open and waits for the person. Until they answer it, Computer Use input, app targeting, observation and other decisions are refused; consent status and plain list_apps wait in the queue until it closes, and stop_computer_control closes it. Do not try to answer it.";
const FOREIGN_MESSAGE = "Another Computer Use session has an approval dialog open on this Mac. Until the person answers it, Computer Use input, app targeting, observation and decisions are refused here too. Do not try to answer it.";
const QUEUED_MESSAGE = "An approval dialog opened while this decision waited behind it, so it was not shown. Ask the person in the conversation before you repeat it.";
const SCRIPT_WINDOW = 1000;
const MESSAGE_MAX = 2400;
const MAX_TARGETS = 12;

const failure = (code, message, extra) => Object.assign(new Error(message), { code, ...(extra ? { extra } : {}) });

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/**
 * A quoted, printable-ASCII spelling of untrusted text: every other character
 * (control, non-ASCII, invisible, combining, bidi, private-use, blank) is
 * shown as \uXXXX. Longer than `max` throws, or with cut:true ends in an
 * ellipsis.
 */
export function visible(value, max, { cut = false, what = "a value" } = {}) {
  let out = "";
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0);
    const piece = ch === "\\" ? "\\\\" : ch === "\"" ? "\\\"" : code >= 0x20 && code < 0x7f ? ch
      : code === 0x0a ? "\\n" : code === 0x09 ? "\\t" : code === 0x0d ? "\\r"
      : code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    if (out.length + piece.length > max) {
      if (cut) return `"${out}…"`;
      if (what === "the script") throw failure("script_too_long", `app_script is too long for the approval dialog to show in full (at most ${max} characters, with every non-ASCII or invisible character spelled out as \\uXXXX). Split it into shorter scripts and ask again.`);
      throw failure("bad_args", `${what} is too long for the approval dialog to show in full; use a shorter one`);
    }
    out += piece;
  }
  return `"${out}"`;
}

function identityLines(identity) {
  const lines = [];
  if (identity?.name != null) lines.push(`App name: ${visible(identity.name, 120, { what: "the app name" })}`);
  if (identity?.bundle_id != null) lines.push(`Bundle id: ${visible(identity.bundle_id, 200, { what: "the bundle id" })}`);
  if (identity?.pid != null) lines.push(`Process id: ${Number(identity.pid)} (recorded for this session only)`);
  return lines;
}

function rememberLine(args, persists) {
  if (args?.remember !== true) return "Remember: no, this session only";
  return persists ? "Remember: yes, until revoked" : "Remember: requested, but this host keeps approvals for this session only";
}

function targetText(ref) {
  if (ref?.bundle_id === "com.apple.osascript" && ref.name == null) return "none; it runs as osascript itself (\"com.apple.osascript\")";
  return visible(ref?.name ?? ref?.bundle_id, 120, { what: "an app the script names" });
}

/**
 * The dialog text for one decision: what it does, then the exact request.
 * request = {tool, args, computer, identity?, running?, denied?,
 * confirmation?, targets?, persists?, client?}
 */
export function describeDecision({ tool, args = {}, computer, identity, running, denied = false, confirmation, targets, persists = false, client } = {}) {
  const foreground = args.scope === "foreground";
  let headline;
  let lines = [];
  if (tool === "consent_allow" && confirmation) {
    headline = "Confirm one action that cannot be undone.";
    const where = confirmation.app?.name ?? confirmation.app?.bundle_id;
    lines = [`Action: ${visible(confirmation.tool, 40, { what: "the action" })} on ${visible(confirmation.label, 200, { what: "the control label" })}`,
      ...(where != null ? [`In app: ${visible(where, 120, { what: "the app" })}`] : []),
      ...(confirmation.repeated ? [`Presses: ${Number(confirmation.repeated)} Return, Enter or space presses; the focus can move between them`] : []),
      `On computer: ${visible(confirmation.computer ?? computer ?? "local", 80, { what: "the computer id" })}`];
  } else if (tool === "consent_allow" && foreground) {
    headline = "Allow Computer Use to share your pointer and keyboard (foreground control).";
    lines = [...(denied ? ["Replaces your earlier deny: yes"] : []), rememberLine(args, persists)];
  } else if (tool === "consent_allow") {
    headline = "Allow Computer Use to see and operate this app.";
    lines = [...identityLines(identity), `Running now: ${running ? "yes" : "no; recorded exactly as named"}`, ...(denied ? ["Replaces your earlier deny: yes"] : []), rememberLine(args, persists)];
  } else if (tool === "consent_revoke" && foreground) {
    headline = denied ? "Lift your deny on foreground control. Computer Use may then ask for it again." : "Remove the recorded foreground-control decision.";
  } else if (tool === "consent_revoke") {
    headline = denied ? "Lift your deny for this app. Computer Use may then ask to control it again." : "Remove the recorded decision for this app.";
    lines = [...identityLines(identity), `Running now: ${running ? "yes" : "no"}`];
  } else if (tool === "app_script") {
    headline = "Run this app script.";
    const named = Array.isArray(targets) ? targets : [];
    if (named.length > MAX_TARGETS) throw failure("bad_args", `this script names ${named.length} apps, more than the approval dialog shows (${MAX_TARGETS}); split it and ask again`);
    lines = [`Language: ${visible(args.language ?? "applescript", 20, { what: "the language" })}`,
      `Apps it names: ${named.length ? named.map(targetText).join(", ") : "none"}`,
      `Script: ${visible(args.script, SCRIPT_WINDOW, { what: "the script" })}`];
  } else if (tool === "computer_register") {
    headline = "Register a computer that Computer Use may operate.";
    lines = [`Transport: ${visible(args.transport, 20, { what: "the transport" })}`,
      ...(args.host != null ? [`Host: ${visible(args.host, 255, { what: "the host" })}`] : []),
      ...(args.user != null ? [`User: ${visible(args.user, 64, { what: "the user" })}`] : []),
      ...(args.port != null ? [`Port: ${visible(args.port, 8, { what: "the port" })}`] : []),
      ...(args.knownHosts != null ? [`Known hosts file: ${visible(args.knownHosts, 400, { what: "the known hosts file" })}`] : []),
      ...(args.target != null ? [`Target: ${visible(args.target, 120, { what: "the target" })}`] : []),
      ...(args.label != null ? [`Label: ${visible(args.label, 120, { what: "the label" })}`] : []),
      ...(args.transport === "ssh" ? [`Install remote agent: ${args.installAgent === false ? "no" : "yes"}`] : [])];
  } else if (tool === "computer_spawn") {
    headline = "Create a disposable computer for this task.";
    lines = [`Transport: ${visible(args.transport, 20, { what: "the transport" })}`,
      ...(args.image != null ? [`Image: ${visible(args.image, 200, { what: "the image" })}`] : []),
      ...(args.label != null ? [`Label: ${visible(args.label, 120, { what: "the label" })}`] : [])];
  } else {
    throw failure("bad_args", `${tool} has no approval dialog`);
  }
  const computerLabel = tool === "computer_register" || tool === "computer_spawn" ? "Computer id" : "Computer";
  const via = client?.name != null
    ? `Requested through: ${visible(client.name, 60, { cut: true })}${client.version != null ? ` ${visible(client.version, 30, { cut: true })}` : ""} (as the MCP client names itself)`
    : "Requested through: an MCP client that did not name itself";
  const text = [
    headline,
    "",
    `Tool: ${tool}`,
    ...lines,
    `${computerLabel}: ${visible(computer ?? "local", 80, { what: "the computer id" })}`,
    via,
    "",
    "Allow only if you asked for this. Deny, Return, Escape or no answer refuses it.",
  ].join("\n");
  if (text.length > MESSAGE_MAX) throw failure("bad_args", "this request is too long for the approval dialog to show in full; use shorter values");
  return text;
}

/**
 * The marker another session left, judged without trusting it: a dead or
 * unnamed owner, an open dialog older than its timeout, or a closed one past
 * its gap is stale. Returns {state: "open"|"closing", pid, pids, retry_ms} or null.
 */
export function judgeMarker(raw, { mtimeMs = 0, isAlive = pidAlive, wallNow = Date.now, maxOpenMs = 160_000, gapMs = 2_000 } = {}) {
  if (raw == null) return null;
  const t = wallNow();
  let marker;
  try { marker = JSON.parse(raw); } catch { marker = null; }
  if (!marker || typeof marker !== "object") return t - mtimeMs < 2_000 ? { state: "open", pid: null, pids: [], retry_ms: 2_000 } : null;
  if (!Number.isInteger(marker.pid) || !isAlive(marker.pid)) return null;
  const pids = [marker.pid, marker.child_pid].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (Number.isFinite(marker.closed_at)) {
    const left = marker.closed_at + gapMs - t;
    return left > 0 && left <= gapMs + 5_000 ? { state: "closing", pid: marker.pid, pids, retry_ms: left } : null;
  }
  if (!Number.isFinite(marker.opened_at) || marker.opened_at > t + 5_000 || t - marker.opened_at > maxOpenMs) return null;
  return { state: "open", pid: marker.pid, pids, retry_ms: maxOpenMs - (t - marker.opened_at) };
}

/** The live marker in `dir`, or null. fs is node:fs or a stand-in. */
export function liveMarker({ fs, dir, ...options } = {}) {
  if (!fs || typeof dir !== "string") return null;
  const file = `${dir}/${MARKER_FILE}`;
  let raw;
  let mtimeMs = 0;
  try { raw = fs.readFileSync(file, "utf8"); mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  return judgeMarker(raw, { mtimeMs, ...options });
}

/** Whether a process reference names osascript or a process behind a live dialog. */
export function isPromptProcess(ref, pids = []) {
  if (!ref || typeof ref !== "object") return false;
  const name = String(ref.name ?? "").trim().replace(/\.app$/i, "").toLowerCase();
  const bundle = String(ref.bundle_id ?? "").trim().toLowerCase();
  return name === "osascript" || bundle === "com.apple.osascript" || (Number.isInteger(ref.pid) && pids.includes(ref.pid));
}

/**
 * Factory with every effect injected: `execFile` (node:child_process shape),
 * `platform`, `fs` and `dir` for the marker, this process's `pid`, `isAlive`,
 * and the clocks (`now` monotonic, `wallNow` for the marker). `enabled` only
 * allows showing the dialog; nothing else can answer or replace it.
 */
export function createNativePrompt({
  execFile, platform, enabled = false, fs, dir, pid, isAlive = pidAlive,
  now = () => performance.now(), wallNow = Date.now, schedule = (fn, ms) => setTimeout(fn, ms).unref?.(),
  timeoutSeconds = 120, cooldownMs = 10_000, gapMs = 2_000, perMinute = 5,
} = {}) {
  const markerPath = fs && typeof dir === "string" ? `${dir}/${MARKER_FILE}` : null;
  const available = enabled === true && platform === "darwin" && typeof execFile === "function" && markerPath != null && Number.isInteger(pid);
  const judging = { isAlive, wallNow, maxOpenMs: (timeoutSeconds + 40) * 1000, gapMs };
  let open = false;
  let opened = 0;
  let closedAt = -Infinity;
  let quietUntil = -Infinity;
  const started = [];
  let held = null;

  const readRaw = () => {
    try { return { raw: fs.readFileSync(markerPath, "utf8"), mtimeMs: fs.statSync(markerPath).mtimeMs }; } catch { return null; }
  };
  const foreign = () => {
    if (!markerPath) return null;
    const read = readRaw();
    const live = read && judgeMarker(read.raw, { mtimeMs: read.mtimeMs, ...judging });
    return live && live.pid !== pid ? live : null;
  };
  const write = (body) => {
    if (!held) return;
    fs.ftruncateSync(held.fd, 0);
    fs.writeSync(held.fd, JSON.stringify(body), 0);
    held.body = body;
  };
  function release() {
    if (!held) return;
    const { fd, token } = held;
    held = null;
    try { fs.closeSync(fd); } catch {}
    try { if (JSON.parse(fs.readFileSync(markerPath, "utf8")).token === token) fs.unlinkSync(markerPath); } catch {}
  }
  function acquire() {
    release();
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    const token = `${pid}-${wallNow()}-${Math.random().toString(16).slice(2)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd;
      try { fd = fs.openSync(markerPath, "wx", 0o600); } catch (error) {
        if (error?.code !== "EEXIST") throw failure("consent_needs_user", "the approval dialog could not create its lock file in the plugin's state directory, so it was not shown");
        const read = readRaw();
        if (!read) continue;
        const live = judgeMarker(read.raw, { mtimeMs: read.mtimeMs, ...judging });
        if (live && live.pid !== pid) {
          if (live.state === "open") throw failure("consent_pending", FOREIGN_MESSAGE);
          throw failure("consent_rate_limited", "An approval dialog just closed in another session. Do not ask again right away.", { retry_after_s: Math.ceil(live.retry_ms / 1000) });
        }
        const aside = `${markerPath}.${token}.stale`;
        try { fs.renameSync(markerPath, aside); } catch { continue; }
        let moved = null;
        try { moved = fs.readFileSync(aside, "utf8"); } catch {}
        if (moved !== read.raw) {
          try { fs.linkSync(aside, markerPath); } catch {}
          try { fs.unlinkSync(aside); } catch {}
          throw failure("consent_pending", FOREIGN_MESSAGE);
        }
        try { fs.unlinkSync(aside); } catch {}
        continue;
      }
      held = { fd, token, body: null };
      try { write({ pid, child_pid: null, token, opened_at: wallNow(), closed_at: null }); } catch {
        release();
        throw failure("consent_needs_user", "the approval dialog could not write its lock file, so it was not shown");
      }
      return;
    }
    throw failure("consent_pending", FOREIGN_MESSAGE);
  }

  const show = (message, signal) => new Promise((resolve) => {
    const argv = [...DIALOG_SCRIPT.flatMap((line) => ["-e", line]), message, DIALOG_TITLE, DENY, ALLOW, String(timeoutSeconds)];
    try {
      const child = execFile(OSASCRIPT, argv, { encoding: "utf8", timeout: (timeoutSeconds + 10) * 1000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) },
        (error, stdout) => resolve({ error, stdout }));
      if (Number.isInteger(child?.pid) && held?.body) { try { write({ ...held.body, child_pid: child.pid }); } catch {} }
    } catch (error) {
      resolve({ error, stdout: "" });
    }
  });

  return {
    available,
    get pending() { return open; },
    /** How many dialogs this process has opened; a decision compares it with the count when it arrived. */
    get ticket() { return opened; },
    /** The consent_pending refusal for a wire tool call while any plugin dialog is open, or null. */
    refusal(tool, args) {
      const mine = open;
      if (!mine && foreign()?.state !== "open") return null;
      if (OPEN_WHILE_PENDING.has(tool) && !(tool === "list_apps" && (args?.all === true || args?.installed === true))) return null;
      return failure("consent_pending", mine ? PENDING_MESSAGE : FOREIGN_MESSAGE);
    },
    /** Remove this process's marker (process exit). */
    release,
    /** Resolve when the person clicks Allow; throw consent_declined (or a refusal) otherwise. */
    async ask(request, { signal, ticket } = {}) {
      if (!available) throw failure("consent_needs_user", "the native approval dialog is not enabled on this host");
      if (open) throw failure("consent_pending", PENDING_MESSAGE);
      if (ticket !== undefined && ticket !== opened) throw failure("consent_pending", QUEUED_MESSAGE);
      const theirs = foreign();
      if (theirs?.state === "open") throw failure("consent_pending", FOREIGN_MESSAGE);
      const t = now();
      if (t < closedAt + gapMs) throw failure("consent_rate_limited", "An approval dialog just closed. Do not ask again right away.", { retry_after_s: Math.ceil((closedAt + gapMs - t) / 1000) });
      if (theirs?.state === "closing") throw failure("consent_rate_limited", "An approval dialog just closed in another session. Do not ask again right away.", { retry_after_s: Math.ceil(theirs.retry_ms / 1000) });
      if (t < quietUntil) {
        throw failure("consent_rate_limited", "The person just declined or did not answer an approval dialog. Do not ask again right away: continue without it, or ask them in the conversation.", { retry_after_s: Math.ceil((quietUntil - t) / 1000) });
      }
      while (started.length && started[0] <= t - 60_000) started.shift();
      if (started.length >= perMinute) {
        throw failure("consent_rate_limited", `${perMinute} approval dialogs were shown in the last minute. Do not ask again right away: continue without it, or ask the person in the conversation.`, { retry_after_s: Math.ceil((started[0] + 60_000 - t) / 1000) });
      }
      if (signal?.aborted) throw failure("cancelled", "the request ended before the user decided");
      const message = describeDecision(request);
      acquire();
      open = true;
      opened += 1;
      started.push(t);
      let allowed = false;
      try {
        const { error, stdout } = await show(message, signal);
        allowed = !error && (stdout === ALLOW || stdout === `${ALLOW}\n`);
      } finally {
        open = false;
        closedAt = now();
        if (!allowed) quietUntil = closedAt + cooldownMs;
        const closing = held;
        try { write({ ...held.body, closed_at: wallNow() }); } catch { release(); }
        schedule(() => { if (held && held === closing) release(); }, gapMs);
      }
      if (allowed && !signal?.aborted) return;
      if (signal?.aborted) throw failure("cancelled", "the request ended before the user decided");
      throw failure("consent_declined", DECLINED_MESSAGE);
    },
  };
}
