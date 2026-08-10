const MAX_HISTORY_MESSAGES = 30;
const MAX_FILE_READ_CHARS = 120_000;
const MAX_TEXT_CONTENT_CHARS = 100_000;
const MAX_DOCUMENT_CONTEXT_CHARS = 240_000;
const MAX_IMAGE_DATA_URL_CHARS = 12_000_000;

export function normalizeImageAttachment(attachment) {
  if (
    !attachment ||
    typeof attachment.dataUrl !== "string" ||
    !attachment.dataUrl.startsWith("data:image/") ||
    attachment.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS
  ) {
    return null;
  }
  return {
    type: "image_url",
    image_url: { url: attachment.dataUrl },
  };
}

export function normalizeDocumentAttachment(
  attachment,
  { maxFileReadChars = MAX_FILE_READ_CHARS } = {},
) {
  if (
    !attachment ||
    attachment.kind !== "document" ||
    typeof attachment.content !== "string"
  ) {
    return null;
  }
  const name = String(attachment.name || "未命名附件")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 240);
  const format = String(attachment.format || "文件")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 80);
  const pageDescription = Number.isInteger(attachment.pageCount)
    ? `，${attachment.pageCount} 页`
    : "";
  const notices = [
    attachment.truncated ? "内容已按本地安全上限截断" : "",
    attachment.requiresOcr ? "未提取到正文，可能需要 OCR" : "",
  ].filter(Boolean);
  const noticeText = notices.length ? `\n说明：${notices.join("；")}` : "";
  return [
    `[附件开始：${name}｜${format}${pageDescription}]`,
    attachment.content.slice(0, maxFileReadChars),
    `${noticeText}\n[附件结束：${name}]`,
  ].join("\n");
}

export function sanitizeConversation(
  messages,
  {
    supportsImages = false,
    maxHistoryMessages = MAX_HISTORY_MESSAGES,
    maxFileReadChars = MAX_FILE_READ_CHARS,
  } = {},
) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter(
      (message) =>
        ["user", "assistant"].includes(message?.role) &&
        typeof message?.content === "string" &&
        !message?.error &&
        !["failed", "interrupted", "running"].includes(message?.status) &&
        (message.content.trim() || message.attachments?.length),
    )
    .slice(-Math.max(1, maxHistoryMessages))
    .map((message) => {
      const text = message.content.slice(0, MAX_TEXT_CONTENT_CHARS);
      if (message.role !== "user" || !message.attachments?.length) {
        return { role: message.role, content: text };
      }
      const documentText = message.attachments
        .slice(0, 6)
        .map((attachment) =>
          normalizeDocumentAttachment(attachment, { maxFileReadChars }),
        )
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_DOCUMENT_CONTEXT_CHARS);
      const combinedText = [text, documentText].filter(Boolean).join("\n\n");
      const imageAttachments = message.attachments.filter(
        (attachment) =>
          attachment?.kind === "image" ||
          typeof attachment?.dataUrl === "string",
      );
      if (!imageAttachments.length) {
        return { role: message.role, content: combinedText };
      }
      if (!supportsImages) {
        const attachmentNotice =
          "[系统提示：当前模型不支持读取本消息中的图片附件，图片已从模型请求中省略。]";
        return {
          role: message.role,
          content: combinedText
            ? `${combinedText}\n\n${attachmentNotice}`
            : attachmentNotice,
        };
      }
      const imageParts = imageAttachments
        .slice(0, 4)
        .map(normalizeImageAttachment)
        .filter(Boolean);
      if (!imageParts.length) {
        return { role: message.role, content: combinedText };
      }
      return {
        role: message.role,
        content: [
          {
            type: "text",
            text: combinedText || "请检查所附图片。",
          },
          ...imageParts,
        ],
      };
    });
}

export function sanitizeFinalAnswer(content) {
  return String(content || "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(
      /!\[[^\]]*\]\((?:data:image\/svg\+xml|[^)\s]+\.svg)[^)]*\)/gi,
      "",
    )
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function formatToolStepDetail(
  toolName,
  modelResult,
  language = "zh-CN",
) {
  if (modelResult?.reason) return modelResult.reason;
  const error = String(modelResult?.error || "");
  if (!error) return null;
  if (/Invalid arguments/i.test(error)) {
    return language === "en"
      ? "Invalid tool arguments; the agent will regenerate them"
      : "工具参数格式无效，Agent 将重新生成参数";
  }
  if (/Mandatory self-check has not started yet/i.test(error)) {
    return language === "en"
      ? "Harness started the mandatory self-check and will continue reviewing this turn"
      : "Harness 已自动进入强制自检，继续复核本轮修改";
  }
  if (/Re-read these changed files/i.test(error)) {
    return error.replace(
      /^Re-read these changed files after their latest write before completing self-check:\s*/i,
      language === "en" ? "Still needs re-reading: " : "仍需重新读取：",
    );
  }
  if (/Run at least one detected project verification command/i.test(error)) {
    return language === "en"
      ? "At least one detected project verification command still needs to run"
      : "仍需运行一项已检测到的项目验证命令";
  }
  return error;
}
