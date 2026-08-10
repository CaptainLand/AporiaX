const KNOWN_VISION_MODEL_PATTERNS = [
  /(?:^|[-_/])(gpt-4o|gpt-4\.1|gpt-5|vision|vl|gemini|claude)(?:[-_/.:]|$)/i,
  /qwen.*vl|llava|pixtral|internvl|vision/i,
  /(?:^|[-_/])qwen3\.(?:5|6|7)(?:[-_/.:]|$)/i,
];

const MAX_VISION_IMAGES_PER_MESSAGE = 8;
const MAX_VISION_DATA_URL_CHARS = 28_000_000;

export function modelSupportsVision(model = {}) {
  const id = String(model?.id || model?.name || "").trim();
  if (KNOWN_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(id))) {
    return true;
  }
  return model?.supportsImages === true;
}

export function imageAttachments(message = {}) {
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments
    : [];
  return attachments
    .filter((attachment) => {
      if (!attachment || typeof attachment !== "object") return false;
      const dataUrl = String(attachment.dataUrl || "");
      if (!dataUrl.startsWith("data:image/")) return false;
      return (
        attachment.kind === "image" ||
        String(attachment.mimeType || attachment.type || "").startsWith("image/") ||
        dataUrl.startsWith("data:image/")
      );
    })
    .slice(0, MAX_VISION_IMAGES_PER_MESSAGE)
    .map((attachment) => ({
      ...attachment,
      dataUrl: String(attachment.dataUrl || "").slice(
        0,
        MAX_VISION_DATA_URL_CHARS,
      ),
    }));
}

export function hasImageAttachments(messages) {
  return (
    Array.isArray(messages) &&
    messages.some((message) => imageAttachments(message).length > 0)
  );
}

export function selectVisionCandidate(
  providers,
  {
    mainProviderId = "",
    mainModelId = "",
    visionProviderId = "",
    visionModelId = "",
  } = {},
) {
  const records = Array.isArray(providers) ? providers : [];
  const explicitProvider = String(visionProviderId || "").trim();
  const explicitModel = String(visionModelId || "").trim();

  const candidates = [];
  for (const provider of records) {
    const providerId = String(provider?.id || "").trim();
    if (explicitProvider && providerId !== explicitProvider) continue;
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      const modelId = String(model?.id || "").trim();
      if (!modelId || !modelSupportsVision(model)) continue;
      if (explicitModel && modelId !== explicitModel) continue;
      candidates.push({ provider, model });
    }
  }

  if (!candidates.length) return null;

  if (explicitProvider || explicitModel) return candidates[0];

  const nonMain = candidates.find(
    ({ provider, model }) =>
      String(provider?.id || "") !== String(mainProviderId || "") ||
      String(model?.id || "") !== String(mainModelId || ""),
  );
  return nonMain || candidates[0];
}

export function buildVisionMessages(message, images = imageAttachments(message)) {
  const userText = String(message?.content || "").trim();
  const content = [
    {
      type: "text",
      text: [
        "Analyze the attached image(s) for another coding agent that cannot see images.",
        "Be precise and factual. Preserve exact visible error text, labels, numbers, filenames, line numbers, UI states, layout relationships, and other details that may affect the user's task.",
        "Do not invent content that is not visible. If something is uncertain, say so.",
        "Return a compact structured observation with these headings when applicable: Summary, Visible text, UI/Layout, Errors/Warnings, Relevant details, Uncertainty.",
        userText ? `The user's accompanying request is: ${userText}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    ...images.map((attachment) => ({
      type: "image_url",
      image_url: { url: attachment.dataUrl },
    })),
  ];

  return [
    {
      role: "system",
      content:
        "You are AporiaX Vision Proxy. Your only job is to convert visual evidence into an accurate, concise observation for the main agent.",
    },
    { role: "user", content },
  ];
}

export function mergeVisionObservation(
  message,
  observation,
  { providerName = "Vision Provider", modelId = "vision-model" } = {},
) {
  const text = String(message?.content || "").trim();
  const visualText = String(observation || "").trim();
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.filter(
        (attachment) => !imageAttachments({ attachments: [attachment] }).length,
      )
    : [];
  const block = [
    `[Vision proxy observation · ${providerName} / ${modelId}]`,
    visualText || "No visual observation was returned.",
    "[End vision proxy observation]",
  ].join("\n");

  return {
    ...message,
    content: [text, block].filter(Boolean).join("\n\n"),
    attachments,
  };
}
