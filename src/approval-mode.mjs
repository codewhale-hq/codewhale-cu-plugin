import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./registry.mjs";

let cached = { at: 0, dir: null, mode: "standard" };

export function approvalMode() {
  if (process.platform !== "darwin") return "strict";
  if (String(process.env.CODEWHALE_CU_APPROVAL ?? "").trim().toLowerCase() === "strict") return "strict";
  const dir = stateDir();
  const now = Date.now();
  if (cached.dir === dir && now - cached.at < 1_000) return cached.mode;
  let mode = "standard";
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "approval.json"), "utf8"));
    if (saved?.mode !== "standard") mode = "strict";
  } catch (error) {
    if (error?.code !== "ENOENT") mode = "strict";
  }
  cached = { at: now, dir, mode };
  return mode;
}

export const isStrict = () => approvalMode() === "strict";
export const strictFor = (computer) => isStrict() || computer?.transport !== "local";

export const unnamedAppCode = () => (isStrict() ? "consent_required" : "app_not_identified");
