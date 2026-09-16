import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { data, pdf, from, to, language, rotation = 0, directory } = workerData;
const send = (value) => parentPort.postMessage(value);
let recognizer, document, pageNumber = from;
async function recognize(bytes) {
  if (!recognizer) recognizer = await createWorker(language, 1, {
    langPath: directory, cachePath: directory, cacheMethod: "none", gzip: true,
    workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js"),
    logger: (event) => send({ type: "progress", page: pageNumber, progress: Number(event.progress) || 0 }),
    errorHandler: () => {},
  // Our horizontal Simplified Chinese model references an optional vertical
  // language model. Disable that auto-load explicitly; manual rotation handles
  // sideways scans without silently downloading another model.
  }, { tessedit_load_sublangs: "~chi_sim_vert" });
  const { data: result } = await recognizer.recognize(bytes);
  return { text: result.text, confidence: result.confidence, method: "ocr" };
}
function preview(canvas) {
  const scale = Math.min(1, 1000 / canvas.width);
  const small = createCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)));
  small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
  const bytes = small.toBuffer("image/jpeg", 75);
  return bytes.length <= 500000 ? bytes.toString("base64") : null;
}
function rotate(canvas) {
  if (!rotation) return canvas;
  const swapped = rotation % 180 !== 0;
  const output = createCanvas(swapped ? canvas.height : canvas.width, swapped ? canvas.width : canvas.height);
  const context = output.getContext("2d"); context.translate(output.width / 2, output.height / 2); context.rotate(rotation * Math.PI / 180);
  context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2); canvas.width = canvas.height = 1;
  return output;
}
try {
  if (pdf) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    document = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false,
      standardFontDataUrl: fileURLToPath(new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)),
      cMapUrl: fileURLToPath(new URL("../../node_modules/pdfjs-dist/cmaps/", import.meta.url)), cMapPacked: true }).promise;
    if (to > document.numPages) throw new Error(`文档共 ${document.numPages} 页，请调整页码范围。`);
  }
  let chars = 0;
  for (pageNumber = from; pageNumber <= to; pageNumber++) {
    let page;
    try {
      let canvas, result;
      if (pdf) {
        page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("").trim();
        const raw = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.sqrt(12000000 / (raw.width * raw.height)), 8000 / Math.max(raw.width, raw.height));
        const viewport = page.getViewport({ scale });
        canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        canvas = rotate(canvas);
        result = text ? { text, method: "text-layer", confidence: null } : await recognize(canvas.toBuffer("image/png"));
      } else {
        const image = await loadImage(Buffer.from(data));
        if (image.width * image.height > 16000000 || Math.max(image.width, image.height) > 10000) throw new Error("图片尺寸过大，请缩小到 1600 万像素以内。");
        canvas = createCanvas(image.width, image.height);
        const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
        canvas = rotate(canvas);
        result = await recognize(canvas.toBuffer("image/png"));
      }
      const remaining = Math.max(0, 120000 - chars), truncated = result.text.length > remaining;
      result.text = result.text.slice(0, remaining); chars += result.text.length;
      send({ type: "page", page: { page: pageNumber, ...result, preview: preview(canvas), ...(truncated ? { error: "正文超过 120000 字，结果已截断。" } : {}) } });
      canvas.width = canvas.height = 1;
    } catch (error) { send({ type: "page", page: { page: pageNumber, text: "", error: error.message, method: "failed" } }); }
    finally { page?.cleanup(); }
  }
  send({ type: "done", totalPages: document?.numPages || 1 });
} catch (error) { send({ type: "error", error: error.message }); }
finally { await recognizer?.terminate(); await document?.destroy(); }
