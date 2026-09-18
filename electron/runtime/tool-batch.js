// A batch is a contiguous read pool OR an exclusive barrier. Never move reads
// across writes/session controls/unknown tools, even if they target another path.
export function planToolBatches(calls, canParallel) {
  if (!Array.isArray(calls) || typeof canParallel !== "function") throw new TypeError("Invalid tool batch plan.");
  const batches = [];
  for (const call of calls) {
    const read = canParallel(call) === true;
    if (read && batches.at(-1)?.readPool) batches.at(-1).calls.push(call);
    else batches.push({ readPool: read, calls: [call] });
  }
  return batches.map(({ readPool, calls }) => ({ calls, parallel: readPool && calls.length > 1 }));
}

// Stop admitting work on error/cancellation, but join every started worker
// before returning. Promise.all's early rejection must not let the next phase
// race with an in-flight tool. Results retain model-declared ordering.
export async function executeToolBatch(items, limit, worker, { signal } = {}) {
  if (!Array.isArray(items) || typeof worker !== "function") throw new TypeError("Invalid tool batch.");
  const count = Math.max(1, Math.min(32, Math.floor(Number(limit) || 1)));
  const results = new Array(items.length);
  let next = 0, failure;
  const cancelled = () => Object.assign(new Error("Tool batch interrupted."), { name: "AbortError" });
  const runners = Array.from({ length: Math.min(count, items.length) }, async () => {
    while (!failure && next < items.length) {
      if (signal?.aborted) { failure ||= cancelled(); break; }
      const index = next++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { failure ||= error; }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
  if (signal?.aborted) throw cancelled();
  return results;
}
