export function providerModelsById(models = []) {
  return Object.fromEntries(models.map((model) => {
    // Never persist effective proxy support as native model capability.
    const { visionProxy, supportsImageProxy, nativeSupportsImages, ...config } = model;
    if (supportsImageProxy) config.supportsImages = false;
    return [model.id, config];
  }));
}
export function buildProviderModels(ids, records = {}) {
  return [...new Set(ids)].map((id) => ({ ...records[id], id }));
}
