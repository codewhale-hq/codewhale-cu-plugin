import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const BACKUP_NAME = /^(\d{13})-[0-9a-f-]{36}(\.app)?$/;

export function assertStandaloneMacBundle(bundle) {
  if (!bundle) return;
  const parent = path.dirname(path.resolve(bundle));
  let existing = parent;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const physical = path.resolve(fs.realpathSync(existing), path.relative(existing, parent));
  const container = physical.split(path.sep).findLast(part => /\.app$/i.test(part));
  if (container) throw new Error(`Computer Use is included in ${container.replace(/\.app$/i, "")}. Update that app to update Computer Use.`);
}

export function backupsToKeep(env = process.env) {
  const keep = Number(env.CODEWHALE_CU_BACKUPS_KEEP);
  return Number.isInteger(keep) && keep >= 1 ? keep : 2;
}

export function pruneBackups(dir, keep = backupsToKeep(), protect = null) {
  const removed = [];
  if (!Number.isInteger(keep) || keep < 1) return removed;
  let names;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) {
      console.warn(`Computer Use will not prune a symlinked backup directory ${JSON.stringify(dir)}`);
      return removed;
    }
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Computer Use could not read backup directory ${JSON.stringify(dir)}: ${error.code ?? error.message}`);
    return removed;
  }
  const ours = names.filter((entry) => entry.isDirectory()).map(({ name }) => ({ name, match: BACKUP_NAME.exec(name) })).filter((entry) => entry.match)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]) || (a.name < b.name ? 1 : -1));
  const kept = new Set(protect ? [path.basename(protect)] : []);
  for (const { name } of ours) if (kept.size < keep) kept.add(name);
  for (const { name } of ours) {
    if (kept.has(name)) continue;
    const target = path.join(dir, name);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) continue;
      const pending = [target];
      while (pending.length) {
        const current = pending.pop();
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory()) continue;
        fs.chmodSync(current, stat.mode | 0o700);
        for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
      }
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      console.warn(`Computer Use could not remove expired backup ${JSON.stringify(target)}: ${error.code ?? error.message}`);
    }
  }
  return removed;
}

/** Publish a verified bundle in one rename, retaining the previous install. */
export function replaceMacBundle(source, destination, { prepare = () => {}, verify = verifySignature } = {}) {
  assertStandaloneMacBundle(destination);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(destination) && !fs.existsSync(path.join(destination, "Contents", "Resources", "plugin", "app", "daemon.mjs"))) throw new Error("The installation destination contains a different application.");
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("The installation destination must not be a symlink.");
  const staging = fs.mkdtempSync(path.join(parent, ".codewhale-cu-update-"));
  const next = path.join(staging, path.basename(destination));
  let backup = null;
  try {
    fs.cpSync(source, next, { recursive: true });
    prepare(next);
    verify(next);
    if (fs.existsSync(destination)) {
      const backups = path.join(parent, ".codewhale-cu-backups");
      fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
      backup = path.join(backups, `${Date.now()}-${crypto.randomUUID()}.app`);
      fs.renameSync(destination, backup);
    }
    try { fs.renameSync(next, destination); }
    catch (error) { if (backup) fs.renameSync(backup, destination); throw error; }
    if (backup) pruneBackups(path.dirname(backup), undefined, backup);
    return { backup };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

export function verifySignature(bundle) {
  const result=spawnSync("codesign",["--verify","--deep","--strict",bundle],{encoding:"utf8"});
  if(result.status!==0) throw new Error(`The app signature did not verify: ${result.stderr?.trim() ?? "codesign unavailable"}`);
}

export function verifyReleaseBundle(bundle) {
  verifySignature(bundle);
  const requirement='=anchor apple generic and identifier "net.codewhale.computer-use" and certificate leaf[subject.OU] = "5RDNSHA5TY"';
  for(const [command,args] of [["/usr/bin/codesign",["--verify","--strict","-R",requirement,bundle]],["/usr/sbin/spctl",["--assess","--type","execute","--verbose=2",bundle]]]) {
    const result=spawnSync(command,args,{encoding:"utf8"});
    // Gatekeeper ships with macOS. Requiring its notarized source also rejects
    // local allow-list overrides; consumer Macs do not need Xcode's stapler.
    if(result.status!==0 || (command.endsWith("/spctl") && !/^source=Notarized Developer ID\r?$/m.test(result.stderr))) throw new Error("The update is not a valid notarized Codewhale release. Your current app has been kept.");
  }
  if(!fs.existsSync(path.join(bundle,"Contents","MacOS","node"))) throw new Error("The release is missing its bundled runtime.");
}
