// app_script: the programmatic interface into apps with a scripting
// dictionary. Local-computer only — a remote channel must never become a
// shell, so ssh/hdc computers refuse before dispatch and the remote agent
// refuses again at its own handler boundary.
import { hostKeysLine, attest, attestParams } from "./fixtures/host-decision.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";
import { handle, issueAppScriptToken } from "../src/app-handler.mjs";
import { checkAppScript } from "../src/app-script-policy.mjs";
process.env.CODEWHALE_CU_APPROVAL = "strict";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

async function boot(t, env = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-script-"));
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-script-rec-"));
  const child = spawn("node", [path.join(ROOT, "mcp", "server.mjs")], {
    env: { ...process.env, CODEWHALE_CU_STATE_DIR: stateDir, CODEWHALE_CU_RECORDINGS_DIR: recDir, CODEWHALE_CU_APP: "off", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(hostKeysLine());
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
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const rpc = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 20_000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: attestParams(method, params) }) + "\n");
    });
  };
  const tool = async (name, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);
  return { rpc, tool };
}

test("tools/list advertises app_script with a required script", async (t) => {
  const s = await boot(t);
  const tools = (await s.rpc("tools/list", {})).result.tools;
  const def = tools.find((x) => x.name === "app_script");
  assert.ok(def, "app_script must be advertised");
  assert.deepEqual(def.inputSchema.required, ["script"]);
  assert.equal(def.annotations?.readOnlyHint, false, "scripting mutates apps; hosts must not treat it as read-only");
});

test("app_script runs AppleScript and JXA on the local computer", { skip: process.platform !== "darwin" }, async (t) => {
  const s = await boot(t);
  // A script that names no app runs as osascript and needs that consent.
  const unconsented = await s.tool("app_script", { script: 'return "whole computer"' });
  assert.equal(unconsented.error?.code, "consent_required");
  assert.equal((await s.tool("consent", { action: "allow", bundle_id: "com.apple.osascript" })).ok, true);
  const as = await s.tool("app_script", { script: 'return "whole computer"' });
  assert.equal(as.ok, true);
  assert.equal(as.result, "whole computer");
  const jxa = await s.tool("app_script", { script: '"ok".toUpperCase()', language: "javascript" });
  assert.equal(jxa.ok, true);
  assert.equal(jxa.result, "OK");
  assert.equal(jxa.language, "javascript");
});

test("app_script failures are typed, never opaque", { skip: process.platform !== "darwin" }, async (t) => {
  const s = await boot(t);
  assert.equal((await s.tool("consent", { action: "allow", bundle_id: "com.apple.osascript" })).ok, true);
  const bad = await s.tool("app_script", { script: "this is not applescript at all" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "script_error");
  assert.match(bad.error.message, /syntax error|expected/i);
  for (const [args, match] of [
    [{ script: "  " }, /non-empty script/],
    [{ script: "return 1", language: "perl" }, /language/],
    [{ script: "return 1", timeout: 0 }, /timeout/],
    [{ script: "return 1", timeout: 500 }, /timeout/],
  ]) {
    const r = await s.tool("app_script", args);
    assert.equal(r.error?.code, "bad_args", JSON.stringify(args));
    assert.match(r.error.message, match);
  }
});

test("app_script is refused on remote computers before any dispatch", async (t) => {
  const s = await boot(t);
  const reg = await s.tool("computer", { action: "register", id: "faraway", transport: "ssh", host: "192.0.2.1", installAgent: false });
  assert.equal(reg.ok, true);
  const r = await s.tool("app_script", { script: "return 1", computer: "faraway" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unsupported_on_transport");
});

test("the remote agent refuses app_script at its own boundary", async () => {
  const r = await handle({ tool: "app_script", args: { script: "return 1" } }, { computerId: "remote", sessionId: "ssh-serve" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unsupported_on_transport");
});

test("the local handler runs app_script through the normal session machinery", { skip: process.platform !== "darwin" }, async () => {
  const approvalToken = issueAppScriptToken(undefined, 'return "via handler"');
  const r = await handle({ tool: "app_script", args: { script: 'return "via handler"', approvalToken } }, { computerId: "local", sessionId: "test-script" });
  assert.equal(r.ok, true);
  assert.equal(r.tool, "app_script");
  assert.equal(r.data.result, "via handler");
});

test("a read-only grant never advertises or calls app_script", async (t) => {
  const s = await boot(t, { CODEWHALE_CU_GRANT: "read-only" });
  const names = (await s.rpc("tools/list", {})).result.tools.map((x) => x.name);
  assert.ok(!names.includes("app_script"));
  assert.equal((await s.tool("app_script", { script: "return 1" })).error?.code, "not_granted");
});

test("a named grant admits app_script exactly", { skip: process.platform !== "darwin" }, async (t) => {
  const s = await boot(t, { CODEWHALE_CU_GRANT: "app_script,consent" });
  const names = (await s.rpc("tools/list", {})).result.tools.map((x) => x.name);
  assert.ok(names.includes("app_script"));
  assert.equal((await s.tool("consent", { action: "allow", bundle_id: "com.apple.osascript" })).ok, true);
  assert.equal((await s.tool("app_script", { script: "return 42" })).result, "42");
});

test("the kill switch stops scripting too", async (t) => {
  const s = await boot(t);
  assert.equal((await s.tool("stop_computer_control", {})).ok, true);
  const r = await s.tool("app_script", { script: "return 1" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "control_stopped");
});

test("unrestricted mode still honors a deny for a named target", async (t) => {
  const s = await boot(t, { CODEWHALE_CU_APP_SCRIPT: "unrestricted" });
  assert.equal((await s.tool("consent", { action: "deny", app: "Mail" })).ok, true);
  const r = await s.tool("app_script", { script: 'tell application "Mail" to do shell script "id"' });
  assert.equal(r.error?.code, "app_denied");
  const bare = await s.tool("app_script", { script: "return 1" });
  assert.equal(bare.error?.code, "consent_required", "a no-app script needs osascript consent in every mode");
});

const BT = "`";
const SHELL = 'var a=Application.currentApplication();a.includeStandardAdditions=true;';
const HIDDEN_RUN = SHELL + 'a["do"+"ShellScript"]("id")';
const JXA_HIDDEN = [
  ["a template interpolation", BT + '${(()=>{' + SHELL + 'return a["do"+"ShellScript"]("printf x")})()}' + BT],
  ["an interpolation inside Application()", 'Application(' + BT + '${"Fin"+"der"}' + BT + ').windows.at(0).name()'],
  ["an interpolation in a tagged template", 'String.raw' + BT + '${Application("Terminal")}' + BT],
  ["an interpolation nested in an interpolation", BT + 'a${' + BT + 'b${Application("Terminal")}' + BT + '}' + BT],
  ["an interpolation after an escaped backtick", BT + '\\' + BT + '${Application("Terminal")}' + BT],
  ["code after an apostrophe in a line comment", "// it's\n" + SHELL + 'a["do"+"ShellScript"]("id")\n// \''],
  ["code after a quote in a block comment", '/* " */' + SHELL + 'a["do"+"ShellScript"]("id")' + '/* " */'],
  ["code after a quote in a regular expression", "var r = /'/;" + SHELL + 'a["do"+"ShellScript"]("id");var s = \'x\''],
  ["code after a keyword and a regular expression", "function f(){return /'/.test(1)}" + SHELL + 'a["do"+"ShellScript"]("id");f(\'x\')'],
  ["code after a quote in an HTML-style comment", "<!-- '\n" + SHELL + 'a["do"+"ShellScript"]("id")\n<!-- \''],
  ["code after a line separator in a line comment", "// '\u2028" + SHELL + 'a["do"+"ShellScript"]("id")\n// \''],
  ["code after a paragraph separator in a line comment", "// '\u2029" + SHELL + 'a["do"+"ShellScript"]("id")\n// \''],
  ["code after a carriage return in a line comment", "// '\r" + SHELL + 'a["do"+"ShellScript"]("id")\n// \''],
  ["code after a quote on a hashbang line", "#! jxa '\n" + HIDDEN_RUN + "\n'"],
  ["code after a BOM and /* on a hashbang line", "\uFEFF#! /*\n" + HIDDEN_RUN + "\n/* */"],
  ["code after a BOM and backtick on a hashbang line", "\uFEFF#! " + BT + "\n" + HIDDEN_RUN + "\n// " + BT],
  ["code after a BOM and quote on a hashbang line", "\uFEFF#! '\n" + HIDDEN_RUN + "\n'"],
  ["code after a regular expression heritage", "class A extends /'/ {}\n" + HIDDEN_RUN + "\nvar s = 'x'"],
  ["code after a regular expression following break", "while(1){break\n/'/.test(1)}\n" + HIDDEN_RUN + "\nvar s = 'x'"],
  ["code after a regular expression following continue", "for(var i=0;i<1;i++){continue\n/'/.test(1)}\n" + HIDDEN_RUN + "\nvar s = 'x'"],
  ["code after a regular expression following debugger", "debugger\n/'/.test(1)\n" + HIDDEN_RUN + "\nvar s = 'x'"],
  ["code after a regular expression in a for-await body", "async function f(){for await (var x of y) /'/.test(1)}\n" + HIDDEN_RUN + "\nvar s = 'x'"],
  ["code after a regular expression following default", "var o = {};\nswitch(1){default: /'/.test(1)}\n" + HIDDEN_RUN + "\nvar s = 'x'"],
  ["code inside an unterminated single-quoted string", "var s = '" + HIDDEN_RUN],
  ["code inside an unterminated double-quoted string", 'var s = "' + HIDDEN_RUN],
  ["code inside an unterminated template", "var s = " + BT + HIDDEN_RUN],
  ["code inside an unterminated block comment", "/* " + HIDDEN_RUN],
  ["code after a string that crosses a line", "var s = 'a\n" + HIDDEN_RUN + "\nvar t = 'b'"],
  ["code after a string that crosses a carriage return", 'var s = "a\r' + HIDDEN_RUN + '\rvar t = "b"'],
  ["code after a backslash that ends the script", "var s = 'a\\"],
  ["computed member via optional chaining", 'var o = {a: 1}; o?.["con" + "structor"]'],
  ["computed member via optional chaining with spaces", 'var o = {a: 1}; o ?. ["con" + "structor"]'],
  ["computed member after a tagged template", '((x)=>x)' + BT + 'a' + BT + '["do" + "ShellScript"]'],
  ["computed member after String.raw tagged template", 'String.raw' + BT + 'x' + BT + '["length"]'],
  ["computed member after a function expression", 'var F = function(){}["constructor"]; F("return 42")()'],
  ["computed member after an object literal", 'var v = {a: 1}["a"]'],
  ["computed member after a string literal", '""["constructor"]'],
  ["computed member after a non-ASCII identifier", 'var \u03bb = function(){}; \u03bb["constructor"]("return 42")()'],
  ["computed member after a numeric dot", '1.["toString"]'],
  ["quoted key in a destructuring pattern", 'var {"constructor": F} = function(){}; F("return 42")()'],
  ["quoted key in a multi-key destructuring pattern", 'var {a: 1, "constructor": F} = {a: 1, constructor: function(){}}; F("return 42")()'],
  ["chained bracket after numeric index", '[function(){}][0]["constructor"]("return 42")()'],
  ["chained bracket after variable index", 'var a = [globalThis]; a[0]["eval"]("42")'],
  ["chained bracket after optional chaining index", 'var a = [function(){}]; a?.[0]["constructor"]("return 42")()'],
  ["chained bracket after numeric index and block comment", '[function(){}][0] /* c */ ["constructor"]("return 42")()'],
  ["aliased Objective-C bridge ($)", 'var b = $; b.NSClassFromString("NS" + "Task")'],
  ["destructured Objective-C bridge ($)", 'var { NSString } = $; NSString.stringWithString("ok").js'],
  ["with ($) Objective-C bridge", 'with ($) { NSString.stringWithString("ok").js }'],
  ["aliased Path constructor", 'var p = Path; p("/tmp").toString()'],
  ["detached Finder.open method", 'var f = Application("Finder"); var op = f.open; op("/tmp")'],
  ["detached Finder.launch method", 'var f = Application("Finder"); var l = f.launch; l()'],
  ["detached System Events keystroke method", 'var se = Application("System Events"); var k = se.keystroke; k("id")'],
  ["detached System Events click method", 'var se = Application("System Events"); var cl = se.click; cl({at: [10, 10]})'],
  ["destructured Finder.open method", 'var { open } = Application("Finder"); open("/tmp")'],
  ["destructured System Events click method", 'var { click } = Application("System Events"); click({at: [10, 10]})'],
];

test("the JXA policy refuses code a template, comment or regular expression would hide", () => {
  const accepted = JXA_HIDDEN.filter(([, script]) => !checkAppScript(script, "javascript", { CODEWHALE_CU_APP_SCRIPT: "apps" }).refused).map(([what]) => what);
  assert.deepEqual(accepted, []);
});

test("the JXA policy still reads templates, comments and division that run nothing", () => {
  for (const script of [
    'Application("Finder").name() + ' + BT + 'plain text' + BT,
    BT + 'a \\${not interpolated}' + BT,
    '// it\'s a "comment"\nApplication("Finder").windows.at(0).name()',
    '/* it\'s a "comment" */ Application("Finder").name()',
    'var n = Application("Finder").windows.length / 2; n',
    'var n = (1 + 2) / 3; n',
    '#!/usr/bin/env jxa\nApplication("Finder").name()',
    '\uFEFF#!/usr/bin/env jxa\nApplication("Finder").name()',
    "var s = 'a\\\nb'; s",
    "var s = 'a\\\r\nb'; s",
    "var s = 'a\u2028b'; s",
    'class A extends Object {}\nApplication("Finder").name()',
    'for (var i = 0; i < 2; i++) { if (i) continue\n}\nApplication("Finder").name()',
    'new RegExp("a")',
    'Application("System Events").processes.byName("Safari").windows?.[0].name()',
    'switch (1) { case "a": Application("Finder").name(); break; }',
    'var x = true ? "a" : "b"; x',
    'Application("Finder"); "/tmp/a:b"',
  ]) {
    const r = checkAppScript(script, "javascript", { CODEWHALE_CU_APP_SCRIPT: "apps" });
    assert.equal(r.refused, null, script);
  }
});

test("the policy resolves targets through comments and refuses escaped or path-form app names", () => {
  for (const [script, language] of [
    ['Application(/* c */"Terminal").name()', "javascript"],
    ['Application("Terminal"/* c */).name()', "javascript"],
    ['Application(// c\n"Terminal").name()', "javascript"],
    ['Application/* c */("Terminal").name()', "javascript"],
    ['Application("System Events").processes.byName(/* c */"Terminal").name()', "javascript"],
    ["var s = 'Application(\"'; Application(\"Terminal\").activate()", "javascript"],
    ['Application(/* c */' + BT + 'Finder' + BT + ').name()', "javascript"],
    ['Application("\\Terminal").name()', "javascript"],
    ['Application("\\124erminal").name()', "javascript"],
    ['Application("Term\\\ninal").name()', "javascript"],
    ['Application("System Events").processes.byName("\\Terminal").name()', "javascript"],
    ['Application("/Applications/Utilities/Terminal.app").name()', "javascript"],
    ['Application("Terminal.app/").name()', "javascript"],
    ['Application("Macintosh HD:Applications:Utilities:Terminal.app:").name()', "javascript"],
    ['Application("System Events").processes.byName("/usr/bin/sh").name()', "javascript"],
    ['Application("  TERMINAL.APP  ").name()', "javascript"],
    ['Application("COM.APPLE.TERMINAL").name()', "javascript"],
    ['tell application (* c *) "Terminal" to activate', "applescript"],
    ['tell application id (* c *) "com.apple.Terminal" to activate', "applescript"],
    ['tell application "System Events" to tell process (* c *) "Terminal" to activate', "applescript"],
    ['set s to "tell app \\""; tell application "Terminal" to activate', "applescript"],
    ['tell application "Term\\inal" to activate', "applescript"],
    ['tell application "/Applications/Utilities/Terminal.app" to activate', "applescript"],
    ['tell application "Macintosh HD:Applications:Utilities:Terminal.app:" to activate', "applescript"],
    ['tell application "  TERMINAL.APP  " to activate', "applescript"],
    ['tell application id "COM.APPLE.TERMINAL" to activate', "applescript"],
  ]) {
    const r = checkAppScript(script, language, { CODEWHALE_CU_APP_SCRIPT: "apps" });
    assert.ok(r.refused, `must refuse (${language}): ${script}`);
  }
  assert.deepEqual(checkAppScript('Application(/* c */"Mail").name()', "javascript").targets, [{ name: "Mail" }]);
  assert.deepEqual(checkAppScript('Application("System Events").processes.byName(/* c */"Mail").name()', "javascript").targets, [{ name: "System Events" }, { name: "Mail" }]);
});

test("a comment inside Application() still hits a per-app deny end to end", async (t) => {
  const s = await boot(t);
  assert.equal((await s.tool("consent", { action: "deny", app: "Mail" })).ok, true);
  const denied = await s.tool("app_script", { script: 'Application(/* c */"Mail").name()', language: "javascript" });
  assert.equal(denied.error?.code, "app_denied");
});

test("the AppleScript policy refuses code a comment or quoted name would hide", () => {
  const accepted = [
    ["a quote in a line comment", '-- "\ntell application (appName) to quit\n-- "'],
    ["a quote in a hash comment", '# "\ntell application (appName) to quit\n# "'],
    ["a quote in a block comment", '(* " *)\ntell application (appName) to quit\n(* " *)'],
    ["a quote in a nested block comment", '(* (* *) " *)\ntell application (appName) to quit\n(* " *)'],
    ["a quote in a piped name", 'set |a"| to 1\ntell application (appName) to quit\nset b to "x"'],
    ["a quote in a comment ended by a continuation", '-- "\xac\ntell application (appName) to quit\n-- "'],
    ["an unterminated string", 'set a to "x\ntell application (appName) to quit'],
    ["an unterminated piped name", 'set |a to 1\ntell application (appName) to quit'],
    ["an unterminated block comment", '(* x\ntell application (appName) to quit'],
    ["an escaped pipe inside a piped name", 'set |a\\|b| to 1\ntell application (appName) to quit\nset |c| to 1'],
    ["a string inside a block comment that hides a nested opener", '(* "(*" *)\ntell application (appName) to quit'],
    ["a line comment inside a block comment that hides the closer", '(* -- *)\ntell application (appName) to quit\n*)'],
    ["a piped name inside a block comment", '(* |(*| *)\ntell application (appName) to quit'],
    ["a backslash that ends the script", 'set a to "x\\'],
    ["click at split across a bare CR continuation", 'tell application "System Events" to click ¬\r at {10, 10}'],
    ["a quote in a comment ended by a bare CR continuation", '-- "\u00ac\rtell application (appName) to quit\n-- "'],
  ].filter(([, script]) => !checkAppScript(script, "applescript", { CODEWHALE_CU_APP_SCRIPT: "apps" }).refused).map(([what]) => what);
  assert.deepEqual(accepted, []);
});

test("the AppleScript policy still reads scripts with comments and continuations", () => {
  for (const script of [
    '-- it\'s a "comment"\ntell application "Finder" to get name of every window',
    '(* a comment (* nested *) *)\ntell application "Finder" to get name of every window',
    'tell application "Finder" to get name of every window -- "(*"\n# "',
    'set |a\\|b| to 1\ntell application "Finder" to get name of every window',
    'set a to "x\\"y"\ntell application "Finder" to get name of every window',
    'set a to "line one\nline two"\ntell application "Finder" to get name of every window',
    'tell application \xac\n"Finder" to get name of every window',
    'tell application "Finder" to return "/tmp/a:b"',
  ]) {
    const r = checkAppScript(script, "applescript", { CODEWHALE_CU_APP_SCRIPT: "apps" });
    assert.equal(r.refused, null, script);
  }
});
