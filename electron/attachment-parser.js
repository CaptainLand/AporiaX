import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  MAX_OFFICE_FILE_BYTES,
  inspectOfficeArtifact,
  isOfficePath,
} from "./office-tools.js";

export const MAX_ATTACHMENT_BYTES = 8_000_000;
export const MAX_ATTACHMENT_TEXT_CHARS = 120_000;
export const MAX_PDF_PAGES = 240;
const STANDARD_FONT_DATA_URL = fileURLToPath(
  new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
);

const TEXT_EXTENSIONS = new Set([
  ".bat",
  ".c",
  ".cjs",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".less",
  ".log",
  ".markdown",
  ".md",
  ".mjs",
  ".properties",
  ".ps1",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("附件内容无效，请重新选择文件。");
}

function safeAttachmentName(name) {
  const normalized = String(name || "未命名附件")
    .replace(/[\r\n\t]/g, " ")
    .trim();
  return normalized.slice(0, 240) || "未命名附件";
}

function limitText(content, maximum = MAX_ATTACHMENT_TEXT_CHARS) {
  const text = String(content || "");
  return {
    content: text.slice(0, maximum),
    truncated: text.length > maximum,
  };
}

function isTextAttachment(extension, mimeType) {
  return (
    TEXT_EXTENSIONS.has(extension) ||
    String(mimeType || "").startsWith("text/") ||
    [
      "application/json",
      "application/javascript",
      "application/sql",
      "application/xml",
      "application/x-yaml",
    ].includes(String(mimeType || "").toLowerCase())
  );
}

function officeContent(artifact) {
  if (artifact.kind === "document") {
    return [
      `Word 文档：${artifact.path}`,
      `段落 ${artifact.paragraphCount}，标题 ${artifact.headingCount}，表格 ${artifact.tableCount}`,
      artifact.textPreview ? `正文预览：\n${artifact.textPreview}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (artifact.kind === "presentation") {
    return [
      `PowerPoint 演示文稿：${artifact.path}`,
      `共 ${artifact.slideCount} 页`,
      ...(artifact.slides || []).map(
        (slide) => `第 ${slide.slide} 页：${slide.text || "（无可提取文字）"}`,
      ),
    ].join("\n\n");
  }
  if (artifact.kind === "workbook") {
    return [
      `Excel 工作簿：${artifact.path}`,
      `共 ${artifact.sheetCount} 个工作表，${artifact.formulaCount} 个公式`,
      ...(artifact.sheets || []).map(
        (sheet) =>
          `${sheet.name}：${sheet.rowCount} 行 × ${sheet.columnCount} 列，${sheet.nonEmptyCells} 个非空单元格`,
      ),
    ].join("\n");
  }
  return JSON.stringify(artifact, null, 2);
}

export async function extractPdfText(
  input,
  { maxChars = MAX_ATTACHMENT_TEXT_CHARS, maxPages = MAX_PDF_PAGES } = {},
) {
  const buffer = asBuffer(input);
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("PDF 不能超过 8 MB。");
  }

  let document;
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useSystemFonts: false,
    });
    document = await loadingTask.promise;
    const pageCount = document.numPages;
    const parsedPages = Math.min(pageCount, maxPages);
    const pages = [];
    let characterCount = 0;

    for (let pageNumber = 1; pageNumber <= parsedPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => (typeof item?.str === "string" ? item.str : ""))
        .filter(Boolean)
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim();
      const section = `[第 ${pageNumber} 页]\n${pageText || "（没有可提取的文字）"}`;
      pages.push(section);
      characterCount += section.length + 2;
      if (characterCount >= maxChars) break;
    }

    const extracted = pages.join("\n\n");
    const hasText = textContentLength(extracted) > 0;
    const limited = limitText(extracted, maxChars);
    return {
      ...limited,
      pageCount,
      parsedPages: pages.length,
      requiresOcr: !hasText,
      truncated:
        limited.truncated ||
        pageCount > parsedPages ||
        pages.length < parsedPages,
    };
  } catch (error) {
    const message = String(error?.message || "");
    if (/password|encrypted/i.test(message)) {
      throw new Error("该 PDF 已加密，暂时无法解析。");
    }
    throw new Error(`PDF 解析失败：${message || "文件可能已损坏"}`);
  } finally {
    await document?.destroy?.();
  }
}

function textContentLength(content) {
  return String(content || "")
    .replace(/\[第 \d+ 页\]/g, "")
    .replace(/（没有可提取的文字）/g, "")
    .replace(/\s/g, "").length;
}

export async function parseAttachment(request) {
  const name = safeAttachmentName(request?.name);
  const type = String(request?.type || "");
  const buffer = asBuffer(request?.data);
  const extension = extname(name).toLowerCase();

  if (!buffer.length) throw new Error("不能上传空文件。");
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} 超过 8 MB，无法作为附件上传。`);
  }

  if (extension === ".pdf" || type === "application/pdf") {
    const result = await extractPdfText(buffer);
    return {
      kind: "document",
      name,
      type: type || "application/pdf",
      size: buffer.length,
      format: "PDF",
      ...result,
    };
  }

  if (isOfficePath(name)) {
    if (buffer.length > MAX_OFFICE_FILE_BYTES) {
      throw new Error(`${name} 超过 8 MB，无法解析。`);
    }
    const artifact = await inspectOfficeArtifact(name, buffer);
    const limited = limitText(officeContent(artifact));
    return {
      kind: "document",
      name,
      type,
      size: buffer.length,
      format: artifact.label || extension.slice(1).toUpperCase(),
      ...limited,
      artifact,
    };
  }

  if (isTextAttachment(extension, type)) {
    const text = buffer.toString("utf8");
    if (text.includes("\0")) {
      throw new Error(`${name} 看起来是二进制文件，无法作为文本附件读取。`);
    }
    const limited = limitText(text);
    return {
      kind: "document",
      name,
      type,
      size: buffer.length,
      format: extension.slice(1).toUpperCase() || "文本",
      ...limited,
    };
  }

  throw new Error(
    `暂不支持 ${extension || "该格式"}。可上传 PDF、Office、Markdown、文本、代码和结构化数据文件。`,
  );
}
