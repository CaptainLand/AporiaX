import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const OCR_MODELS = Object.freeze({
  eng: { size: 2952873, sha256: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91" },
  chi_sim: { size: 1718768, sha256: "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c" },
});
const digest = (data) => createHash("sha256").update(data).digest("hex");
const MAX_INPUT = 16 * 1024 * 1024;
export function createOcrService({ directory, fetchImpl = fetch, workerFactory = (path, options) => new Worker(path, options) }) {
  const jobs = new Map(), cache = new Map();
  let preparing = null;
  async function modelReady(lang) {
    try { const bytes = await readFile(join(directory, `${lang}.traineddata.gz`)); return bytes.length === OCR_MODELS[lang].size && digest(bytes) === OCR_MODELS[lang].sha256; } catch { return false; }
  }
  async function status() {
    const missing = [];
    for (const lang of Object.keys(OCR_MODELS)) if (!await modelReady(lang)) missing.push(lang);
    return { ready: !missing.length, missing, downloadBytes: missing.reduce((sum, lang) => sum + OCR_MODELS[lang].size, 0) };
  }
  async function prepare() {
    if (preparing) return preparing;
    preparing = (async () => {
      await mkdir(directory, { recursive: true });
      for (const [lang, expected] of Object.entries(OCR_MODELS)) {
        if (await modelReady(lang)) continue;
        const response = await fetchImpl(`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int/${lang}.traineddata.gz`, { signal: AbortSignal.timeout(45000), redirect: "error" });
        if (!response.ok) throw new Error(`语言资源下载失败 (${response.status})；可稍后重试。`);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > expected.size) throw new Error("语言资源大小不匹配。"); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new Error("语言资源完整性校验失败，未安装。");
        const temporary = join(directory, `${lang}.${randomUUID()}.tmp`);
        try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, join(directory, `${lang}.traineddata.gz`)); }
        finally { await rm(temporary, { force: true }); }
      }
      return status();
    })();
    try { return await preparing; } finally { preparing = null; }
  }
  function publicJob(job) { const { worker, timer, cacheKey, owner, ...value } = job; return value; }
  function owned(id, owner) { const job = jobs.get(id); if (!job || job.owner !== owner) throw new Error("识别任务已失效，请重新开始。"); return job; }
  function stop(job, state = "cancelled", error = "") {
    if (job.state !== "running") return;
    job.state = state; job.error = error; clearTimeout(job.timer); void job.worker?.terminate(); job.worker = null;
  }
  async function start(input, owner) {
    if ([...jobs.values()].some((job) => job.state === "running")) throw new Error("已有本地 OCR 正在运行，请等待或取消后再试。");
    const bytes = Buffer.from(input.data || []);
    if (!bytes.length || bytes.length > MAX_INPUT) throw new Error("识别仅支持 16 MiB 内的图片或 PDF。");
    const pdf = bytes.subarray(0, 5).toString() === "%PDF-";
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP";
    if (!pdf && !png && !jpeg && !webp) throw new Error("仅支持 PNG、JPEG、WebP 和 PDF，不支持 SVG 或其他可执行格式。");
    const from = Number(input.from ?? 1), to = Number(input.to ?? from);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 240 || to - from >= 20 || !pdf && (from !== 1 || to !== 1)) throw new Error("页码范围无效：每次最多 20 页，页码为 1–240；图片只有第 1 页。");
    const language = ["eng", "chi_sim", "chi_sim+eng"].includes(input.language) ? input.language : "chi_sim+eng";
    const rotation = Number(input.rotation || 0);
    if (![0, 90, 180, 270].includes(rotation)) throw new Error("旋转角度无效。");
    if (!(await status()).ready) throw new Error("请先下载本地中英文识别资源；不会上传文档。");
    // Recheck after asynchronous resource validation to avoid simultaneous starts.
    if ([...jobs.values()].some((job) => job.state === "running")) throw new Error("已有 OCR 正在运行。");
    for (const [id, job] of jobs) if (job.state !== "running" && jobs.size >= 6) jobs.delete(id);
    const name = String(input.name || (pdf ? "document.pdf" : "image.png")).replace(/[\r\n\t]/g, " ").slice(0, 160);
    const cacheKey = digest(bytes) + `:v2:${from}:${to}:${language}:${rotation}`;
    const cached = cache.get(cacheKey);
    const job = { id: randomUUID(), owner, name, state: cached ? "completed" : "running", pages: cached ? structuredClone(cached) : [], completed: cached?.length || 0, total: to - from + 1, progress: 0, cached: Boolean(cached), cacheKey };
    jobs.set(job.id, job);
    if (cached) return publicJob(job);
    const workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url)).replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
    try { job.worker = workerFactory(workerPath, { workerData: { data: bytes, pdf, from, to, language, rotation, directory }, resourceLimits: { maxOldGenerationSizeMb: 256 } }); }
    catch (error) { job.state = "failed"; job.error = error.message; return publicJob(job); }
    job.timer = setTimeout(() => stop(job, "failed", "识别超过 5 分钟，已停止；请缩小页码范围。"), 300000);
    job.worker.on("message", (message) => {
      if (job.state !== "running") return;
      if (message.type === "progress") { job.page = message.page; job.progress = message.progress; }
      if (message.type === "page") { job.pages.push(message.page); job.completed = job.pages.length; }
      if (message.type === "done") {
        job.state = job.pages.some((page) => page.error || !page.text.trim()) ? "partial" : "completed";
        job.totalPages = message.totalPages; clearTimeout(job.timer);
        if (job.state === "completed") { cache.set(cacheKey, structuredClone(job.pages)); while (cache.size > 3) cache.delete(cache.keys().next().value); }
        void job.worker.terminate(); job.worker = null;
      }
      if (message.type === "error") stop(job, "failed", message.error);
    });
    job.worker.on("error", (error) => stop(job, "failed", error.message));
    job.worker.on("exit", (code) => { if (job.state === "running") stop(job, "failed", `识别进程提前退出 (${code})。`); });
    return publicJob(job);
  }
  return { status, prepare, start, get: (id, owner) => publicJob(owned(id, owner)),
    cancel(id, owner) { const job = owned(id, owner); stop(job); return publicJob(job); },
    disposeOwner(owner) { for (const [id, job] of jobs) if (job.owner === owner) { stop(job); jobs.delete(id); } },
    dispose() { for (const job of jobs.values()) stop(job); jobs.clear(); cache.clear(); },
  };
}
