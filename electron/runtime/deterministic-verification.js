// No provider/model dependency. The supplied executor MUST use the normal
// authorization, sandbox and durable-operation boundary.
export async function runDeterministicVerification(candidates, execute) {
  if (typeof execute !== "function") throw new Error("Verification executor is unavailable.");
  const evidence = [];
  for (const candidate of candidates) {
    const value = await execute(candidate);
    evidence.push({ tool: "run_command", command: candidate.command, cwd: candidate.cwd || ".", ...value });
  }
  const passed = evidence.length > 0 && evidence.every((item) => item.exitCode === 0 && !item.error && !item.timedOut);
  return { status: "completed", evidence, summary: JSON.stringify({ verdict: passed ? "pass" : "fail", checks: evidence.map((item) => item.command), commands: [], remaining_risks: [] }) };
}
