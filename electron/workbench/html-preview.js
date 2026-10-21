import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { getVerifiedWorkspaceRoot, verifyExistingTarget } from "../runtime/workspace-runtime.js";

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
  ".ogg": "audio/ogg", ".webm": "video/webm",
};

// A private, read-only origin for one selected HTML file and its sibling assets.
// Never expose the app's file:// origin, desktop bridge or the whole workspace.
export async function createHtmlPreview(workspacePath, requestedPath) {
  const workspace = await getVerifiedWorkspaceRoot(workspacePath);
  const path = await verifyExistingTarget(workspace, requestedPath);
  const info = await stat(path);
  if (!/\.html?$/i.test(path) || !info.isFile()) throw new Error("请选择工作区内的 HTML 文件。");
  if (info.size > 32 * 1024 * 1024) throw new Error("HTML 预览仅支持不超过 32 MB 的文件。");
  const root = dirname(path);
  const prefix = `/${randomBytes(24).toString("hex")}/`;
  let origin;
  const server = createServer(async (request, response) => {
    const fail = (status) => { response.writeHead(status, { "Cache-Control": "no-store" }); response.end(); };
    try {
      if (request.headers.host !== new URL(origin).host) return fail(403);
      if (request.method !== "GET" && request.method !== "HEAD") return fail(405);
      if (request.headers.origin && request.headers.origin !== origin) return fail(403);
      if (request.headers["sec-fetch-site"] === "cross-site") return fail(403);
      // Inspect the raw path before URL normalization can hide traversal.
      const pathname = decodeURIComponent(String(request.url || "").split("?")[0]);
      if (!pathname.startsWith(prefix)) return fail(404);
      const relative = pathname.slice(prefix.length);
      const segments = relative.split("/");
      if (!relative || /[\\\x00-\x1f\x7f:]/.test(relative) || segments.some(part => !part || part.startsWith("."))) return fail(403);
      if (segments.some(part => /^(?:credentials?|secrets?|tokens?|session|auth)(?:[._-]|$)/i.test(part))) return fail(403);
      const mime = MIME[extname(relative).toLowerCase()];
      if (!mime) return fail(403);
      const target = await verifyExistingTarget(root, relative);
      const info = await stat(target);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) return fail(403);
      // No directory listings, arbitrary file types or writes.
      const data = request.method === "HEAD" ? null : await readFile(target);
      response.writeHead(200, {
        "Content-Type": mime, "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'",
      });
      response.end(data);
    } catch { if (!response.headersSent) fail(404); else response.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  let closing;
  return {
    path, url: `${origin}${prefix}${encodeURIComponent(basename(path))}`,
    close() {
      if (!closing) closing = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      return closing;
    },
  };
}
