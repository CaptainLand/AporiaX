import { cloudVisionAvailability } from "../shared/cloud-availability.js";

const reasons = {
  QUOTA_UNAVAILABLE: "Cloud 周额度暂不可用，请刷新额度或等待恢复；不是图片格式问题。",
  CREDITS_UNAVAILABLE: "Cloud 可用余额不足，请先检查账户额度。",
  DEVICE_SESSION_REQUIRED: "需要重新登录桌面端，才能使用 Cloud 模型和图片。",
  FREE_TIER_NOT_ELIGIBLE: "当前账号不具备免费 Cloud 额度资格。",
  USAGE_RECONCILIATION_REQUIRED: "Cloud 存在待核算用量，请稍后重试或联系服务方。",
  PRICING_REVIEW_REQUIRED: "Cloud 服务端价格配置需要复核，请联系服务方。",
  PROVIDER_NOT_CONFIGURED: "Cloud 服务端尚未配置模型，请联系服务方。",
  MODEL_DISABLED: "Cloud 服务端已停用此模型。",
  MODEL_NOT_AVAILABLE: "Cloud 服务端未提供此图片模型。",
  HTTP_401: "Cloud 登录已失效，请重新登录桌面端。",
  HTTP_403: "当前 Cloud 账号或设备没有访问权限。",
  HTTP_426: "Cloud 要求更新桌面端，请检查更新后重试。",
  CAPABILITY_TIMEOUT: "确认 Cloud 图片能力超时，请检查网络后重试；尚未发送图片。",
  CAPABILITY_UNSUPPORTED: "Cloud 服务尚未提供兼容的图片能力接口，请联系服务方更新。",
  CAPABILITY_UNAVAILABLE: "暂时无法连接 Cloud 图片能力接口，请检查网络后重试；尚未发送图片。",
  VISION_NOT_READY: "Cloud 尚未确认此模型支持图片，请刷新账户或联系服务方。",
};
const safeReason = (value, fallback = "VISION_NOT_READY") => Object.hasOwn(reasons, value) ? value : fallback;
const ready = (model) => ({ status: "ready", verification: "configuration",
  model: { id: model.id, name: String(model.name || "DeepSeek V4.1 Flash").slice(0, 120), supportsImages: true } });

export function cloudVisionCapabilityError(capability) {
  const reason = safeReason(capability?.reason);
  return Object.assign(new Error(`APORIA_CLOUD_VISION_NOT_READY (${reason}): ${reasons[reason]}`),
    { code: "APORIA_CLOUD_VISION_NOT_READY", reason, retryable: false });
}

// A configured gateway is not proof that an upstream request will succeed.
// This GET never transmits image contents. The actual gateway still owns quota,
// device authorization and billing admission, identically to text requests.
export async function queryCloudVisionCapability(fetchGateway, { timeoutMs = 8000, signal } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let cancel;
  const cancelled = new Promise((_, reject) => { cancel = reject; });
  const abort = () => { controller.abort(); cancel(signal.reason || new DOMException("Aborted", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ status: "unknown", reason: "CAPABILITY_TIMEOUT" }); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, cancelled, (async () => {
      try {
        const response = await fetchGateway("/v1/capabilities/vision", { method: "GET", signal: controller.signal });
        const data = response.ok ? await response.json() : null;
        // Compatibility with older gateways that conflated native image support
        // with current quota, or only implement the verified general endpoint.
        if (response.status === 404 || (data?.status === "unavailable" &&
            ["QUOTA_UNAVAILABLE", "CREDITS_UNAVAILABLE"].includes(data.reason))) {
          if (!response.ok) await response.body?.cancel();
          const general = await fetchGateway("/v1/capabilities", { method: "GET", signal: controller.signal });
          if (general.ok) {
            const capabilities = await general.json();
            const model = capabilities?.models?.find?.((item) => item.id === "aporia-cloud-default");
            if (capabilities?.protocolVersion === 1 && capabilities.status === "ready" &&
                capabilities.verification === "configuration" && model && model.enabled !== false &&
                cloudVisionAvailability({ status: "authenticated", models: [model], gatewayStatus: "verified",
                  gatewayCapabilities: capabilities }).available) return ready(model);
            return { status: "unavailable", reason: safeReason(model?.reason) };
          }
          await general.body?.cancel();
          return { status: "unknown", reason: safeReason(`HTTP_${general.status}`, "CAPABILITY_UNSUPPORTED") };
        }
        if (!response.ok) {
          await response.body?.cancel();
          return { status: [401, 403, 426].includes(response.status) ? "unavailable" : "unknown",
            reason: safeReason(`HTTP_${response.status}`, "CAPABILITY_UNAVAILABLE") };
        }
        if (data?.status !== "ready" || data?.verification !== "configuration" || data?.model?.id !== "aporia-cloud-default" || data?.model?.supportsImages !== true) {
          return { status: data?.status === "unavailable" ? "unavailable" : "unknown", reason: safeReason(data?.reason) };
        }
        return ready(data.model);
      } catch { return { status: "unknown", reason: "CAPABILITY_UNAVAILABLE" }; }
    })()]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
