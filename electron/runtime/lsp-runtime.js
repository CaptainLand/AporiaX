import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHostFallbackEnvironment } from "../sandbox-runtime.js";
import { describeLanguageServers, resolveLanguageServerCommand } from "./lsp-installer.js";

const require = createRequire(import.meta.url);
const REQUEST_TIMEOUT_MS = 12_000;
const DIAGNOSTIC_WAIT_MS = 2_500;
const MAX_STDERR_CHARS = 40_000;

const LANGUAGE_SPECS = Object.freeze([
  {
    id: "typescript",
    extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]),
    languageId(extension) {
      if ([".ts", ".mts", ".cts"].includes(extension)) return "typescript";
      if (extension === ".tsx") return "typescriptreact";
      if (extension === ".jsx") return "javascriptreact";
      return "javascript";
    },
    command() {
      let cli = "";
      for (const candidate of [
        "typescript-language-server/lib/cli.mjs",
        "typescript-language-server",
      ]) {
        try {
          cli = require.resolve(candidate);
          break;
        } catch {
          // Try the next package entry before falling back to PATH.
        }
      }
      if (cli) {
        return {
          program: process.execPath,
          args: [cli, "--stdio"],
          env: {
            ...createHostFallbackEnvironment(process.env, "lsp-server"),
            ELECTRON_RUN_AS_NODE: "1",
          },
          source: "bundled",
        };
      }
      return {
        program: "typescript-language-server",
        args: ["--stdio"],
        env: createHostFallbackEnvironment(process.env, "lsp-server"),
        source: "path",
      };
    },
  },
  {
    id: "python",
    extensions: new Set([".py", ".pyi"]),
    languageId: () => "python",
    command: () => externalLanguageServerCommand("python", ["--stdio"]),
  },
  {
    id: "rust",
    extensions: new Set([".rs"]),
    languageId: () => "rust",
    command: () => externalLanguageServerCommand("rust", []),
  },
  {
    id: "go",
    extensions: new Set([".go"]),
    languageId: () => "go",
    command: () => externalLanguageServerCommand("go", ["serve"]),
  },
  {
    id: "clangd",
    extensions: new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]),
    languageId(extension) {
      return [".c", ".h"].includes(extension) ? "c" : "cpp";
    },
    command: () => externalLanguageServerCommand("clangd", ["--background-index"]),
  },
]);

function externalLanguageServerCommand(language, args) {
  const resolved = resolveLanguageServerCommand(language, args);
  if (!resolved) {
    throw new Error(`Language server for ${language} is not installed. Use lsp_install to install it.`);
  }
  return {
    program: resolved.program,
    args: resolved.args,
    env: {
      ...createHostFallbackEnvironment(process.env, "lsp-server"),
      ...(resolved.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    source: resolved.source,
  };
}

function createAbortError() {
  const error = new Error("The LSP operation was interrupted.");
  error.name = "AbortError";
  return error;
}

function trim(value, maximum = MAX_STDERR_CHARS) {
  if (value.length <= maximum) return value;
  return value.slice(-maximum);
}

function isPathInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function workspaceFile(workspaceRoot, requestedPath) {
  const path = String(requestedPath || "").trim();
  if (!path || path.includes("\0")) throw new Error("LSP requires a workspace-relative file path.");
  const absolute = resolve(workspaceRoot, path);
  if (!isPathInside(workspaceRoot, absolute)) {
    throw new Error("LSP path escapes the authorized workspace.");
  }
  return absolute;
}

function specForPath(filePath) {
  const extension = extname(filePath).toLowerCase();
  const spec = LANGUAGE_SPECS.find((candidate) => candidate.extensions.has(extension));
  if (!spec) {
    throw new Error(`No configured LSP server for ${extension || "this file type"}.`);
  }
  return { spec, extension };
}

function normalizePosition(input) {
  const line = Math.max(1, Number(input?.line) || 1);
  const character = Math.max(1, Number(input?.character) || 1);
  return { line: line - 1, character: character - 1 };
}

function pathFromUri(workspaceRoot, uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return uri;
  try {
    const absolute = fileURLToPath(uri);
    if (!isPathInside(workspaceRoot, absolute)) return uri;
    return relative(workspaceRoot, absolute).replace(/\\/g, "/") || ".";
  } catch {
    return uri;
  }
}

function normalizeLspValue(workspaceRoot, value) {
  if (Array.isArray(value)) return value.map((item) => normalizeLspValue(workspaceRoot, item));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (["uri", "targetUri"].includes(key) && typeof item === "string") {
      output[key === "targetUri" ? "targetPath" : "path"] = pathFromUri(workspaceRoot, item);
      continue;
    }
    output[key] = normalizeLspValue(workspaceRoot, item);
  }
  return output;
}

class JsonRpcConnection {
  constructor({ command, cwd, signal, onNotification, onStderr }) {
    this.command = command;
    this.cwd = cwd;
    this.signal = signal;
    this.onNotification = onNotification;
    this.onStderr = onStderr;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.child = null;
  }

  async start() {
    if (this.signal?.aborted) throw createAbortError();
    this.child = spawn(this.command.program, this.command.args, {
      cwd: this.cwd,
      env: this.command.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise((resolveStart, rejectStart) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.child?.removeListener("spawn", handleSpawn);
        this.child?.removeListener("error", handleError);
        callback(value);
      };
      const handleSpawn = () => finish(resolveStart);
      const handleError = (error) => {
        const message = error?.code === "ENOENT"
          ? `Language server executable not found: ${this.command.program}`
          : error?.message || "Unable to start language server.";
        finish(rejectStart, new Error(message));
      };
      this.child.once("spawn", handleSpawn);
      this.child.once("error", handleError);
    });
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => this.onStderr?.(chunk.toString("utf8")));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code, signalName) => {
      this.closed = true;
      this.failAll(new Error(`Language server exited (${code ?? signalName ?? "unknown"}).`));
    });
    this.signal?.addEventListener("abort", () => this.close(true), { once: true });
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const payload = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }

  handle(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message || "LSP request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message?.method) this.onNotification?.(message.method, message.params);
  }

  send(message) {
    if (!this.child?.stdin?.writable || this.closed) {
      throw new Error("Language server connection is closed.");
    }
    const payload = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(force = false) {
    if (!this.child || this.closed) return;
    if (!force) {
      try {
        await this.request("shutdown", {}, 2_000);
        this.notify("exit", {});
      } catch {
        // Fall through to process termination.
      }
    }
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      // Process may already be gone.
    }
    this.failAll(new Error("Language server connection closed."));
  }
}

class LspSession {
  constructor({ workspaceRoot, spec, extension, signal, emit }) {
    this.workspaceRoot = workspaceRoot;
    this.spec = spec;
    this.extension = extension;
    this.signal = signal;
    this.emit = emit;
    this.connection = null;
    this.command = null;
    this.openDocuments = new Map();
    this.diagnostics = new Map();
    this.diagnosticRevision = new Map();
    this.stderr = "";
    this.startedAt = null;
  }

  async start() {
    this.command = this.spec.command();
    this.connection = new JsonRpcConnection({
      command: this.command,
      cwd: this.workspaceRoot,
      signal: this.signal,
      onNotification: (method, params) => {
        if (method !== "textDocument/publishDiagnostics" || !params?.uri) return;
        this.diagnostics.set(params.uri, Array.isArray(params.diagnostics) ? params.diagnostics : []);
        this.diagnosticRevision.set(params.uri, (this.diagnosticRevision.get(params.uri) || 0) + 1);
        this.emit?.({
          type: "lsp.diagnostics",
          server: this.spec.id,
          path: pathFromUri(this.workspaceRoot, params.uri),
          count: this.diagnostics.get(params.uri).length,
        });
      },
      onStderr: (text) => {
        this.stderr = trim(this.stderr + text);
      },
    });
    await this.connection.start();
    const rootUri = pathToFileURL(this.workspaceRoot).href;
    const result = await this.connection.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "AporiaX", version: "0.6.5" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: this.workspaceRoot.split(/[\\/]/).at(-1) || "workspace" }],
      capabilities: {
        workspace: {
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
      },
      initializationOptions: {},
    });
    this.connection.notify("initialized", {});
    this.startedAt = new Date().toISOString();
    this.emit?.({
      type: "lsp.started",
      server: this.spec.id,
      source: this.command.source,
      capabilities: Object.keys(result?.capabilities || {}),
    });
    return result?.capabilities || {};
  }

  async syncDocument(filePath, extension) {
    if (this.signal?.aborted) throw createAbortError();
    const content = await readFile(filePath, "utf8");
    const uri = pathToFileURL(filePath).href;
    const existing = this.openDocuments.get(uri);
    const languageId = this.spec.languageId(extension);
    if (!existing) {
      const document = { version: 1, content, languageId };
      this.openDocuments.set(uri, document);
      this.connection.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: document.version, text: content },
      });
    } else if (existing.content !== content) {
      existing.version += 1;
      existing.content = content;
      this.connection.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: content }],
      });
    }
    return { uri, content, document: this.openDocuments.get(uri) };
  }

  async waitForDiagnostics(uri, previousRevision) {
    if ((this.diagnosticRevision.get(uri) || 0) > previousRevision) return;
    const deadline = Date.now() + DIAGNOSTIC_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.signal?.aborted) throw createAbortError();
      if ((this.diagnosticRevision.get(uri) || 0) > previousRevision) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  status() {
    return {
      id: this.spec.id,
      active: Boolean(this.connection && !this.connection.closed),
      source: this.command?.source || null,
      program: this.command?.program || null,
      startedAt: this.startedAt,
      openDocuments: this.openDocuments.size,
      stderr: this.stderr.slice(-2_000),
    };
  }

  async close() {
    await this.connection?.close().catch(() => undefined);
  }
}

export function createLspManager({ workspaceRoot, emit = () => {}, signal } = {}) {
  if (!workspaceRoot) throw new Error("LSP manager requires a workspace root.");
  const sessions = new Map();

  async function sessionForPath(requestedPath) {
    const filePath = workspaceFile(workspaceRoot, requestedPath);
    const { spec, extension } = specForPath(filePath);
    let session = sessions.get(spec.id);
    if (!session) {
      session = new LspSession({ workspaceRoot, spec, extension, signal, emit });
      sessions.set(spec.id, session);
      try {
        await session.start();
      } catch (error) {
        sessions.delete(spec.id);
        throw error;
      }
    }
    return { session, filePath, extension };
  }

  return {
    async execute(input = {}) {
      const operation = String(input.operation || "status");
      if (operation === "status") {
        return {
          supported: (() => {
            const availability = new Map(describeLanguageServers().map((item) => [item.id, item]));
            return LANGUAGE_SPECS.map((spec) => {
              if (spec.id === "typescript") {
                return {
                  id: spec.id,
                  extensions: [...spec.extensions],
                  bundled: true,
                  available: true,
                  source: "bundled",
                  installable: false,
                  installer: null,
                };
              }
              return {
                id: spec.id,
                extensions: [...spec.extensions],
                bundled: false,
                ...(availability.get(spec.id) || { available: false, installable: true }),
              };
            });
          })(),
          sessions: [...sessions.values()].map((session) => session.status()),
        };
      }
      const { session, filePath, extension } = await sessionForPath(input.path);
      const synced = await session.syncDocument(filePath, extension);
      const textDocument = { uri: synced.uri };

      if (operation === "diagnostics") {
        const previousRevision = session.diagnosticRevision.get(synced.uri) || 0;
        session.connection.notify("textDocument/didSave", { textDocument, text: synced.content });
        await session.waitForDiagnostics(synced.uri, previousRevision);
        const diagnostics = session.diagnostics.get(synced.uri) || [];
        const severityCounts = { error: 0, warning: 0, information: 0, hint: 0, unknown: 0 };
        for (const diagnostic of diagnostics) {
          const key = diagnostic.severity === 1
            ? "error"
            : diagnostic.severity === 2
              ? "warning"
              : diagnostic.severity === 3
                ? "information"
                : diagnostic.severity === 4
                  ? "hint"
                  : "unknown";
          severityCounts[key] += 1;
        }
        return {
          operation,
          server: session.spec.id,
          path: String(input.path),
          count: diagnostics.length,
          severityCounts,
          diagnostics: normalizeLspValue(workspaceRoot, diagnostics),
        };
      }

      if (operation === "document_symbols") {
        const result = await session.connection.request("textDocument/documentSymbol", { textDocument });
        return { operation, server: session.spec.id, path: String(input.path), symbols: normalizeLspValue(workspaceRoot, result || []) };
      }

      if (operation === "workspace_symbols") {
        const query = String(input.query || "").slice(0, 500);
        const result = await session.connection.request("workspace/symbol", { query });
        return { operation, server: session.spec.id, query, symbols: normalizeLspValue(workspaceRoot, result || []) };
      }

      const position = normalizePosition(input);
      if (operation === "definition") {
        const result = await session.connection.request("textDocument/definition", { textDocument, position });
        return { operation, server: session.spec.id, path: String(input.path), position: { line: position.line + 1, character: position.character + 1 }, locations: normalizeLspValue(workspaceRoot, result || []) };
      }
      if (operation === "references") {
        const result = await session.connection.request("textDocument/references", {
          textDocument,
          position,
          context: { includeDeclaration: input.include_declaration !== false },
        });
        return { operation, server: session.spec.id, path: String(input.path), position: { line: position.line + 1, character: position.character + 1 }, locations: normalizeLspValue(workspaceRoot, result || []) };
      }
      if (operation === "hover") {
        const result = await session.connection.request("textDocument/hover", { textDocument, position });
        return { operation, server: session.spec.id, path: String(input.path), position: { line: position.line + 1, character: position.character + 1 }, hover: normalizeLspValue(workspaceRoot, result) };
      }
      throw new Error(`Unsupported LSP operation: ${operation}`);
    },

    status() {
      return [...sessions.values()].map((session) => session.status());
    },

    async closeAll() {
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
    },
  };
}
