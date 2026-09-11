// Cancels only inference, never the run signal or an in-flight tool.
export async function completeWithSteering({ provider, control, signal, body, onEvent }) {
  const controller = new AbortController();
  let interrupted = false;
  let content = "";
  const abort = () => controller.abort(signal?.reason);
  const steer = () => { interrupted = true; controller.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  const unsubscribe = control?.onSteering?.(steer);
  if (signal?.aborted) abort();
  if (control?.hasSteering?.()) steer();
  try {
    const result = await provider.complete({ body, signal: controller.signal,
      onStreamEvent: (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "response.retry") content = "";
        if (event.type === "response.delta") content += String(event.delta || "");
        onEvent?.(event);
      },
    });
    if (signal?.aborted) throw Object.assign(new Error("Task stopped"), { name: "AbortError" });
    return { ...result, interrupted: interrupted || Boolean(control?.hasSteering?.()) };
  } catch (error) {
    if (!interrupted || signal?.aborted) throw error;
    return { interrupted: true, message: { role: "assistant", content }, usage: error?.usage || null };
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe?.();
  }
}
