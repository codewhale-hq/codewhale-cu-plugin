import { test } from "node:test";
import assert from "node:assert/strict";
import { launchRefusal } from "../src/launch-policy.mjs";

const code = (args, platform, options) => launchRefusal(args, platform, options)?.code ?? null;

test("interpreters, shells and package runners are refused by name on every platform", () => {
  for (const name of ["node.exe", "bash.exe.", "python3.12", "perl5.36.0", "env", "/bin/sh", "pwsh-preview", "pypy3", "jshell", "sftp", "aria2c", "swift", "dotnet", "awk"]) {
    const platform = name.includes("/") ? "darwin" : "linux";
    assert.equal(code({ name }, platform), "launch_refused", name);
    assert.equal(code({ name }, "win32"), "launch_refused", name);
  }
  assert.equal(code({ name: "/usr/bin/swift" }, "darwin"), "launch_refused");
  assert.equal(code({ bundle_id: "node" }, "linux"), "launch_refused");
});

test("ordinary applications launch, including names that match a tool on macOS", () => {
  for (const name of ["Safari", "Notes", "Visual Studio Code", "Dash", "Java", "Go", "Swift Playgrounds"]) assert.equal(code({ name }, "darwin"), null, name);
  assert.equal(code({ name: "/Applications/Safari.app" }, "darwin"), null);
  assert.equal(code({ name: "Calculator" }, "win32"), null);
  assert.equal(code({ name: 7 }, "linux"), "bad_args");
  assert.equal(code({ bundle_id: ["x"] }, "linux"), "bad_args");
});

test("a url with a control character or a scheme that runs code is refused everywhere", () => {
  for (const url of ["javascript:alert(1)", "java\tscript:alert(1)", "da\tta:text/html,x", "\u0001javascript:alert(1)", "https://example.test/\r\nX-Header: 1", "https://example.test/\u0000", " vbscript:x", "ms-msdt:/id", "search-ms:query=x"]) {
    for (const platform of ["darwin", "linux", "win32"]) assert.equal(code({ name: "Safari", url }, platform), "bad_args", `${platform} ${JSON.stringify(url)}`);
    assert.equal(code({ name: "Safari", url }, "linux", { remote: true }), "bad_args", `remote ${JSON.stringify(url)}`);
  }
});

test("macOS accepts a URL or an absolute path and nothing else", () => {
  for (const url of ["https://example.test/a", "file:///Users/x/a.pdf", "/Users/x/a.pdf", "mailto:a@example.test"]) assert.equal(code({ name: "Safari", url }, "darwin"), null, url);
  for (const url of ["-evil", "relative/path.pdf", "~/a.pdf", "--eval=1"]) assert.equal(code({ name: "Safari", url }, "darwin"), "bad_args", url);
});

test("Linux and Windows accept an absolute URL only, and Windows refuses a network share", () => {
  assert.equal(code({ name: "Firefox", url: "https://example.test/" }, "linux"), null);
  assert.equal(code({ name: "Firefox", url: "/etc/passwd" }, "linux"), "bad_args");
  assert.equal(code({ name: "explorer", url: "file:///C:/Users/x/a.pdf" }, "win32"), null);
  assert.equal(code({ name: "explorer", url: "file://attacker.example/share/a.exe" }, "win32"), "bad_args");
});

test("a Windows file URL must be a local drive path, in every spelling that reaches a share", () => {
  for (const url of ["file:////evil.example/share/a.exe", "file://\\\\evil.example\\share\\a.exe", "file:///\\\\evil.example\\share", "file://localhost//evil/s", "file://%6Cocalhost/share/a.exe", "file://\uFF2C\uFF2F\uFF23\uFF21\uFF2C\uFF28\uFF2F\uFF33\uFF34/share/a.exe", "file://evil.example/share/a.exe", "file:///C:/Users/x/%5Cevil"]) {
    assert.equal(code({ name: "explorer", url }, "win32"), "bad_args", url);
  }
  for (const url of ["file:///C:/Users/x/a.pdf", "file://localhost/D:/docs/a.pdf"]) assert.equal(code({ name: "explorer", url }, "win32"), null, url);
});

test("long names are refused before any pattern runs, and path spellings do not hide an interpreter", () => {
  const started = Date.now();
  assert.equal(code({ name: ".".repeat(100000) + "x" }, "linux"), "bad_args");
  assert.equal(code({ bundle_id: ".".repeat(100000) + "x" }, "darwin"), "bad_args");
  assert.ok(Date.now() - started < 1000);
  for (const name of ["/usr/bin/node/", "/bin/sh/", "/usr/bin/env/", "/usr/bin/osascript/", "/usr/bin/node/.", "/bin/sh/./"]) assert.equal(code({ name }, "darwin"), "launch_refused", name);
  for (const name of ["node18", "nodejs18", "python3.13t", "java17", "tclsh8.6", "wish", "pwsh-7", "bash-5.2", "ruby-3.3"]) assert.equal(code({ name }, "linux"), "launch_refused", name);
  for (const name of ["setup.msi", "run.vbs", "x.js", "x.bat", "install.ps1", "tool.py", "/Users/x/run.command"]) assert.equal(code({ name }, name.startsWith("/") ? "darwin" : "win32"), "launch_refused", name);
});

test("schemes that hand a URL to a shell-like handler are refused", () => {
  for (const url of ["ssh://host/", "telnet://host/", "applescript://com.apple.scripteditor?action=new", "shell:startup"]) assert.equal(code({ name: "Safari", url }, "darwin"), "bad_args", url);
});

test("a remote computer opens only http, https, mailto and file URLs", () => {
  for (const url of ["https://example.test/", "http://localhost:8080/", "mailto:a@example.test", "file:///tmp/a.pdf"]) assert.equal(code({ name: "firefox", url }, "linux", { remote: true }), null, url);
  for (const url of ["ftp://example.test/a", "ms-settings:", "tel:123456", "/etc/passwd", "slack://open", "x-apple.systempreferences:"]) assert.equal(code({ name: "firefox", url }, "linux", { remote: true }), "bad_args", url);
  assert.equal(code({ name: "firefox", url: "slack://open" }, "linux"), null, "a local computer keeps custom schemes");
});
