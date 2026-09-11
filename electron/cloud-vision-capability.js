// A configured gateway is not proof that an upstream request will succeed.
export async function queryCloudVisionCapability(fetchGateway, { timeoutMs = 3500, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ status: "unknown", reason: "CAPABILITY_TIMEOUT" }); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      try {
        const response = await fetchGateway("/v1/capabilities/vision", { method: "GET", signal: controller.signal });
        if (!response.ok) return { status: response.status === 401 || response.status === 403 ? "unavailable" : "unknown", reason: response.status === 404 ? "CAPABILITY_UNSUPPORTED" : `HTTP_${response.status}` };
        const data = await response.json();
        if (data?.status !== "ready" || data?.verification !== "configuration" || data?.model?.id !== "aporia-cloud-vision" || data?.model?.supportsImages !== true) {
          return { status: data?.status === "unavailable" ? "unavailable" : "unknown", reason: "VISION_NOT_READY" };
        }
        return { status: "ready", verification: "configuration", model: { id: data.model.id, name: String(data.model.name || "Aporia Cloud Vision").slice(0, 120), supportsImages: true } };
      } catch { return { status: "unknown", reason: "CAPABILITY_UNAVAILABLE" }; }
    })()]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
