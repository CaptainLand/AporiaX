import { protocol } from "electron";
import { isBlobHash } from "./task-history-store.js";

export const BLOB_SCHEME = "aporiax-blob";

export function registerBlobScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BLOB_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function attachBlobProtocol(store) {
  if (!store?.readBlob) return;
  protocol.handle(BLOB_SCHEME, async (request) => {
    try {
      const hash = new URL(request.url).hostname;
      if (!isBlobHash(hash)) {
        return new Response("Not found", { status: 404 });
      }
      const blob = await store.readBlob(hash);
      return new Response(blob.buffer, {
        headers: {
          "Content-Type": blob.type || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
