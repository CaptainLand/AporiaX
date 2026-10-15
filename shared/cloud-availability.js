// Only public account/catalog data. Authentication is not model entitlement.
const quotaManagedByGateway = (account, model) => ["affordable-output-v1", "actual-usage-v1"].includes(account.gatewayCapabilities?.modelGateway?.quotaAdmission) &&
  ["QUOTA_UNAVAILABLE", "CREDITS_UNAVAILABLE"].includes(model?.reason);
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
function exhausted(quota) {
  // Never confuse holds, rounded UI percentages, or absent data with actual
  // consumption. Exact settled balances take precedence over summary flags.
  if (finiteNumber(quota?.remainingMicros)) return quota.remainingMicros <= 0;
  if (finiteNumber(quota?.remainingRatio)) return quota.remainingRatio <= 0;
  return quota?.exhausted === true;
}
function selectionQuotaReason(account, catalog, model) {
  const quota = model?.quota;
  const source = quota?.source || (catalog.freeTierAllowed === false ? "credits" : "weekly");
  if (exhausted(quota) || (source === "weekly" && exhausted(account.quota)))
    return source === "credits" ? "CREDITS_EXHAUSTED" : "WEEKLY_QUOTA_EXHAUSTED";
  const daily = quota?.dailyBudget;
  const now = Date.now(), sampledAt = Date.parse(daily?.sampledAt), resetsAt = Date.parse(daily?.resetsAt);
  if (daily?.policy === "provider-daily-v1" && finiteNumber(daily.remainingMicros) && daily.remainingMicros <= 0 &&
      Number.isFinite(sampledAt) && sampledAt <= now + 30000 && now - sampledAt <= 90000 && resetsAt > now)
    return "DAILY_QUOTA_EXHAUSTED";
  return null;
}

export function cloudModelAvailability(account, modelId, { forSelection = false } = {}) {
  const unavailable = (reason) => ({ available: false, reason });
  if (account?.status !== "authenticated") return unavailable("SIGN_IN_REQUIRED");
  if (!Array.isArray(account.models)) return unavailable("MODEL_CATALOG_UNVERIFIED");
  const catalog = account.models.find((m) => (m.slug || m.id) === modelId);
  if (!catalog || catalog.enabled === false || catalog.disabled === true) return unavailable("MODEL_NOT_AVAILABLE");
  if (account.gatewayStatus === "unavailable") return unavailable("MODEL_SERVICE_UNVERIFIED");
  if (account.gatewayCapabilities?.protocolVersion === 1) {
    const match = account.gatewayCapabilities.models?.find((m) => (m.slug || m.id) === modelId);
    if (!match || (match.available !== true && !quotaManagedByGateway(account, match))) return unavailable(match?.reason || "MODEL_NOT_AVAILABLE");
    const quotaReason = forSelection ? selectionQuotaReason(account, catalog, match) : null;
    if (quotaReason) return unavailable(quotaReason);
    if (forSelection && ["QUOTA_UNAVAILABLE", "CREDITS_UNAVAILABLE"].includes(match.reason) && !match.quota)
      return unavailable(match.reason); // Old gateways may supply only an explicit denial.
    return { available: true, verification: "configuration-not-live-health" };
  }
  // A legacy server has a confirmed catalog, but cannot prove live configuration.
  if (catalog.freeTierAllowed !== false) {
    if (account.quota?.freeTierEligible === false) return unavailable("FREE_TIER_NOT_ELIGIBLE");
    if (forSelection && exhausted(account.quota)) return unavailable("WEEKLY_QUOTA_EXHAUSTED");
    const remaining = forSelection ? account.quota?.remainingRatio ?? account.quota?.availableRatio
      : account.quota?.availableRatio ?? account.quota?.remainingRatio;
    if (typeof remaining === "number" && remaining <= 0) return unavailable("QUOTA_UNAVAILABLE");
  }
  return { available: true, verification: "legacy-catalog-only" };
}
// Managed vision is native Flash input, not a separate hidden Qwen route.
export function cloudVisionAvailability(account) {
  const availability = cloudModelAvailability(account, "aporia-cloud-default");
  if (!availability.available) return availability;
  const unavailable = (reason) => ({ available: false, reason });
  if (account?.status !== "authenticated") return unavailable("SIGN_IN_REQUIRED");
  if (account.gatewayStatus === "unavailable" || account.gatewayCapabilities?.protocolVersion !== 1)
    return unavailable("MODEL_SERVICE_UNVERIFIED");
  const model = account.gatewayCapabilities.models?.find((m) => (m.slug || m.id) === "aporia-cloud-default");
  if (!model || (model.available !== true && !quotaManagedByGateway(account, model)) || model.supportsImages !== true)
    return unavailable(model?.reason || "MODEL_NOT_AVAILABLE");
  return { available: true, verification: "configuration-not-live-health" };
}
const descriptions = {
  SIGN_IN_REQUIRED: ["登录 Aporia Cloud 后可用", "Sign in to Aporia Cloud"],
  MODEL_NOT_AVAILABLE: ["服务端未启用此模型", "Model is not enabled by the server"],
  MODEL_DISABLED: ["服务端已停用此模型", "Model disabled by server"],
  MODEL_CATALOG_UNVERIFIED: ["尚未取得服务端模型列表", "Server model catalog is unverified"],
  MODEL_SERVICE_UNVERIFIED: ["无法确认模型网关状态，请刷新账号", "Gateway status unavailable; refresh account"],
  PROVIDER_NOT_CONFIGURED: ["服务端尚未配置此模型", "Provider is not configured"],
  QUOTA_UNAVAILABLE: ["额度已用完或正在被其他请求预留", "Quota exhausted or reserved by other requests"],
  CREDITS_UNAVAILABLE: ["可用余额不足", "Insufficient available credits"],
  WEEKLY_QUOTA_EXHAUSTED: ["Cloud 周额度已用完，恢复后可选；也可使用自己的 API", "Cloud weekly quota exhausted; wait for a refill or use your own API"],
  CREDITS_EXHAUSTED: ["Cloud 余额已用完，补充后可选", "Cloud credits exhausted; refill to select this model"],
  DAILY_QUOTA_EXHAUSTED: ["全站今日 Cloud 额度已用完，重置后可选", "Shared daily Cloud quota exhausted; available after reset"],
  FREE_TIER_NOT_ELIGIBLE: ["当前账号不具备免费额度资格", "Account is not eligible for free quota"],
  DEVICE_SESSION_REQUIRED: ["需要重新进行桌面登录", "Desktop device sign-in is required"],
  USAGE_RECONCILIATION_REQUIRED: ["存在待核算用量，请联系服务方", "Usage reconciliation is required"],
  PRICING_REVIEW_REQUIRED: ["服务端价格配置需要复核", "Server pricing review required"],
};
export function projectCloudProvider(provider, account) {
  if (!(provider.id === "aporia-cloud" || provider.source === "aporia-cloud" || provider.kind === "aporia-cloud")) return provider;
  const models = (provider.models || []).map(model => {
    // Selection is stricter than dispatch. Existing runs must still reach the
    // gateway's settled receipt / durable quota-pause path, not a generic error.
    const state = cloudModelAvailability(account, model.id, { forSelection: true });
    const text = descriptions[state.reason] || descriptions.MODEL_SERVICE_UNVERIFIED;
    return { ...model, disabled: Boolean(model.disabled || !state.available), availability: state.verification,
      disabledReasonZh: state.available ? model.disabledReasonZh : text[0],
      disabledReasonEn: state.available ? model.disabledReasonEn : text[1] };
  });
  return { ...provider, accountStatus: account?.status, cloudCatalogVerified: Array.isArray(account?.models), models };
}
