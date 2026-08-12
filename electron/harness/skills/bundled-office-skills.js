function skill({ name, title, description, triggers, tools, instructions }) {
  return Object.freeze({
    name,
    title,
    description,
    version: "1.0.0",
    auto: true,
    triggers: Object.freeze([...triggers]),
    tools: Object.freeze([...tools]),
    instructions: instructions.trim(),
    source: "builtin",
    path: `builtin://office/${name}`,
  });
}

export const BUNDLED_OFFICE_SKILLS = Object.freeze([
  skill({
    name: "word-design",
    title: "Word Document Design",
    description:
      "Create restrained, readable Word documents with professional hierarchy, spacing, tables, and delivery QA.",
    triggers: [
      "word",
      "docx",
      "文档",
      "报告",
      "方案",
      "简历",
      "说明书",
      "proposal",
      "report",
    ],
    tools: ["read_file", "create_word_document", "inspect_office_file"],
    instructions: `
Treat the Word file as a designed document, not a text dump.

- Establish one clear visual hierarchy: title, optional subtitle, section headings, body, supporting tables/lists. Do not manufacture extra heading levels merely to create decoration.
- Prefer short paragraphs, descriptive headings, deliberate page breaks, and generous whitespace. Avoid walls of text and unnecessary repeated labels.
- Put the most important decision, conclusion, or summary early. For long reports, use a concise executive summary before detail.
- Use bullets only for genuinely parallel points. Use tables only when row/column comparison is easier than prose; keep tables narrow enough to scan and avoid stuffing full paragraphs into cells.
- Keep terminology, punctuation, capitalization, numbering, date formats, and heading style consistent throughout the document.
- Prefer restrained professional styling over ornamental elements. A small number of strong structural choices is better than many visual treatments.
- When the requested length is approximate, optimize for readability and information density instead of padding to a word count.
- After creation, call inspect_office_file and check the expected title, paragraph count, heading structure, tables, and file validity. Structural inspection does not prove final visual appearance; mention a Word/WPS visual check only when exact pagination or rendering matters.
`,
  }),
  skill({
    name: "spreadsheet-design",
    title: "Excel Workbook Design",
    description:
      "Create legible Excel workbooks with semantic sheets, useful formulas, disciplined formatting, and analysis-ready structure.",
    triggers: [
      "excel",
      "xlsx",
      "spreadsheet",
      "表格",
      "工作簿",
      "数据表",
      "统计表",
      "报表",
      "台账",
    ],
    tools: ["read_file", "create_spreadsheet", "inspect_office_file"],
    instructions: `
Design the workbook for scanning, filtering, and future editing rather than merely placing values into cells.

- Give each sheet one coherent purpose. Use short, descriptive sheet names and avoid splitting one logical table across many decorative sheets.
- Use a compact header row with clear field names. Order columns by how a reader works: identifiers/context first, key measures next, notes/status last.
- Choose column widths intentionally so common values are readable without creating excessively wide sheets. Freeze headers and enable filters for real data tables unless there is a reason not to.
- Preserve data types: numbers as numbers, booleans as booleans, and formulas as formulas. Use appropriate number formats for currency, percentages, dates, counts, and decimals.
- Prefer formulas for repeatable calculations instead of hard-coded totals. Keep formulas simple and auditable; avoid clever formulas when a clear intermediate column is easier to verify.
- Use visual emphasis sparingly. Header emphasis and semantic number formats are useful; rainbow fills, excessive borders, and alternating decorative colors are not.
- Separate raw/source data from summaries when the workbook is analytical. A summary sheet should answer the key questions, not duplicate every row.
- After creation, call inspect_office_file and verify sheet names, dimensions, formulas, and file integrity. Structural QA is not a substitute for checking final Excel/WPS rendering when exact visual presentation is important.
`,
  }),
  skill({
    name: "presentation-design",
    title: "PowerPoint Presentation Design",
    description:
      "Create concise 16:9 presentations with strong narrative hierarchy, restrained visuals, and slide-by-slide rhythm.",
    triggers: [
      "ppt",
      "pptx",
      "powerpoint",
      "presentation",
      "slides",
      "幻灯片",
      "演示文稿",
      "路演",
      "汇报",
      "答辩",
    ],
    tools: ["read_file", "create_presentation", "inspect_office_file"],
    instructions: `
Treat the deck as a visual narrative, not a Word document distributed across slides.

- Give the presentation a clear arc: opening promise/context, a small number of logical sections, evidence or explanation, and a decisive close.
- One slide should communicate one primary idea. Use slide titles as conclusions or useful signposts rather than generic labels such as “Introduction” whenever possible.
- Keep text short. Prefer 3–5 concise bullets when bullets are needed; split dense material into multiple slides instead of shrinking type or filling every corner.
- Alternate slide structures deliberately so the deck has rhythm: title/section moments, focused content slides, and two-column comparisons only when the comparison is meaningful.
- Preserve whitespace. Do not add decorative objects merely to occupy empty space. Use one restrained accent color and consistent hierarchy across the deck.
- Keep parallel slides structurally consistent: comparable title lengths, bullet grammar, ordering, and terminology.
- Put detailed caveats in concise supporting bullets rather than letting them dominate the visual hierarchy.
- Before creating the deck, outline slide titles and the purpose of each slide. Remove slides that repeat the same message.
- After creation, call inspect_office_file and verify slide count, titles, text coverage, and file validity. Structural inspection cannot detect every clipping or composition issue; recommend a PowerPoint/WPS visual pass when final presentation polish matters.
`,
  }),
]);
