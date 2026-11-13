// app_script policy: what a script may do before it reaches osascript.
//
// app_script is the programmatic interface into apps with a scripting
// dictionary, not a shell. By default this module refuses the ways a script
// escapes into one (`do shell script`, JXA `doShellScript`, the Objective-C
// bridge and NSTask, script loading/eval, raw Apple event codes) and extracts
// every application the script names, so the per-app consent ledger gates
// `tell application "X"` — System Events and the processes it drives included —
// exactly as it gates clicks. A target the text cannot name statically (a
// computed application, a computed JXA member) is refused rather than guessed.
//
// This is a lexical gate, not a sandbox: it is defense in depth under the
// host's exact-script approval, which is the real floor. It fails closed —
// anything it cannot read confidently is refused with a reason the model can
// act on.
//
// Operators choose the mode with CODEWHALE_CU_APP_SCRIPT:
//   (unset) | "apps"  — the default described above
//   "off"             — refuse every app_script call
//   "unrestricted"    — skip the lexical refusals (the ledger still gates the
//                       apps a script names). A human decision in the host's
//                       MCP config; nothing a model can set from a tool call.

const MODES = new Set(["apps", "off", "unrestricted"]);

export function appScriptMode(env = process.env) {
  const raw = String(env.CODEWHALE_CU_APP_SCRIPT ?? "").trim().toLowerCase();
  if (!raw) return "apps";
  // An unknown value is a misconfiguration; fail closed rather than open.
  return MODES.has(raw) ? raw : "off";
}

const refuse = (reason) => ({ refused: reason, targets: [] });

const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends", "default", "break", "continue", "debugger"]);
const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with", "await"]);
const UNREADABLE_JS = "the script ends inside a string, template or comment, or a quoted string crosses a line — the policy cannot read it";
const JS_LINE_END = new Set(["\n", "\r", "\u2028", "\u2029"]);
const trailingWord = (text) => /[\w$]+$/.exec(text.trimEnd())?.[0] ?? "";

/** Remove JXA string literals and comments so structure checks only see code that runs. */
function maskJxa(src) {
  let out = "";
  const literals = new Map();
  const parens = [];
  let afterControlParen = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const start = i + 1;
      let closed = false;
      for (i++; i < src.length; i++) {
        const d = src[i];
        if (d === c) { closed = true; break; }
        if (d === "\\") { if (src[i + 1] === "\r" && src[i + 2] === "\n") i++; i++; }
        else if (c === "`") { if (d === "$" && src[i + 1] === "{") return { refused: "template literal interpolation (${…}) runs code the policy cannot read — build the string with + instead" }; }
        else if (d === "\n" || d === "\r") return { refused: UNREADABLE_JS };
      }
      if (!closed) return { refused: UNREADABLE_JS };
      if (c !== "`") literals.set(out.length, src.slice(start, i));
      out += c + c;
      afterControlParen = false;
      continue;
    }
    if ((i === 0 || (i === 1 && src[0] === "\uFEFF")) && c === "#" && src[i + 1] === "!") {
      while (i + 1 < src.length && !JS_LINE_END.has(src[i + 1])) i++;
      out += " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i + 1 < src.length && !JS_LINE_END.has(src[i + 1])) i++;
      out += " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return { refused: UNREADABLE_JS };
      i = end + 1;
      out += " ";
      continue;
    }
    if (src.startsWith("<!--", i) || src.startsWith("-->", i)) return { refused: "HTML-style comments are refused" };
    if (c === "/") {
      const last = out.trimEnd().slice(-1);
      const word = trailingWord(out);
      const division = (word !== "" && !REGEX_KEYWORDS.has(word)) || (last !== "" && "]\"'`".includes(last)) || (last === ")" && !afterControlParen);
      if (!division) return { refused: "regular expression literals are refused — use new RegExp(\"…\") instead" };
    }
    if (c === "(") parens.push(trailingWord(out));
    if (c === ")") afterControlParen = CONTROL_KEYWORDS.has(parens.pop() ?? "");
    else if (!/\s/.test(c)) afterControlParen = false;
    out += c;
  }
  return { code: out, literals };
}

const UNREADABLE_AS = "the script ends inside a string, piped name or comment — the policy cannot read it";
const COMMENT_AS = "block comments that contain quotes, pipes or -- are refused — AppleScript reads those inside a comment, so the policy cannot tell where it ends";

function maskAppleScript(src) {
  let out = "";
  const literals = new Map();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "|") {
      const start = i + 1;
      let closed = false;
      for (i++; i < src.length; i++) {
        if (src[i] === c) { closed = true; break; }
        if (src[i] === "\\") i++;
      }
      if (!closed) return { refused: UNREADABLE_AS };
      if (c === '"') literals.set(out.length, src.slice(start, i));
      out += c + c;
    } else if ((c === "-" && src[i + 1] === "-") || c === "#") {
      while (i + 1 < src.length && src[i + 1] !== "\n" && src[i + 1] !== "\r") i++;
      out += " ";
    } else if (c === "(" && src[i + 1] === "*") {
      let depth = 1;
      for (i += 2; i < src.length && depth > 0; i++) {
        if (src[i] === "(" && src[i + 1] === "*") { depth++; i++; }
        else if (src[i] === "*" && src[i + 1] === ")") { depth--; i++; }
        else if (src[i] === '"' || src[i] === "|" || (src[i] === "-" && src[i + 1] === "-")) return { refused: COMMENT_AS };
      }
      if (depth > 0) return { refused: UNREADABLE_AS };
      i--;
      out += " ";
    } else if (c === "¬" && /^[ \t]*\r?\n/.test(src.slice(i + 1))) {
      i += src.slice(i + 1).match(/^[ \t]*\r?\n/)[0].length;
      out += " ";
    } else out += c;
  }
  return { code: out, literals };
}

function refFor(value, { bundle = false } = {}) {
  const s = String(value).trim();
  if (!s) return null;
  if (bundle || (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s) && !/\.app$/i.test(s))) return { bundle_id: s };
  return { name: s.replace(/\.app$/i, "") };
}

// ---- AppleScript ----
const AS_DENY = [
  [/\bdo\s+shell\s+script\b/i, "`do shell script` runs a shell"],
  [/\b(run|load|store)\s+script\b/i, "`run/load/store script` executes code the policy cannot read"],
  [/\buse\s+framework\b/i, "AppleScriptObjC (`use framework`) reaches Cocoa directly"],
  [/\bcurrent\s+application\s*'s\b/i, "AppleScriptObjC (`current application's`) reaches Cocoa directly"],
  [/\bNS(Task|UserUnixTask|UserScriptTask|AppleScript|Workspace)\b/i, "Cocoa process and script classes are not app scripting"],
  [/\bcall\s+method\b/i, "`call method` reaches Objective-C"],
  [/«/, "raw Apple event codes («event …») bypass the dictionary the policy reads"],
  [/\bosascript\b/i, "nested osascript is refused"],
  [/\bdo\s+script\b/i, "`do script` runs a shell command in a terminal"],
  // System Events keystrokes and coordinate clicks land on whatever app is
  // frontmost, whichever process the script names; use the type/key/click
  // tools, which carry the per-app gates.
  [/\b(keystroke|key\s+code)\b/i, "System Events keystrokes go to the frontmost app, not the named one — use the type or key tool"],
  [/\bclick\s+at\b/i, "coordinate clicks through System Events go to whatever is on screen — use the click tool"],
  // StandardAdditions run in osascript itself, whatever app a script names:
  // file I/O, opening URLs, mounting volumes and reading the environment are
  // not app scripting.
  [/\bopen\s+for\s+access\b/i, "StandardAdditions file access (`open for access`) is not app scripting"],
  [/\b(read|write)\b[^\n]*\b(POSIX\s+file|file|alias)\b/i, "StandardAdditions file reads and writes are not app scripting"],
  [/\bopen\s+location\b/i, "`open location` opens a URL outside any consented app"],
  [/\bmount\s+volume\b/i, "`mount volume` is not app scripting"],
  [/\bsystem\s+attribute\b/i, "`system attribute` reads the environment"],
  // A consented app must not become a launcher for another app or a
  // runnable file (Finder, `launch`, `reopen`).
  [/\b(open|launch|reopen)\b[^\n]*\b(POSIX\s+file|file|alias|application\s+file|disk\s+item)\b/i, "opening files or applications through another app is refused — use open_application, which asks for consent"],
];

function checkTargetLiteral(lit) {
  if (lit.includes("\\")) return "escape sequences are refused in application names";
  if (/[/:]/.test(lit)) return "application paths are refused — name the application directly, e.g. \"Finder\"";
  return null;
}

function checkAppleScript(script) {
  // Join ¬ continuations so a phrase split across lines is still one phrase.
  const src = script.replace(/¬[ \t]*\r?\n/g, " ");
  const targets = [];
  const refused = (reason) => ({ refused: reason, targets });
  // Any other use of `application`/`app` must be a form the policy knows:
  // `current application`, `application "X"`, `application id "X"`,
  // `application process "X"`, or `application file`/`application support`
  // inside strings (already stripped). A computed target is refused.
  const masked = maskAppleScript(script);
  if (masked.refused) return refused(masked.refused);
  const { code: bare, literals } = masked;
  let targetRefusal = null;
  let staticRefusal = null;
  for (const m of bare.matchAll(/\b(application|app)\b(\s*(?:id\s*)?)(.?)/gi)) {
    const before = bare.slice(Math.max(0, m.index - 20), m.index);
    if (/\bcurrent\s+$/i.test(before)) continue;
    if (m[3] === '"') {
      const lit = literals.get(m.index + m[1].length + m[2].length);
      targetRefusal ??= checkTargetLiteral(lit);
      const ref = refFor(lit, { bundle: /\bid\b/i.test(m[2]) });
      if (ref) targets.push(ref);
      continue;
    }
    const rest = bare.slice(m.index + m[1].length);
    if (/^\s*process(es)?\b/i.test(rest)) continue;
    if (/^\s*support\b/i.test(rest)) continue; // path to application support
    staticRefusal ??= "the script names an application the policy cannot read statically — name it as a literal: tell application \"Name\"";
  }
  // A System Events process reached by index or predicate (process 1, first
  // process whose frontmost is true) is an app the ledger never saw. Only a
  // literal name, or listing names, is allowed.
  for (const m of bare.matchAll(/\bprocess(es)?\b/gi)) {
    const rest = bare.slice(m.index + m[0].length);
    const before = bare.slice(Math.max(0, m.index - 40), m.index);
    const pm = !m[1] ? /^\s*("")/.exec(rest) : null;
    if (pm) {
      const lit = literals.get(m.index + m[0].length + pm[0].length - 2);
      targetRefusal ??= checkTargetLiteral(lit);
      const ref = refFor(lit);
      if (ref) targets.push(ref);
      continue;
    }
    if (/\bname\s+of\s+(every\s+)?(application\s+)?$/i.test(before)) continue;
    staticRefusal ??= "System Events processes must be named with a literal (process \"Name\") so the app can be consented";
  }
  if (targetRefusal) return refused(targetRefusal);
  for (const [re, why] of AS_DENY) if (re.test(src)) return refused(why);
  if (staticRefusal) return refused(staticRefusal);
  return { refused: null, targets };
}

// ---- JXA ----
// Checked against the script with string literals and comments removed: text
// inside either cannot run unless something evaluates it or indexes by it, and
// both of those are refused below. A template interpolation, a regular
// expression or an HTML-style comment would let the mask misread where code
// ends, so each is refused outright.
const JXA_DENY = [
  [/doShellScript/i, "`doShellScript` runs a shell"],
  [/\bdoScript\b/, "`doScript` runs a shell command in a terminal"],
  [/\.\s*(keystroke|keyCode)\s*\(/, "System Events keystrokes go to the frontmost app, not the named one — use the type or key tool"],
  [/\.\s*click\s*\(\s*\{/, "coordinate clicks through System Events go to whatever is on screen — use the click tool"],
  [/\bObjC\b/, "the Objective-C bridge (ObjC) reaches Cocoa directly"],
  [/\$\s*[.([]/, "the Objective-C bridge ($) reaches Cocoa directly"],
  [/\bNS(Task|UserUnixTask|UserScriptTask|AppleScript|Workspace)\b/, "Cocoa process and script classes are not app scripting"],
  [/includeStandardAdditions/, "StandardAdditions exposes doShellScript; use the app's own dictionary"],
  [/\b(eval|Function|Library|Ref|require|importScripts|constructor|prototype|__proto__|Reflect|Proxy)\b/, "dynamic code loading, evaluation and reflection are refused"],
  [/\bObject\s*\.\s*(getOwnProperty\w*|defineProperty|defineProperties|entries|values|assign|getPrototypeOf|setPrototypeOf)\b/, "reflection over objects is refused"],
  [/\bosascript\b/i, "nested osascript is refused"],
  [/\.\s*(open|launch|reopen)\s*\(/, "opening files or applications through another app is refused — use open_application, which asks for consent"],
  [/\bPath\s*\(/, "file paths (Path(…)) are not app scripting"],
  [/\.\s*(openLocation|mountVolume|systemAttribute|openForAccess|read|write)\s*\(/, "StandardAdditions calls are not app scripting"],
];

function checkJxa(script) {
  const targets = [];
  const refused = (reason) => ({ refused: reason, targets });
  const masked = maskJxa(script);
  if (masked.refused) return refused(masked.refused);
  const { code, literals } = masked;
  let targetRefusal = null;
  let staticRefusal = null;
  // Application must be called with one literal, or be .currentApplication().
  for (const m of code.matchAll(/\bApplication\b/g)) {
    const rest = code.slice(m.index + "Application".length);
    if (/^\s*\.\s*currentApplication\s*\(\s*\)/.test(rest)) continue;
    if (/^\s*\(\s*``/.test(rest)) { staticRefusal ??= "Application(`…`) may interpolate — name the app with a plain string"; continue; }
    const lm = /^\s*\(\s*(""|'')\s*\)/.exec(rest);
    if (lm) {
      const lit = literals.get(m.index + "Application".length + lm[0].indexOf(lm[1]));
      targetRefusal ??= checkTargetLiteral(lit);
      const ref = refFor(lit);
      if (ref) targets.push(ref);
      continue;
    }
    staticRefusal ??= "the script names an application the policy cannot read statically — use Application(\"Name\")";
  }
  // System Events processes: a literal .byName("X"), or listing names.
  for (const m of code.matchAll(/\b(applicationProcesses|processes)\b/g)) {
    const rest = code.slice(m.index + m[0].length);
    const bm = /^\s*\.\s*byName\s*\(\s*(""|'')\s*\)/.exec(rest);
    if (bm) {
      const lit = literals.get(m.index + m[0].length + bm[0].indexOf(bm[1]));
      targetRefusal ??= checkTargetLiteral(lit);
      const ref = refFor(lit);
      if (ref) targets.push(ref);
      continue;
    }
    if (/^\s*\.\s*name\s*\(\s*\)/.test(rest)) continue;
    staticRefusal ??= "System Events processes must be named with .byName(\"Name\") so the app can be consented";
  }
  if (targetRefusal) return refused(targetRefusal);
  if (/doShellScript/i.test(script)) return refused("`doShellScript` runs a shell");
  if (/\\u|\\x/.test(script)) return refused("escape sequences are refused so names cannot be spelled around the policy");
  for (const [re, why] of JXA_DENY) if (re.test(code)) return refused(why);
  // Computed member access could spell doShellScript at runtime; only numeric
  // indexes are allowed. Collections take .at(i) and .byName("x") instead.
  for (const m of code.matchAll(/(?:[\p{ID_Continue}$)\]}"'`]|\d\.|\?\.)\s*\[([^\]]*)\]/gu)) {
    if (!/^\s*\d+\s*$/.test(m[1])) return refused("computed member access (x[expr]) is refused — use .at(i), .byName(\"Name\") or a literal property");
  }
  // Computed keys in object literals and destructuring patterns ({[k]: v}).
  if (/[{,]\s*\[/.test(code)) return refused("computed keys ({[expr]: …}) and nested array literals are refused");
  if (/[{,]\s*(""|'')\s*:/.test(code)) return refused("quoted property keys ({\"key\": …}) are refused — write an unquoted identifier key");
  if (staticRefusal) return refused(staticRefusal);
  return { refused: null, targets };
}

// Apps whose scripting dictionary is itself a shell or a script runner.
// Driving them through app_script is arbitrary command execution by another
// name, so they are refused as targets in the default mode.
const SHELL_HOSTS = new Set([
  "terminal", "iterm", "iterm2", "warp", "alacritty", "kitty", "ghostty", "wezterm", "hyper", "tabby",
  "script editor", "automator", "shortcuts", "shortcuts events", "osascript",
  "com.apple.terminal", "com.googlecode.iterm2", "dev.warp.warp-stable", "org.alacritty", "net.kovidgoyal.kitty",
  "com.mitchellh.ghostty", "com.github.wez.wezterm", "co.zeit.hyper", "com.apple.scripteditor2", "com.apple.automator",
  "com.apple.shortcuts", "com.apple.shortcuts.events",
]);
const shellHost = (ref) => SHELL_HOSTS.has(String(ref.bundle_id ?? ref.name ?? "").trim().toLowerCase());

/**
 * Check one app_script call. Returns {refused: string|null, targets: ref[]}
 * where each ref is {name} or {bundle_id} for the consent ledger.
 */
/** The consent identity of a script that names no application: osascript itself. */
export const OSASCRIPT_TARGET = Object.freeze({ bundle_id: "com.apple.osascript" });

export function checkAppScript(script, language = "applescript", env = process.env) {
  const mode = appScriptMode(env);
  if (mode === "off") return refuse("app_script is turned off on this computer (CODEWHALE_CU_APP_SCRIPT=off)");
  const checked = language === "javascript" ? checkJxa(String(script)) : checkAppleScript(String(script));
  // A script that names no app still runs, as osascript: it is consented to
  // under that identity, in every mode.
  if (!checked.targets.length) checked.targets.push({ ...OSASCRIPT_TARGET });
  if (mode === "unrestricted") return { refused: null, targets: checked.targets };
  if (checked.refused) return checked;
  const host = checked.targets.find(shellHost);
  if (host) return { refused: `${host.name ?? host.bundle_id} runs shell commands or scripts — app_script does not drive it`, targets: checked.targets };
  return checked;
}
