import { Brain, Zap } from "lucide-react";

export const EMPTY_MODEL = {
  id: "",
  providerId: "",
  providerName: "未配置 Provider",
  source: "user-provider",
  billing: "user-provider",
  name: "未配置模型",
  shortName: "未配置",
  description: "请先添加模型 API",
  descriptionZh: "请先添加模型 API",
  descriptionEn: "Add a model API to begin",
  supportsImages: false,
  supportsThinking: false,
  supportsTools: false,
  icon: Brain,
};

export const DEFAULT_TASK_OPTIONS = {
  thinking: true,
  effort: "high",
  permission: "workspace-write",
  approvalMode: "sandbox-auto",
  executionMode: "safe",
};

const MODEL_SOURCE_GROUPS = [
  {
    source: "aporia-cloud",
    titleZh: "Aporia Cloud",
    titleEn: "Aporia Cloud",
    noteZh: "由 AporiaX 提供 · 使用每周额度",
    noteEn: "Provided by AporiaX · Uses weekly quota",
  },
  {
    source: "user-provider",
    titleZh: "你的 Provider",
    titleEn: "Your Providers",
    noteZh: "使用你自己的 API Key 与余额",
    noteEn: "Uses your own API key and provider balance",
  },
  {
    source: "local",
    titleZh: "本地模型",
    titleEn: "Local",
    noteZh: "使用这台电脑上的本地 Endpoint",
    noteEn: "Uses a local endpoint on this computer",
  },
];

function providerSource(provider) {
  if (provider?.source === "aporia-cloud" || provider?.kind === "aporia-cloud") {
    return "aporia-cloud";
  }
  if (provider?.source === "local" || provider?.vendor === "local") return "local";
  return "user-provider";
}

function modelDescription(provider, source, language) {
  if (source === "aporia-cloud") {
    return language === "zh"
      ? "Aporia Cloud · 每周额度"
      : "Aporia Cloud · Weekly quota";
  }
  if (source === "local") {
    return language === "zh"
      ? `${provider.name} · 本地`
      : `${provider.name} · Local`;
  }
  return language === "zh"
    ? `${provider.name} · 你的 API`
    : `${provider.name} · Your API`;
}

export function getAvailableModels(providers) {
  return (providers || []).flatMap((provider) => {
    const source = providerSource(provider);
    const billing = provider.billing || (
      source === "aporia-cloud"
        ? "weekly-quota"
        : source === "local"
          ? "none"
          : "user-provider"
    );
    return (provider.models || []).map((model) => ({
      ...model,
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      source,
      billing,
      managed: Boolean(provider.managed),
      description: modelDescription(provider, source, "zh"),
      descriptionZh: modelDescription(provider, source, "zh"),
      descriptionEn: modelDescription(provider, source, "en"),
      icon: model.supportsThinking ? Brain : Zap,
    }));
  });
}

export function getModelGroups(providers) {
  const models = getAvailableModels(providers);
  return MODEL_SOURCE_GROUPS
    .map((group) => ({
      ...group,
      models: models.filter((model) => model.source === group.source),
    }))
    .filter((group) => group.models.length > 0);
}

export function getModel(providers, providerId, modelId) {
  const models = getAvailableModels(providers);
  return (
    models.find(
      (model) =>
        model.providerId === providerId && model.id === modelId,
    ) ||
    models.find((model) => model.id === modelId) ||
    models[0] ||
    EMPTY_MODEL
  );
}

export function getDefaultTaskConfig(providers) {
  const model = getAvailableModels(providers)[0] || EMPTY_MODEL;
  return {
    ...DEFAULT_TASK_OPTIONS,
    thinking: Boolean(model.supportsThinking),
    providerId: model.providerId || "",
    modelId: model.id || "",
  };
}
