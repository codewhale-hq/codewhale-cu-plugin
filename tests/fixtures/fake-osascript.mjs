// Test preload (node --import) for a server under test: child_process.execFile
// of osascript goes to this fake, so no test can show a real dialog. With
// FAKE_OSASCRIPT_DIR set, dialog n writes prompt-<n>.json there and waits for
// answer-<n>.json ({stdout} or {error, code}); a killed dialog leaves
// aborted-<n>. Without it every dialog is denied at once. If the replacement
// does not take, the process exits before the server loads.
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const real = cp.execFile;
const dir = process.env.FAKE_OSASCRIPT_DIR || null;
let seq = 0;

function fakeExecFile(file, args, options, callback) {
  if (path.basename(String(file)) !== "osascript") return real.apply(this, arguments);
  if (typeof options === "function") [options, callback] = [{}, options];
  const n = ++seq;
  let done = false;
  let timer = null;
  const finish = (error, stdout = "", stderr = "") => {
    if (done) return;
    done = true;
    clearInterval(timer);
    setImmediate(() => callback?.(error, stdout, stderr));
  };
  if (!dir) {
    finish(Object.assign(new Error("execution error: User canceled. (-128)"), { code: 1 }), "", "execution error: User canceled. (-128)");
    return {};
  }
  fs.writeFileSync(path.join(dir, `prompt-${n}.json`), JSON.stringify({ file, args, timeout: options?.timeout ?? null }));
  const answerFile = path.join(dir, `answer-${n}.json`);
  timer = setInterval(() => {
    let answer;
    try { answer = JSON.parse(fs.readFileSync(answerFile, "utf8")); } catch { return; }
    finish(answer.error ? Object.assign(new Error(answer.error), { code: answer.code ?? 1 }) : null, answer.stdout ?? "", answer.stderr ?? "");
  }, 20);
  options?.signal?.addEventListener("abort", () => {
    fs.writeFileSync(path.join(dir, `aborted-${n}`), "");
    finish(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
  }, { once: true });
  return {};
}

cp.execFile = fakeExecFile;
syncBuiltinESMExports();
const { execFile } = await import("node:child_process");
if (execFile !== fakeExecFile) {
  process.stderr.write("fake-osascript: node:child_process.execFile was not replaced; refusing to start the server\n");
  process.exit(70);
}
