// Shared by provider storage, renderer configuration and request routing.
export const DEFAULT_IMAGE_INPUT = "native";
const IMAGE_PART_TYPES = new Set(["image_url", "input_image", "image"]);

export function modelSupportsVision(model = {}) {
  if (model.imageInput === "native") return true;
  if (model.imageInput === "text") return false;
  if (typeof model.reportedSupportsImages === "boolean") return model.reportedSupportsImages;
  if (typeof model.nativeSupportsImages === "boolean") return model.nativeSupportsImages;
  if (model.supportsImageProxy === true) return false;
  if (typeof model.supportsImages === "boolean") return model.supportsImages;
  const id = String(model.id || model.name || "");
  return /(?:^|[-_/])(gpt-4o|gpt-4\.1|gpt-5|vision|vl|gemini|claude)(?:[-_/.:]|$)/i.test(id) ||
    /qwen.*vl|llava|pixtral|internvl|vision/i.test(id) ||
    /(?:^|[-_/])qwen3\.(?:5|6|7)(?:[-_/.:]|$)/i.test(id);
}

export function normalizeImageCapability(source = {}) {
  const imageInput = source.imageInput === "text" ? "text" : DEFAULT_IMAGE_INPUT;
  const modalities = source.input_modalities || source.architecture?.input_modalities;
  const reportedSupportsImages = typeof source.reportedSupportsImages === "boolean"
    ? source.reportedSupportsImages
    : Array.isArray(modalities) ? modalities.includes("image")
      : typeof source.capabilities?.vision === "boolean" ? source.capabilities.vision
        : !source.imageInput && typeof source.supportsImages === "boolean" && source.supportsImageProxy !== true
          ? source.supportsImages : undefined;
  const normalized = { imageInput, ...(typeof reportedSupportsImages === "boolean" ? { reportedSupportsImages } : {}) };
  return { ...normalized, supportsImages: modelSupportsVision({ id: source.id, ...normalized }) };
}

export function conversationContainsImages(messages = []) {
  return (Array.isArray(messages) ? messages : []).some((message) =>
    Array.isArray(message?.content) &&
    message.content.some((part) => IMAGE_PART_TYPES.has(part?.type)),
  );
}

export function isNativeVisionRejectedError(error) {
  const text = String(error?.message || error?.code || error || "");
  if (!text.trim()) return false;
  const mentionsImage =
    /image_url|input_image|\bimages?\b|visual content|multimodal|图片|识图|视觉输入/i.test(
      text,
    );
  const rejected =
    /not support|unsupported|unknown variant|invalid|expected [`']text[`']|不支持/i.test(
      text,
    );
  return mentionsImage && rejected;
}

export function stripImagePartsFromMessages(messages = []) {
  const notice =
    "[系统提示：当前模型不支持读取图片，已从请求中省略图片附件。]";
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const hadImage = message.content.some((part) =>
      IMAGE_PART_TYPES.has(part?.type),
    );
    if (!hadImage) return message;
    const text = message.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
    return {
      ...message,
      content: text ? `${text}\n\n${notice}` : notice,
    };
  });
}
