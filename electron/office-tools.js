import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { extname } from "node:path";

export const MAX_OFFICE_FILE_BYTES = 8_000_000;

export const OFFICE_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "create_word_document",
      description:
        "Create a polished local Word .docx document from structured blocks. After creating it, use inspect_office_file during self-check.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative output path ending in .docx.",
          },
          title: { type: "string" },
          subtitle: { type: "string" },
          blocks: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "heading",
                    "paragraph",
                    "bullets",
                    "table",
                    "page_break",
                  ],
                },
                text: { type: "string" },
                level: { type: "integer", minimum: 1, maximum: 3 },
                items: {
                  type: "array",
                  maxItems: 30,
                  items: { type: "string" },
                },
                headers: {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string" },
                },
                rows: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "array",
                    maxItems: 8,
                    items: { type: "string" },
                  },
                },
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "title", "blocks"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_presentation",
      description:
        "Create a clean widescreen local PowerPoint .pptx deck from structured slides. After creating it, use inspect_office_file during self-check.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative output path ending in .pptx.",
          },
          title: { type: "string" },
          subtitle: { type: "string" },
          accent_color: {
            type: "string",
            description: "Optional six-digit RGB hex color without '#'.",
          },
          slides: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                layout: {
                  type: "string",
                  enum: ["title", "section", "content", "two_column"],
                },
                title: { type: "string" },
                subtitle: { type: "string" },
                bullets: {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string" },
                },
                left_title: { type: "string" },
                left_bullets: {
                  type: "array",
                  maxItems: 6,
                  items: { type: "string" },
                },
                right_title: { type: "string" },
                right_bullets: {
                  type: "array",
                  maxItems: 6,
                  items: { type: "string" },
                },
              },
              required: ["layout", "title"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "title", "slides"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_spreadsheet",
      description:
        "Create a formatted local Excel .xlsx workbook with typed rows and formulas. After creating it, use inspect_office_file during self-check.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative output path ending in .xlsx.",
          },
          title: { type: "string" },
          sheets: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                headers: {
                  type: "array",
                  minItems: 1,
                  maxItems: 30,
                  items: { type: "string" },
                },
                rows: {
                  type: "array",
                  maxItems: 2000,
                  items: {
                    type: "array",
                    maxItems: 30,
                    items: {
                      type: ["string", "number", "boolean", "null"],
                    },
                  },
                },
                formulas: {
                  type: "array",
                  maxItems: 500,
                  items: {
                    type: "object",
                    properties: {
                      cell: { type: "string" },
                      formula: { type: "string" },
                      number_format: { type: "string" },
                    },
                    required: ["cell", "formula"],
                    additionalProperties: false,
                  },
                },
                column_widths: {
                  type: "array",
                  maxItems: 30,
                  items: { type: "number", minimum: 6, maximum: 60 },
                },
                freeze_header: { type: "boolean" },
                auto_filter: { type: "boolean" },
              },
              required: ["name", "headers", "rows"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "title", "sheets"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_office_file",
      description:
        "Structurally validate and summarize a local .docx, .pptx, or .xlsx file. Use this after creating or modifying an Office artifact.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Workspace-relative path ending in .docx, .pptx, or .xlsx.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

export const OFFICE_CREATE_TOOL_NAMES = new Set([
  "create_word_document",
  "create_presentation",
  "create_spreadsheet",
]);

function requireText(value, fieldName, maxLength = 4_000) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength
  ) {
    throw new Error(
      `${fieldName} must be a non-empty string under ${maxLength} characters.`,
    );
  }
  return value.trim();
}

function optionalText(value, fieldName, maxLength = 4_000) {
  if (value === undefined || value === null || value === "") return "";
  return requireText(value, fieldName, maxLength);
}

function requireArray(value, fieldName, maximum, minimum = 0) {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new Error(
      `${fieldName} must contain between ${minimum} and ${maximum} items.`,
    );
  }
  return value;
}

function requireExtension(path, extension) {
  const normalizedPath = requireText(path, "path", 1_000);
  if (extname(normalizedPath).toLowerCase() !== extension) {
    throw new Error(`Output path must end in ${extension}.`);
  }
  return normalizedPath;
}

function normalizeHexColor(value, fallback = "315C8C") {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    throw new Error("accent_color must be a six-digit RGB hex color.");
  }
  return normalized;
}

function xmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function textNodesFromXml(xml) {
  return [...String(xml || "").matchAll(/<(?:w:t|a:t)(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:t|a:t)>/g)]
    .map((match) => xmlText(match[1]))
    .filter(Boolean);
}

function officeLabel(kind) {
  if (kind === "document") return "Word 文档";
  if (kind === "presentation") return "PowerPoint 演示文稿";
  if (kind === "workbook") return "Excel 工作簿";
  return "Office 文件";
}

function createArtifactMetadata(kind, path, details, byteLength) {
  return {
    kind,
    label: officeLabel(kind),
    format: extname(path).slice(1).toLowerCase(),
    bytes: byteLength,
    visualQa: "not-rendered",
    ...details,
  };
}

function wordParagraph(text, options = {}) {
  return new Paragraph({
    ...options,
    children: [
      new TextRun({
        text,
        font: "Aptos",
        size: options.size || 22,
        bold: Boolean(options.bold),
        color: options.color || "28323C",
      }),
    ],
  });
}

function normalizeTableBlock(block, blockIndex) {
  const headers = requireArray(
    block.headers,
    `blocks[${blockIndex}].headers`,
    8,
    1,
  ).map((value, index) =>
    requireText(value, `blocks[${blockIndex}].headers[${index}]`, 200),
  );
  const rows = requireArray(
    block.rows || [],
    `blocks[${blockIndex}].rows`,
    100,
  ).map((row, rowIndex) => {
    const values = requireArray(
      row,
      `blocks[${blockIndex}].rows[${rowIndex}]`,
      headers.length,
    );
    return headers.map((_, columnIndex) =>
      optionalText(
        values[columnIndex] ?? "",
        `blocks[${blockIndex}].rows[${rowIndex}][${columnIndex}]`,
        1_000,
      ),
    );
  });
  return { headers, rows };
}

async function createWordDocument(input) {
  const path = requireExtension(input.path, ".docx");
  const title = requireText(input.title, "title", 300);
  const subtitle = optionalText(input.subtitle, "subtitle", 500);
  const blocks = requireArray(input.blocks, "blocks", 100);
  const children = [
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: title,
          font: "Aptos Display",
          size: 46,
          bold: true,
          color: "1F2D3D",
        }),
      ],
    }),
  ];
  if (subtitle) {
    children.push(
      wordParagraph(subtitle, {
        size: 24,
        color: "657484",
        spacing: { after: 360 },
      }),
    );
  } else {
    children.push(new Paragraph({ spacing: { after: 220 } }));
  }

  let paragraphCount = subtitle ? 2 : 1;
  let tableCount = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] || {};
    if (block.type === "page_break") {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      continue;
    }
    if (block.type === "heading") {
      const text = requireText(block.text, `blocks[${index}].text`, 500);
      const level = Number.isInteger(block.level)
        ? Math.min(3, Math.max(1, block.level))
        : 1;
      children.push(
        new Paragraph({
          text,
          heading:
            level === 1
              ? HeadingLevel.HEADING_1
              : level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          spacing: { before: level === 1 ? 280 : 220, after: 120 },
        }),
      );
      paragraphCount += 1;
      continue;
    }
    if (block.type === "paragraph") {
      children.push(
        wordParagraph(
          requireText(block.text, `blocks[${index}].text`, 8_000),
          { spacing: { after: 170, line: 276 } },
        ),
      );
      paragraphCount += 1;
      continue;
    }
    if (block.type === "bullets") {
      const items = requireArray(
        block.items,
        `blocks[${index}].items`,
        30,
        1,
      );
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const text = requireText(
          items[itemIndex],
          `blocks[${index}].items[${itemIndex}]`,
          2_000,
        );
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 90, line: 260 },
            children: [
              new TextRun({
                text,
                font: "Aptos",
                size: 22,
                color: "28323C",
              }),
            ],
          }),
        );
        paragraphCount += 1;
      }
      continue;
    }
    if (block.type === "table") {
      const { headers, rows } = normalizeTableBlock(block, index);
      const columnWidth = Math.floor(9_360 / headers.length);
      const borders = {
        top: { style: BorderStyle.SINGLE, color: "CBD4DC", size: 4 },
        bottom: { style: BorderStyle.SINGLE, color: "CBD4DC", size: 4 },
        left: { style: BorderStyle.SINGLE, color: "CBD4DC", size: 4 },
        right: { style: BorderStyle.SINGLE, color: "CBD4DC", size: 4 },
        insideHorizontal: {
          style: BorderStyle.SINGLE,
          color: "DDE3E8",
          size: 3,
        },
        insideVertical: {
          style: BorderStyle.SINGLE,
          color: "DDE3E8",
          size: 3,
        },
      };
      const tableRows = [
        new TableRow({
          tableHeader: true,
          children: headers.map(
            (header) =>
              new TableCell({
                width: { size: columnWidth, type: WidthType.DXA },
                shading: {
                  fill: "EAF0F5",
                  type: ShadingType.CLEAR,
                },
                margins: { top: 120, bottom: 120, left: 120, right: 120 },
                children: [
                  wordParagraph(header, {
                    bold: true,
                    size: 20,
                    spacing: { after: 0 },
                  }),
                ],
              }),
          ),
        }),
        ...rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (value) =>
                  new TableCell({
                    width: { size: columnWidth, type: WidthType.DXA },
                    verticalAlign: "center",
                    margins: {
                      top: 110,
                      bottom: 110,
                      left: 120,
                      right: 120,
                    },
                    children: [
                      wordParagraph(value || " ", {
                        size: 20,
                        spacing: { after: 0, line: 240 },
                      }),
                    ],
                  }),
              ),
            }),
        ),
      ];
      children.push(
        new Table({
          width: { size: 9_360, type: WidthType.DXA },
          columnWidths: headers.map(() => columnWidth),
          borders,
          rows: tableRows,
        }),
        new Paragraph({ spacing: { after: 180 } }),
      );
      tableCount += 1;
      continue;
    }
    throw new Error(`Unsupported Word block type: ${block.type}`);
  }

  const document = new Document({
    creator: "AporiaX",
    title,
    description: subtitle,
    styles: {
      default: {
        document: {
          run: { font: "Aptos", size: 22, color: "28323C" },
          paragraph: { spacing: { after: 160, line: 276 } },
        },
        heading1: {
          run: { font: "Aptos Display", size: 32, bold: true, color: "244B70" },
          paragraph: { spacing: { before: 280, after: 120 } },
        },
        heading2: {
          run: { font: "Aptos Display", size: 27, bold: true, color: "315C8C" },
          paragraph: { spacing: { before: 220, after: 100 } },
        },
        heading3: {
          run: { font: "Aptos", size: 23, bold: true, color: "3F596F" },
          paragraph: { spacing: { before: 180, after: 80 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1_080,
              right: 1_440,
              bottom: 1_080,
              left: 1_440,
            },
          },
        },
        children,
      },
    ],
  });
  const buffer = await Packer.toBuffer(document);
  return {
    path,
    buffer,
    artifact: createArtifactMetadata(
      "document",
      path,
      {
        title,
        blockCount: blocks.length,
        paragraphCount,
        tableCount,
      },
      buffer.length,
    ),
  };
}

function addSlideTitle(slide, title, accentColor) {
  slide.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.12,
    h: 7.5,
    line: { color: accentColor, transparency: 100 },
    fill: { color: accentColor },
  });
  slide.addText(title, {
    x: 0.72,
    y: 0.45,
    w: 11.85,
    h: 0.58,
    fontFace: "Aptos Display",
    fontSize: 35,
    bold: true,
    color: "1F2D3D",
    margin: 0,
    breakLine: false,
    fit: "shrink",
  });
}

function addBullets(slide, bullets, area, accentColor) {
  const normalized = requireArray(bullets || [], "bullets", 8);
  normalized.forEach((bullet, index) => {
    const text = requireText(bullet, `bullets[${index}]`, 350);
    slide.addShape("ellipse", {
      x: area.x,
      y: area.y + index * area.step + 0.15,
      w: 0.09,
      h: 0.09,
      line: { color: accentColor, transparency: 100 },
      fill: { color: accentColor },
    });
    slide.addText(text, {
      x: area.x + 0.24,
      y: area.y + index * area.step,
      w: area.w - 0.24,
      h: Math.max(0.46, area.step - 0.08),
      fontFace: "Aptos",
      fontSize: 20,
      color: "344250",
      margin: 0,
      valign: "mid",
      breakLine: false,
      fit: "shrink",
    });
  });
}

async function createPresentation(input) {
  const path = requireExtension(input.path, ".pptx");
  const title = requireText(input.title, "title", 300);
  const subtitle = optionalText(input.subtitle, "subtitle", 500);
  const accentColor = normalizeHexColor(input.accent_color);
  const slides = requireArray(input.slides, "slides", 30, 1);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "AporiaX";
  pptx.subject = title;
  pptx.title = title;
  pptx.company = "AporiaX";
  pptx.lang = "zh-CN";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "zh-CN",
  };

  let totalBullets = 0;
  const warnings = [];
  slides.forEach((slideInput, index) => {
    const layout = requireText(
      slideInput.layout,
      `slides[${index}].layout`,
      30,
    );
    const slideTitle = requireText(
      slideInput.title,
      `slides[${index}].title`,
      250,
    );
    const slide = pptx.addSlide();
    slide.background = { color: layout === "section" ? accentColor : "F8FAFC" };

    if (layout === "title") {
      slide.addShape("rect", {
        x: 0.72,
        y: 1.15,
        w: 1.2,
        h: 0.1,
        line: { color: accentColor, transparency: 100 },
        fill: { color: accentColor },
      });
      slide.addText(slideTitle, {
        x: 0.72,
        y: 1.52,
        w: 11.75,
        h: 1.45,
        fontFace: "Aptos Display",
        fontSize: 50,
        bold: true,
        color: "1F2D3D",
        margin: 0,
        valign: "mid",
        fit: "shrink",
      });
      const slideSubtitle = optionalText(
        slideInput.subtitle || subtitle,
        `slides[${index}].subtitle`,
        500,
      );
      if (slideSubtitle) {
        slide.addText(slideSubtitle, {
          x: 0.76,
          y: 3.25,
          w: 10.8,
          h: 0.85,
          fontFace: "Aptos",
          fontSize: 24,
          color: "667788",
          margin: 0,
          fit: "shrink",
        });
      }
    } else if (layout === "section") {
      slide.addText(slideTitle, {
        x: 0.9,
        y: 2.15,
        w: 11.45,
        h: 1.1,
        fontFace: "Aptos Display",
        fontSize: 44,
        bold: true,
        color: "FFFFFF",
        margin: 0,
        align: "center",
        valign: "mid",
        fit: "shrink",
      });
      const sectionSubtitle = optionalText(
        slideInput.subtitle,
        `slides[${index}].subtitle`,
        500,
      );
      if (sectionSubtitle) {
        slide.addText(sectionSubtitle, {
          x: 1.4,
          y: 3.45,
          w: 10.5,
          h: 0.7,
          fontFace: "Aptos",
          fontSize: 21,
          color: "EAF2F8",
          align: "center",
          margin: 0,
          fit: "shrink",
        });
      }
    } else if (layout === "content") {
      addSlideTitle(slide, slideTitle, accentColor);
      const bullets = requireArray(
        slideInput.bullets || [],
        `slides[${index}].bullets`,
        8,
      );
      totalBullets += bullets.length;
      addBullets(
        slide,
        bullets,
        { x: 0.9, y: 1.45, w: 11.55, step: 0.68 },
        accentColor,
      );
      if (bullets.length > 7) {
        warnings.push(`Slide ${index + 1} is content-dense.`);
      }
    } else if (layout === "two_column") {
      addSlideTitle(slide, slideTitle, accentColor);
      const leftTitle = optionalText(
        slideInput.left_title,
        `slides[${index}].left_title`,
        160,
      );
      const rightTitle = optionalText(
        slideInput.right_title,
        `slides[${index}].right_title`,
        160,
      );
      slide.addText(leftTitle || "要点一", {
        x: 0.85,
        y: 1.35,
        w: 5.45,
        h: 0.42,
        fontFace: "Aptos Display",
        fontSize: 24,
        bold: true,
        color: accentColor,
        margin: 0,
        fit: "shrink",
      });
      slide.addText(rightTitle || "要点二", {
        x: 6.9,
        y: 1.35,
        w: 5.45,
        h: 0.42,
        fontFace: "Aptos Display",
        fontSize: 24,
        bold: true,
        color: accentColor,
        margin: 0,
        fit: "shrink",
      });
      const leftBullets = requireArray(
        slideInput.left_bullets || [],
        `slides[${index}].left_bullets`,
        6,
      );
      const rightBullets = requireArray(
        slideInput.right_bullets || [],
        `slides[${index}].right_bullets`,
        6,
      );
      totalBullets += leftBullets.length + rightBullets.length;
      addBullets(
        slide,
        leftBullets,
        { x: 0.9, y: 2.0, w: 5.3, step: 0.72 },
        accentColor,
      );
      addBullets(
        slide,
        rightBullets,
        { x: 6.95, y: 2.0, w: 5.3, step: 0.72 },
        accentColor,
      );
      slide.addShape("line", {
        x: 6.57,
        y: 1.36,
        w: 0,
        h: 4.9,
        line: { color: "D9E1E8", width: 1 },
      });
    } else {
      throw new Error(`Unsupported slide layout: ${layout}`);
    }

    if (layout !== "title" && layout !== "section") {
      slide.addText(`${index + 1}`, {
        x: 12.45,
        y: 7.08,
        w: 0.35,
        h: 0.2,
        fontFace: "Aptos",
        fontSize: 9,
        color: "8A97A3",
        align: "right",
        margin: 0,
      });
    }
  });

  const output = await pptx.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(output)
    ? output
    : Buffer.from(output);
  return {
    path,
    buffer,
    artifact: createArtifactMetadata(
      "presentation",
      path,
      {
        title,
        slideCount: slides.length,
        bulletCount: totalBullets,
        warnings,
      },
      buffer.length,
    ),
  };
}

function excelColumnName(number) {
  let current = number;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function sanitizeSheetName(value, index, usedNames) {
  const base = requireText(value, `sheets[${index}].name`, 100)
    .replace(/[\\/*?:[\]]/g, " ")
    .trim()
    .slice(0, 31) || `Sheet${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffixText = ` ${suffix}`;
    candidate = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function createSpreadsheet(input) {
  const path = requireExtension(input.path, ".xlsx");
  const title = requireText(input.title, "title", 300);
  const sheets = requireArray(input.sheets, "sheets", 12, 1);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AporiaX";
  workbook.title = title;
  workbook.created = new Date();
  workbook.modified = new Date();
  const usedNames = new Set();
  let totalRows = 0;
  let formulaCount = 0;

  sheets.forEach((sheetInput, sheetIndex) => {
    const name = sanitizeSheetName(
      sheetInput.name,
      sheetIndex,
      usedNames,
    );
    const headers = requireArray(
      sheetInput.headers,
      `sheets[${sheetIndex}].headers`,
      30,
      1,
    ).map((header, columnIndex) =>
      requireText(
        header,
        `sheets[${sheetIndex}].headers[${columnIndex}]`,
        200,
      ),
    );
    const rows = requireArray(
      sheetInput.rows,
      `sheets[${sheetIndex}].rows`,
      2_000,
    );
    const widths = Array.isArray(sheetInput.column_widths)
      ? sheetInput.column_widths
      : [];
    const worksheet = workbook.addWorksheet(name, {
      views: sheetInput.freeze_header === false
        ? []
        : [{ state: "frozen", ySplit: 1 }],
      properties: { defaultRowHeight: 20 },
    });
    worksheet.columns = headers.map((header, columnIndex) => ({
      header,
      key: `column_${columnIndex + 1}`,
      width: Math.min(
        60,
        Math.max(
          10,
          Number(widths[columnIndex]) ||
            Math.min(32, Math.max(12, header.length + 4)),
        ),
      ),
    }));
    const headerRow = worksheet.getRow(1);
    headerRow.height = 25;
    headerRow.font = {
      name: "Aptos",
      size: 11,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    headerRow.alignment = {
      vertical: "middle",
      horizontal: "center",
    };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF315C8C" },
    };

    rows.forEach((rowValues, rowIndex) => {
      if (!Array.isArray(rowValues) || rowValues.length > headers.length) {
        throw new Error(
          `sheets[${sheetIndex}].rows[${rowIndex}] has too many columns.`,
        );
      }
      const normalized = headers.map((_, columnIndex) => {
        const value = rowValues[columnIndex] ?? null;
        if (
          !["string", "number", "boolean"].includes(typeof value) &&
          value !== null
        ) {
          throw new Error(
            `Unsupported cell value in sheets[${sheetIndex}].rows[${rowIndex}].`,
          );
        }
        if (typeof value === "string" && value.startsWith("=")) {
          formulaCount += 1;
          return { formula: value.slice(1) };
        }
        return value;
      });
      const row = worksheet.addRow(normalized);
      row.alignment = { vertical: "middle", wrapText: true };
      if ((rowIndex + 1) % 2 === 0) {
        row.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF5F8FA" },
        };
      }
      row.eachCell((cell) => {
        cell.font = { name: "Aptos", size: 10.5 };
        cell.border = {
          bottom: { style: "hair", color: { argb: "FFDCE3E9" } },
        };
      });
    });
    const formulas = requireArray(
      sheetInput.formulas || [],
      `sheets[${sheetIndex}].formulas`,
      500,
    );
    formulas.forEach((formulaInput, formulaIndex) => {
      const cellAddress = requireText(
        formulaInput?.cell,
        `sheets[${sheetIndex}].formulas[${formulaIndex}].cell`,
        20,
      ).toUpperCase();
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cellAddress)) {
        throw new Error(`Invalid formula cell address: ${cellAddress}`);
      }
      const formula = requireText(
        formulaInput?.formula,
        `sheets[${sheetIndex}].formulas[${formulaIndex}].formula`,
        2_000,
      ).replace(/^=/, "");
      const cell = worksheet.getCell(cellAddress);
      cell.value = { formula };
      if (formulaInput.number_format) {
        cell.numFmt = requireText(
          formulaInput.number_format,
          `sheets[${sheetIndex}].formulas[${formulaIndex}].number_format`,
          100,
        );
      }
      formulaCount += 1;
    });
    if (sheetInput.auto_filter !== false && rows.length > 0) {
      worksheet.autoFilter = {
        from: "A1",
        to: `${excelColumnName(headers.length)}${rows.length + 1}`,
      };
    }
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) row.height = Math.max(row.height || 20, 20);
    });
    totalRows += rows.length;
  });

  const output = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(output)
    ? output
    : Buffer.from(output);
  return {
    path,
    buffer,
    artifact: createArtifactMetadata(
      "workbook",
      path,
      {
        title,
        sheetCount: sheets.length,
        rowCount: totalRows,
        formulaCount,
      },
      buffer.length,
    ),
  };
}

async function inspectDocx(path, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) throw new Error("DOCX is missing word/document.xml.");
  const xml = await documentFile.async("string");
  const text = textNodesFromXml(xml);
  const paragraphCount = (xml.match(/<w:p(?:\s|>)/g) || []).length;
  const tableCount = (xml.match(/<w:tbl(?:\s|>)/g) || []).length;
  const headingCount = (xml.match(/<w:pStyle[^>]+w:val="Heading[123]"/g) || [])
    .length;
  return {
    path,
    valid: true,
    kind: "document",
    label: officeLabel("document"),
    bytes: buffer.length,
    paragraphCount,
    headingCount,
    tableCount,
    textPreview: text.join(" ").slice(0, 2_000),
    visualQa: "not-rendered",
  };
}

async function inspectPptx(path, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/slide(\d+)\.xml$/)?.[1] || 0);
      const rightNumber = Number(right.match(/slide(\d+)\.xml$/)?.[1] || 0);
      return leftNumber - rightNumber;
    });
  if (!slideFiles.length) {
    throw new Error("PPTX does not contain any slides.");
  }
  const slideSummaries = [];
  for (let index = 0; index < slideFiles.length; index += 1) {
    const xml = await zip.file(slideFiles[index]).async("string");
    const texts = textNodesFromXml(xml);
    slideSummaries.push({
      slide: index + 1,
      text: texts.join(" ").slice(0, 500),
      textRuns: texts.length,
    });
  }
  return {
    path,
    valid: true,
    kind: "presentation",
    label: officeLabel("presentation"),
    bytes: buffer.length,
    slideCount: slideFiles.length,
    slides: slideSummaries,
    visualQa: "not-rendered",
  };
}

async function inspectXlsx(path, buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets.length) {
    throw new Error("XLSX does not contain any worksheets.");
  }
  let formulaCount = 0;
  const sheets = workbook.worksheets.map((worksheet) => {
    let nonEmptyCells = 0;
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        nonEmptyCells += 1;
        if (
          cell.value &&
          typeof cell.value === "object" &&
          "formula" in cell.value
        ) {
          formulaCount += 1;
        }
      });
    });
    return {
      name: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      nonEmptyCells,
    };
  });
  return {
    path,
    valid: true,
    kind: "workbook",
    label: officeLabel("workbook"),
    bytes: buffer.length,
    sheetCount: sheets.length,
    formulaCount,
    sheets,
    visualQa: "not-rendered",
  };
}

export function isOfficePath(path) {
  return [".docx", ".pptx", ".xlsx"].includes(
    extname(String(path || "")).toLowerCase(),
  );
}

export async function createOfficeArtifact(toolName, input) {
  let result;
  if (toolName === "create_word_document") {
    result = await createWordDocument(input);
  } else if (toolName === "create_presentation") {
    result = await createPresentation(input);
  } else if (toolName === "create_spreadsheet") {
    result = await createSpreadsheet(input);
  } else {
    throw new Error(`Unsupported Office creation tool: ${toolName}`);
  }
  if (result.buffer.length > MAX_OFFICE_FILE_BYTES) {
    throw new Error(
      `Office output exceeds the ${Math.floor(MAX_OFFICE_FILE_BYTES / 1_000_000)} MB limit.`,
    );
  }
  return result;
}

export async function inspectOfficeArtifact(path, buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Office inspection requires a file buffer.");
  }
  if (buffer.length > MAX_OFFICE_FILE_BYTES) {
    throw new Error(
      `Office file exceeds the ${Math.floor(MAX_OFFICE_FILE_BYTES / 1_000_000)} MB inspection limit.`,
    );
  }
  const extension = extname(path).toLowerCase();
  if (extension === ".docx") return inspectDocx(path, buffer);
  if (extension === ".pptx") return inspectPptx(path, buffer);
  if (extension === ".xlsx") return inspectXlsx(path, buffer);
  throw new Error("Only .docx, .pptx, and .xlsx can be inspected.");
}
