// Runtime options are supplied by the client, not inferred from a model's claim.
// No shell hooks or new permission grants. Default remains agent-led delivery.
export function normalizeLoopPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("loopPolicy must be an object.");
  const integer = (key, fallback, min, max) => {
    const number = value[key] ?? fallback;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new TypeError(`Invalid loopPolicy.${key}.`);
    return number;
  };
  if (value.requireVerifiedChanges !== undefined && typeof value.requireVerifiedChanges !== "boolean")
    throw new TypeError("loopPolicy.requireVerifiedChanges must be boolean.");
  return Object.freeze({ requireVerifiedChanges: value.requireVerifiedChanges === true,
    maxCompletionContinuations: integer("maxCompletionContinuations", 1, 0, 3),
    maxRepeatedEvidence: integer("maxRepeatedEvidence", 0, 0, 64) });
}

export class CompletionPolicy {
  #policy;
  #continuations = 0;
  constructor(policy = {}) { this.#policy = normalizeLoopPolicy(policy); }
  reset() { this.#continuations = 0; }
  evaluate({ status = "completed", changes = [], assessment }) {
    if (status !== "completed" || !this.#policy.requireVerifiedChanges || !changes.length ||
        assessment?.waived || (assessment?.passed && !assessment.reviewPending && !assessment.findings?.length))
      return { action: "deliver", status };
    const reason = "The caller requested verified changes, but current-version evidence is incomplete or failed. Use existing permitted tools for the relevant checks, or explicitly report partial/blocked work. Do not manufacture verification or repeat an uncertain side effect.";
    if (this.#continuations < this.#policy.maxCompletionContinuations) {
      this.#continuations++;
      return { action: "continue", reason, continuation: this.#continuations };
    }
    return { action: "deliver", status: "partial", reason: "Verification policy was not satisfied within the continuation budget; changes are preserved as partial work." };
  }
}
