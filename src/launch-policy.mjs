const LAUNCHER = /^(sh|bash|zsh|dash|ash|ksh|csh|tcsh|fish|env|busybox|wsl|py|pythonw|powershell_ise|corepack|npx|npm|pnpm|yarn|bunx?|deno|tsx|ts-node|pipx|uvx?|osascript|powershell|pwsh(-preview)?|cmd|wscript|cscript|mshta|rundll32|regsvr32|ssh|scp|sftp|ftp|telnet|aria2c|curl|wget|nc|ncat|socat|sudo|su|doas|xargs|awk|gawk|mawk|nawk|tclsh|expect|node(js)?|python[0-9.]*|pypy[0-9.]*|pip[0-9.]*|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|lua[0-9.]*|java|jshell|groovy|kotlin|kotlinc|scala|julia|rscript|swift|swiftc|dotnet|go|cargo|rustc)$/i;
const DENIED_SCHEME = /^(javascript|vbscript|data|ms-msdt|search-ms|ms-search|ms-appinstaller|ms-officecmd|mhtml|jar):/i;
const REMOTE_SCHEME = /^(https?|mailto|file):/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

function launcherName(value, mac) {
  const trimmed = value.trim();
  if (mac && !/[\\/]/.test(trimmed)) return null;
  if (mac && /\.app\/?$/i.test(trimmed)) return null;
  const base = trimmed.replace(/[\s.]+$/, "").replace(/^.*[\\/]/, "").replace(/[\s.]+$/, "").replace(/\.(exe|app|cmd|bat|com)$/i, "");
  return LAUNCHER.test(base) ? base : null;
}

function urlProblem(url, platform, remote) {
  if (typeof url !== "string" || url.length > 2048 || CONTROL.test(url)) return "contains a control character or is not a string";
  const trimmed = url.trim();
  if (DENIED_SCHEME.test(trimmed)) return "uses a scheme that runs code";
  const absoluteUrl = /^[A-Za-z][A-Za-z0-9+.-]+:/.test(trimmed) && URL.canParse(trimmed);
  if (remote) {
    if (!REMOTE_SCHEME.test(trimmed) || !absoluteUrl) return "is not an http, https, mailto or file URL";
  } else if (platform === "darwin") {
    if (!(trimmed.startsWith("/") || absoluteUrl)) return "is neither a URL nor an absolute path";
  } else if (!absoluteUrl) return "is not an absolute URL";
  if (platform === "win32" && /^file:/i.test(trimmed)) {
    const host = new URL(trimmed).hostname;
    if (host && host.toLowerCase() !== "localhost") return "names a network share";
  }
  return null;
}

export function launchRefusal({ name, bundle_id, url } = {}, platform = process.platform, { remote = false } = {}) {
  const mac = platform === "darwin";
  for (const value of [name, bundle_id]) {
    if (value == null) continue;
    if (typeof value !== "string") return { code: "bad_args", message: "open_application name and bundle_id must be strings" };
    const base = launcherName(value, mac);
    if (base) return { code: "launch_refused", message: `open_application starts applications, not interpreters, shells or package runners ("${base}"); use the application's own name` };
  }
  if (url != null && url !== "") {
    const problem = urlProblem(url, platform, remote);
    if (problem) return { code: "bad_args", message: `open_application url ${problem}; ${mac && !remote ? "pass a URL or an absolute path" : remote ? "a remote computer opens only http, https, mailto and file URLs" : "pass an absolute URL (file:/// for a document)"}` };
  }
  return null;
}
