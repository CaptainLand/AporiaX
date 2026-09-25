// Only public account/catalog data. Authentication is not model entitlement.
const quotaManagedByGateway = (account, model) => ["affordable-output-v1", "actual-usage-v1"].includes(account.gatewayCapabilities?.modelGateway?.quotaAdmission) &&
  ["QUOTA_UNAVAILABLE", "CREDITS_UNAVAILABLE"].includes(model?.reason);
export function cloudModelAvailability(account, modelId) {
  const unavailable = (reason) => ({ available: false, reason });
  if (account?.status !== "authenticated") return unavailable("SIGN_IN_REQUIRED");
  if (!Array.isArray(account.models)) return unavailable("MODEL_CATALOG_UNVERIFIED");
  const catalog = account.models.find((m) => (m.slug || m.id) === modelId);
  if (!catalog || catalog.enabled === false || catalog.disabled === true) return unavailable("MODEL_NOT_AVAILABLE");
  if (account.gatewayStatus === "unavailable") return unavailable("MODEL_SERVICE_UNVERIFIED");
  if (account.gatewayCapabilities?.protocolVersion === 1) {
    const match = account.gatewayCapabilities.models?.find((m) => (m.slug || m.id) === modelId);
    if (!match || (match.available !== true && !quotaManagedByGateway(account, match))) return unavailable(match?.reason || "MODEL_NOT_AVAILABLE");
    return { available: true, verification: "configuration-not-live-health" };
  }
  // A legacy server has a confirmed catalog, but cannot prove live configuration.
  if (catalog.freeTierAllowed !== false) {
    if (account.quota?.freeTierEligible === false) return unavailable("FREE_TIER_NOT_ELIGIBLE");
    const remaining = account.quota?.availableRatio ?? account.quota?.remainingRatio;
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
  FREE_TIER_NOT_ELIGIBLE: ["当前账号不具备免费额度资格", "Account is not eligible for free quota"],
  DEVICE_SESSION_REQUIRED: ["需要重新进行桌面登录", "Desktop device sign-in is required"],
  USAGE_RECONCILIATION_REQUIRED: ["存在待核算用量，请联系服务方", "Usage reconciliation is required"],
  PRICING_REVIEW_REQUIRED: ["服务端价格配置需要复核", "Server pricing review required"],
};
export function projectCloudProvider(provider, account) {
  if (!(provider.id === "aporia-cloud" || provider.source === "aporia-cloud" || provider.kind === "aporia-cloud")) return provider;
  const models = (provider.models || []).map(model => {
    const state = cloudModelAvailability(account, model.id);
    const text = descriptions[state.reason] || descriptions.MODEL_SERVICE_UNVERIFIED;
    return { ...model, disabled: Boolean(model.disabled || !state.available), availability: state.verification,
      disabledReasonZh: state.available ? model.disabledReasonZh : text[0],
      disabledReasonEn: state.available ? model.disabledReasonEn : text[1] };
  });
  return { ...provider, accountStatus: account?.status, cloudCatalogVerified: Array.isArray(account?.models), models };
}
