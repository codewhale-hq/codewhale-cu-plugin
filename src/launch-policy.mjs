const LAUNCHER = /^(sh|bash|zsh|dash|ash|ksh|csh|tcsh|fish|env|busybox|wsl|py|pythonw|powershell_ise|corepack|npx|npm|pnpm|yarn|bunx?|deno|tsx|ts-node|pipx|uvx?|osascript|powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|ssh|scp|curl|wget|nc|ncat|socat|sudo|su|doas|xargs|node(js)?|python[0-9.]*|pip[0-9.]*|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|lua[0-9.]*|java)$/i;
const DENIED_SCHEME = /^(javascript|vbscript|data):/i;

function launcherName(value, mac) {
  const trimmed = value.trim();
  if (mac && !/[\\/]/.test(trimmed)) return null;
  if (mac && /\.app\/?$/i.test(trimmed)) return null;
  const base = trimmed.replace(/[\s.]+$/, "").replace(/^.*[\\/]/, "").replace(/[\s.]+$/, "").replace(/\.(exe|app|cmd|bat|com)$/i, "");
  return LAUNCHER.test(base) ? base : null;
}

export function launchRefusal({ name, bundle_id, url } = {}, platform = process.platform) {
  const mac = platform === "darwin";
  for (const value of [name, bundle_id]) {
    if (value == null) continue;
    if (typeof value !== "string") return { code: "bad_args", message: "open_application name and bundle_id must be strings" };
    const base = launcherName(value, mac);
    if (base) return { code: "launch_refused", message: `open_application starts applications, not interpreters, shells or package runners ("${base}"); use the application's own name` };
  }
  if (url != null && url !== "") {
    const bad = typeof url !== "string" || url.length > 2048 || /[\0\r\n]/.test(url) || DENIED_SCHEME.test(url.trim())
      || (mac ? url.startsWith("-") : !(/^[A-Za-z][A-Za-z0-9+.-]+:/.test(url) && URL.canParse(url)));
    if (bad) return { code: "bad_args", message: mac ? "open_application url must be a URL or an absolute path" : "open_application url must be an absolute URL (file:/// for a document)" };
  }
  return null;
}
