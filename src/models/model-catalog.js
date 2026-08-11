import { Brain, Zap } from "lucide-react";

export const EMPTY_MODEL = {
  id: "",
  providerId: "",
  providerName: "未配置 Provider",
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

export function getAvailableModels(providers) {
  return (providers || []).flatMap((provider) =>
    (provider.models || []).map((model) => ({
      ...model,
      providerId: provider.id,
      providerName: provider.name,
      description: [
        provider.name,
        model.supportsImages ? "支持图片" : "仅文本",
        model.supportsTools === false ? "不支持工具" : "支持工具",
      ].join(" · "),
      descriptionZh: [
        provider.name,
        model.supportsImages ? "支持图片" : "仅文本",
        model.supportsTools === false ? "不支持工具" : "支持工具",
      ].join(" · "),
      descriptionEn: [
        provider.name,
        model.supportsImages ? "Vision" : "Text only",
        model.supportsTools === false ? "No tools" : "Tool use",
      ].join(" · "),
      icon: model.supportsThinking ? Brain : Zap,
    })),
  );
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
