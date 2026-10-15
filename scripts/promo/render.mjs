// Renders scripts/promo/film.html frame by frame and encodes the promo with ffmpeg.
// Usage: node scripts/promo/render.mjs [--fps 30] [--preview] [--short]
//   --preview  writes a few key stills instead of the full video
//   --short    15s cut: opening, multi-agent, trace, end card
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const fps = Number(args[args.indexOf("--fps") + 1]) || 30;
const OUT = "output/promo";
const FRAMES = path.join(OUT, "frames");
const film = pathToFileURL(path.resolve("scripts/promo/film.html")).href;

// 15s cut maps output time onto film time segments.
const SHORT = [[0, 3.4], [10.2, 14.4], [19.7, 23.4], [37.5, 41.2]];
const shortLength = SHORT.reduce((sum, [a, b]) => sum + (b - a), 0);
const filmTime = (t) => {
  let acc = 0;
  for (const [a, b] of SHORT) { if (t < acc + (b - a)) return a + (t - acc); acc += b - a; }
  return SHORT.at(-1)[1];
};

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err = (err + chunk).slice(-4000); });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err}`)));
  });
}

const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true, args: ["--allow-file-access-from-files"] });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.log("pageerror", error.message));
  await page.goto(film, { waitUntil: "load" });
  await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))));
  await page.waitForTimeout(300);
  const duration = flag("--short") ? shortLength : await page.evaluate(() => window.DURATION);

  if (flag("--preview")) {
    await mkdir(path.join(OUT, "preview"), { recursive: true });
    const scenes = await page.evaluate(() => window.SCENES);
    for (const [name, [a, b]] of Object.entries(scenes)) {
      const t = a + (b - a) * 0.6;
      await page.evaluate((time) => window.render(time), t);
      await page.screenshot({ path: path.join(OUT, "preview", `${String(Math.round(a * 10)).padStart(3, "0")}-${name}.png`) });
    }
    console.log("preview stills written");
  } else {
    // Frames stream straight into ffmpeg as JPEG: no frame folder on disk and
    // no image2 demuxer buffering, which ran out of memory on long cuts.
    await rm(FRAMES, { recursive: true, force: true });
    const total = Math.round(duration * fps);
    const name = flag("--short") ? "aporiax-promo-15s" : "aporiax-promo";
    const music = path.join(OUT, "placeholder-music.wav");
    await makePlaceholderMusic(music, duration);
    const ffmpeg = spawn("ffmpeg", ["-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-i", music,
      "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-threads", "4", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", "192k", "-t", String(duration), path.join(OUT, `${name}.mp4`)], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    ffmpeg.stderr.on("data", (chunk) => { err = (err + chunk).slice(-4000); });
    const done = new Promise((resolve, reject) => ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${err}`))));
    for (let i = 0; i < total; i++) {
      const t = i / fps;
      await page.evaluate((time) => window.render(time), flag("--short") ? filmTime(t) : t);
      const frame = await page.screenshot({ type: "jpeg", quality: 95 });
      if (!ffmpeg.stdin.write(frame)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
      if (i % (fps * 5) === 0) console.log(`frame ${i}/${total}`);
    }
    ffmpeg.stdin.end();
    await done;
    console.log(`wrote ${OUT}/${name}.mp4 (${duration.toFixed(1)}s @ ${fps}fps)`);
  }
} finally { await browser.close(); }

// Placeholder bed: soft synth pad (A minor 9) with a gentle pulse and fades.
// Replace output/promo/placeholder-music.wav with licensed music for release.
async function makePlaceholderMusic(file, seconds) {
  const rate = 44100, n = Math.ceil(seconds * rate);
  const data = Buffer.alloc(44 + n * 4);
  const chords = [[220, 261.63, 329.63, 493.88], [174.61, 261.63, 349.23, 440], [196, 246.94, 293.66, 392], [164.81, 246.94, 329.63, 392]];
  const bar = 60 / 96 * 4;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const chord = chords[Math.floor(t / bar) % chords.length];
    const local = (t % bar) / bar;
    const swell = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, local * 1.2));
    let s = 0;
    for (const f of chord) s += Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2.003 * t) * 0.12;
    const beat = (t * 96 / 60) % 1;
    const pulse = Math.exp(-beat * 9) * Math.sin(2 * Math.PI * 55 * t) * 0.9;
    const fade = Math.min(1, t / 1.5, (seconds - t) / 2.5);
    const v = (s * 0.06 * swell + pulse * 0.08) * Math.max(0, fade);
    const sample = Math.max(-1, Math.min(1, v)) * 32767;
    data.writeInt16LE(sample | 0, 44 + i * 4);
    data.writeInt16LE(sample | 0, 46 + i * 4);
  }
  data.write("RIFF", 0); data.writeUInt32LE(36 + n * 4, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(n * 4, 40);
  await writeFile(file, data);
}
