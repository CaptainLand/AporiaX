import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createOcrService } from "../electron/ocr/service.js";
import { extractPdfText } from "../electron/attachment-parser.js";

const directory = resolve(".tmp/ocr-097-models"); await mkdir(directory, { recursive: true });
const service = createOcrService({ directory });
try {
  await service.prepare(); assert.equal((await service.status()).ready, true);
  const canvas = createCanvas(1200, 300), context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, 1200, 300); context.fillStyle = "black"; context.font = '60px "Microsoft YaHei", Arial';
  context.fillText("AporiaX 097 Hello World", 40, 100); context.fillText("中文文字识别测试", 40, 220);
  const data = canvas.toBuffer("image/png"); await writeFile(resolve(".tmp/ocr-097-fixture.png"), data);
  const wait = async (job) => { const deadline = Date.now() + 90000; while (job.state === "running" && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 100)); job = service.get(job.id, "fixture"); } assert.notEqual(job.state, "running", "OCR timeout"); return job; };
  let job = await service.start({ data, name: "example.png", from: 1, to: 1 }, "fixture");
  assert.throws(() => service.get(job.id, "wrong-owner"));
  job = await wait(job); assert.equal(job.state, "completed", JSON.stringify(job));
  assert.match(job.pages[0].text, /Hello World/i); assert.match(job.pages[0].text.replace(/\s/g, ""), /中文文字识别测试/);
  assert.equal(typeof job.pages[0].confidence, "number");
  assert.equal((await service.start({ data, name: "same.png" }, "fixture")).cached, true);
  const sideways = createCanvas(300, 1200), sidewaysContext = sideways.getContext("2d");
  sidewaysContext.translate(300, 0); sidewaysContext.rotate(Math.PI / 2); sidewaysContext.drawImage(canvas, 0, 0);
  const rotated = await wait(await service.start({ data: sideways.toBuffer("image/png"), name: "rotated.png", rotation: 270 }, "fixture"));
  assert.equal(rotated.state, "completed"); assert.match(rotated.pages[0].text, /Hello World/);
  const blank = createCanvas(400, 300), blankContext = blank.getContext("2d"); blankContext.fillStyle = "white"; blankContext.fillRect(0, 0, 400, 300);
  const blankJob = await wait(await service.start({ data: blank.toBuffer("image/png"), name: "blank.png", language: "eng" }, "fixture"));
  assert.equal(blankJob.state, "partial"); assert.equal(blankJob.pages[0].text.trim(), "");
  await assert.rejects(service.start({ data, from: 1, to: 21 }, "fixture"), /页码/);
  await assert.rejects(service.start({ data: Buffer.from("<svg/>") }, "fixture"), /仅支持/);
  const broken = await wait(await service.start({ data: Buffer.from("%PDF-broken"), name: "broken.pdf" }, "fixture"));
  assert.equal(broken.state, "failed");
  // Two-page PDF: first has text, second is a scanned JPEG page.
  const jpeg = canvas.toBuffer("image/jpeg", 95), imageStream = Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]);
  const content1 = "BT /F1 24 Tf 40 700 Td (Original PDF text) Tj ET", content2 = "q 600 0 0 150 0 600 cm /Im1 Do Q";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 7 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`, `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`, imageStream];
  const chunks = [Buffer.from("%PDF-1.4\n")], offsets = [0]; let size = chunks[0].length;
  objects.forEach((object, index) => { offsets.push(size); const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from("\nendobj\n")]); chunks.push(part); size += part.length; });
  chunks.push(Buffer.from(`xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  const pdf = Buffer.concat(chunks); await writeFile(resolve(".tmp/ocr-097-fixture.pdf"), pdf);
  const parsed = await extractPdfText(pdf); assert.deepEqual(parsed.ocrPages, [2]); assert.equal(parsed.requiresOcr, true);
  job = await wait(await service.start({ data: pdf, name: "mixed.pdf", from: 1, to: 2 }, "fixture"));
  assert.equal(job.state, "completed", JSON.stringify(job.pages)); assert.equal(job.pages[0].method, "text-layer"); assert.equal(job.pages[1].method, "ocr"); assert.match(job.pages[1].text, /Hello World/);
  const cancelled = await service.start({ data, name: "cancel.png", language: "eng" }, "fixture");
  assert.equal(service.cancel(cancelled.id, "fixture").state, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 200)); assert.equal(service.get(cancelled.id, "fixture").state, "cancelled");
  console.log("PASS 0.9.7 OCR: real Chinese/English, rotation, blank/invalid input, mixed PDF, per-page provenance, cache, bounds, owner isolation, cancellation");
} finally { service.dispose(); }
