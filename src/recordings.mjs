// Where screenshots, zoom crops and recordings are written, and the one check
// every caller-chosen output path goes through.
import fs from "node:fs";
import path from "node:path";
import { ExecError } from "./exec.mjs";
import { stateDir } from "./registry.mjs";

const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;
const PRUNE_LIMIT = 5_000;
const CAPTURE_FILE = /\.(png|jpe?g)$/i;

export function captureRetentionDays(env = process.env) {
  const raw = env.CODEWHALE_CU_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 14;
  const days = Number(raw);
  return Number.isFinite(days) && (days === 0 || days >= 1) ? days : 0;
}

const realFolder = (folder) => { try { return fs.lstatSync(folder).isDirectory(); } catch { return false; } };

export function pruneCaptures(dir, { days = captureRetentionDays(), now = Date.now() } = {}) {
  const removed = [];
  if (!(days > 0) || !Number.isFinite(days) || !Number.isFinite(now) || !realFolder(dir)) return removed;
  const marker = path.join(dir, ".pruned");
  try {
    const age = now - fs.statSync(marker).mtimeMs;
    if (age > -60_000 && age < PRUNE_EVERY_MS) return removed;
  } catch {}
  const cutoff = now - days * DAY_MS;
  for (const folder of [dir, path.join(dir, "captures")]) {
    if (!realFolder(folder)) continue;
    let names;
    try { names = fs.readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (removed.length >= PRUNE_LIMIT) break;
      if (!CAPTURE_FILE.test(name)) continue;
      const file = path.join(folder, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        fs.unlinkSync(file);
        removed.push(file);
      } catch { continue; }
    }
  }
  try { fs.writeFileSync(marker, `${new Date(now).toISOString()}\n`, { mode: 0o600 }); } catch { return removed; }
  return removed;
}

let pruned = false;

/** The one recordings directory: desktop and browser captures, zoom crops,
 * recordings and trajectories all live under it. */
export function recordingsDir() {
  const dir = path.resolve(process.env.CODEWHALE_CU_RECORDINGS_DIR || path.join(stateDir(), "recordings"));
  if (!process.env.CODEWHALE_CU_RECORDINGS_DIR) {
    try {
      if (process.platform !== "win32") {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.statSync(dir).mode & 0o077) fs.chmodSync(dir, 0o700);
      }
      if (!pruned) { pruned = true; pruneCaptures(dir); }
    } catch { return dir; }
  }
  return dir;
}

const badPath = (message) => Object.assign(new ExecError(message), { code: "bad_args" });

function inside(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Validate a caller-supplied capture output path. `undefined`/`null` means
 * "use the default name" and returns null. Anything else must be an absolute
 * .png/.jpg/.jpeg filename inside the recordings directory, must not be an
 * existing symlink, and its parent must not resolve outside that directory.
 * Creates the recordings directory (and the parent) so the checks see the
 * real filesystem. Returns the resolved absolute path.
 */
export function recordingsOutputPath(file) {
  if (file === undefined || file === null) return null;
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
    throw badPath("output path must be an absolute filename inside the recordings directory");
  }
  if (!/\.(png|jpe?g)$/i.test(file)) throw badPath("output path must end in .png, .jpg or .jpeg");
  const dir = recordingsDir();
  const resolved = path.resolve(file);
  if (!inside(dir, resolved)) {
    throw badPath(`output path must be inside the recordings directory (${dir}); omit path to use a generated name there`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  // Resolve the deepest parent that exists before creating anything, so a
  // symlinked subdirectory cannot redirect the mkdir or the capture.
  let existing = path.dirname(resolved);
  const present = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  while (!present(existing)) existing = path.dirname(existing);
  let realParent;
  try { realParent = fs.realpathSync(existing); } catch { throw badPath("output path's parent directory cannot be resolved"); }
  if (realParent !== realDir && !inside(realDir, realParent)) {
    throw badPath("output path must not leave the recordings directory through a symlink");
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let stat = null;
  try { stat = fs.lstatSync(resolved); } catch { /* does not exist yet */ }
  if (stat?.isSymbolicLink()) throw badPath("output path must not be a symlink");
  return resolved;
}
