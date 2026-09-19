import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { getVerifiedWorkspaceRoot, verifyExistingTarget } from "./workspace-runtime.js";

const MAX_FILE = 8 * 1024 * 1024;
const sha = (value) => createHash("sha256").update(value).digest("hex");
export { normalizeTaskContract } from "./task-contract-schema.js";
import { normalizeTaskContract } from "./task-contract-schema.js";

export async function loadTaskContract(workspaceRoot, supplied, { canRead = true } = {}) {
  if (supplied !== undefined) return normalizeTaskContract(supplied);
  if (!workspaceRoot || !canRead) return null;
  try {
    return normalizeTaskContract(JSON.parse((await readBounded(workspaceRoot, ".aporiax/acceptance.json", 64_000)).toString("utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`ACCEPTANCE_CONFIG_INVALID: ${error.message}`, { cause: error });
  }
}

async function readBounded(root, name, limit = MAX_FILE) {
  // Resolve directory aliases (including Windows 8.3 paths) before applying
  // the existing real-path containment guard. Never relax the target guard.
  root = await getVerifiedWorkspaceRoot(root);
  const target = await verifyExistingTarget(root, name);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("ACCEPTANCE_UNSUPPORTED_FILE");
  const handle = await open(target, "r");
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("ACCEPTANCE_FILE_CHANGED_DURING_READ");
    const buffer = Buffer.alloc(Math.min(limit + 1, opened.size + 1));
    let total = 0;
    while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
    const after = await handle.stat(), current = await lstat(target);
    // Compare each timestamp with the same stat API. Windows path-stat and
    // handle-stat may expose different timestamp precision for the same file.
    // Both views must stay unchanged, and the opened inode must remain at the
    // authorized path. This still rejects writes between either observation.
    const unchanged = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (total !== opened.size || !unchanged(opened, after) || !unchanged(stat, current) ||
        current.ino !== opened.ino || current.dev !== opened.dev || !current.isFile() || current.isSymbolicLink())
      throw new Error("ACCEPTANCE_FILE_CHANGED_DURING_READ");
    if (await verifyExistingTarget(root, name) !== target) throw new Error("ACCEPTANCE_FILE_CHANGED_DURING_READ");
    bytes = buffer.subarray(0, total);
  } finally { await handle.close(); }
  return bytes;
}

/** Trusted caller/project contract is captured once. Model text cannot edit it.
 * Checks only read bounded workspace files or use actual run_command receipts.
 * No shell command is launched by this evaluator; normal approval still applies.
 */
export class TaskAcceptance {
  #contract;
  #root;
  #canRead;
  #receipts = new Map();
  #continuations = 0;
  #budget;
  #report = null;
  constructor(contract, { workspaceRoot, canRead = true, continuationBudget = 1 } = {}) {
    this.#contract = normalizeTaskContract(contract); this.#root = workspaceRoot; this.#canRead = canRead;
    if (!Number.isInteger(continuationBudget) || continuationBudget < 0 || continuationBudget > 3) throw new Error("ACCEPTANCE_CONTINUATION_BUDGET_INVALID");
    this.#budget = continuationBudget;
  }
  get enabled() { return Boolean(this.#contract); }
  contract() { return this.#contract && structuredClone(this.#contract); }
  briefing() {
    return this.#contract ? { ...this.contract(), note: "Configured checks are immutable in this invocation. Passing these predicates is not proof that unspecified requirements were discovered. Commands must use normal tools/approval; inputs declare the files they validate." } : null;
  }
  async #snapshot(inputs) {
    if (!this.#root || !this.#canRead) throw new Error("ACCEPTANCE_READ_UNAVAILABLE");
    const values = [];
    for (const name of inputs) {
      try { values.push([name, sha(await readBounded(this.#root, name))]); }
      catch (error) { if (error.code === "ENOENT") values.push([name, null]); else throw error; }
    }
    return sha(JSON.stringify(values));
  }
  async beforeTool(tool, input) {
    if (tool !== "run_command" || !this.#contract) return [];
    const found = [];
    for (const req of this.#contract.requirements) for (const [index, check] of req.checks.entries()) {
      if (check.type !== "command_exit" || check.command !== String(input.command || "").trim() || check.cwd !== (input.cwd || ".").replaceAll("\\", "/")) continue;
      try { found.push({ key: `${req.id}:${index}`, before: await this.#snapshot(check.inputs) }); }
      catch (error) { found.push({ key: `${req.id}:${index}`, error: error.message }); }
    }
    return found;
  }
  async afterTool(prepared, result, callId) {
    for (const item of prepared || []) {
      const [id, index] = item.key.split(":"), check = this.#contract.requirements.find((req) => req.id === id).checks[Number(index)];
      let after;
      try { after = await this.#snapshot(check.inputs); } catch { after = null; }
      const passed = !item.error && item.before === after && result?.exitCode === 0 && !result.error && !result.timedOut && !result.skipped;
      this.#receipts.set(item.key, { passed, inputHash: after, callId, exitCode: result?.exitCode ?? null,
        error: item.error || (item.before !== after ? "Inputs changed during command; run the check against current inputs." : result?.error || null) });
    }
  }
  invalidate() { this.#receipts.clear(); this.#continuations = 0; this.#report = null; }
  async evaluate({ signal } = {}) {
    if (!this.#contract) return null;
    const rows = [];
    for (const req of this.#contract.requirements) {
      signal?.throwIfAborted();
      const checks = [];
      for (const [index, check] of req.checks.entries()) {
        signal?.throwIfAborted();
        try {
          if (check.type === "command_exit") {
            const receipt = this.#receipts.get(`${req.id}:${index}`);
            const current = await this.#snapshot(check.inputs);
            const passed = receipt?.passed === true && receipt.inputHash === current;
            checks.push({ type: check.type, passed, status: passed ? "passed" : receipt ? "failed-or-stale" : "not-run", receipt: receipt || null });
          } else {
            if (!this.#root || !this.#canRead) throw new Error("ACCEPTANCE_READ_UNAVAILABLE");
            const bytes = await readBounded(this.#root, check.path);
            let passed = check.type === "file_exists";
            if (!passed) {
              if (!isUtf8(bytes)) throw new Error("ACCEPTANCE_NON_UTF8");
              if (check.type === "file_contains") passed = bytes.toString("utf8").includes(check.text);
              else {
                let value = JSON.parse(bytes.toString("utf8"));
                for (const key of check.keys) value = value && Object.hasOwn(value, key) ? value[key] : undefined;
                passed = isDeepStrictEqual(value, check.equals);
              }
            }
            checks.push({ type: check.type, path: check.path, passed, sha256: sha(bytes), status: passed ? "passed" : "failed" });
          }
        } catch (error) { checks.push({ type: check.type, passed: false, status: "unavailable", error: error.message }); }
      }
      rows.push({ id: req.id, text: req.text, status: checks.length && checks.every((item) => item.passed) ? "passed" : checks.length ? "not-satisfied" : "needs-human-review", checks });
    }
    this.#report = { version: 1, contractHash: sha(JSON.stringify(this.#contract)), checkedAt: new Date().toISOString(),
      passed: rows.every((row) => row.status === "passed"), requirements: rows,
      scope: "Only configured predicates; semantic completeness outside this contract is not certified." };
    return structuredClone(this.#report);
  }
  decide(status, report) {
    if (!report || !this.#contract.enforce || status !== "completed" || report.passed) return { action: "deliver", status };
    const reason = `Configured acceptance not satisfied: ${report.requirements.filter((row) => row.status !== "passed").map((row) => `${row.id} (${row.status})`).join(", ")}. Use existing permitted tools for targeted checks; do not alter the contract or claim unobserved success.`;
    if (this.#continuations++ < this.#budget) return { action: "continue", reason };
    return { action: "deliver", status: "partial", reason: reason + " Changes are retained; acceptance continuation budget exhausted." };
  }
  snapshot() { return { contract: this.contract(), report: this.#report && structuredClone(this.#report) }; }
}
