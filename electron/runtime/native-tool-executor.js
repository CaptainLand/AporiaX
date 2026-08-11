import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative } from "node:path";
import { applyPatch as applyUnifiedPatch, parsePatch } from "diff";
import {
  MAX_OFFICE_FILE_BYTES,
  OFFICE_CREATE_TOOL_NAMES,
  createOfficeArtifact,
  inspectOfficeArtifact,
  isOfficePath,
} from "../office-tools.js";
import { MAX_ATTACHMENT_BYTES, extractPdfText } from "../attachment-parser.js";
import { executeBrowserTool, isBrowserToolName } from "../browser-runtime.js";

function countExactOccurrences(content, searchText) {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - searchText.length) {
    const index = content.indexOf(searchText, offset);
    if (index === -1) break;
    count += 1;
    offset = index + searchText.length;
  }
  return count;
}

function createAbortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function paginateContent(content, input, maximumChars) {
  const limit = Math.max(1, Math.min(maximumChars, Number(input.limit) || 60_000));
  const hasLineRange = Number.isInteger(input.start_line) || Number.isInteger(input.end_line);
  if (hasLineRange) {
    const lines = String(content).replace(/\r\n/g, "\n").split("\n");
    const startLine = Math.max(1, Number(input.start_line) || 1);
    const endLine = Math.max(startLine, Math.min(lines.length, Number(input.end_line) || startLine + 999));
    const selected = lines.slice(startLine - 1, endLine).join("\n");
    const page = selected.slice(0, limit);
    return {
      content: page,
      startLine,
      endLine: startLine + page.split("\n").length - 1,
      totalLines: lines.length,
      truncated: page.length < selected.length || endLine < lines.length,
      hasMore: page.length < selected.length || endLine < lines.length,
      nextStartLine: page.length < selected.length
        ? startLine + page.split("\n").length - 1
        : endLine < lines.length ? endLine + 1 : null,
    };
  }
  const offset = Math.max(0, Number(input.offset) || 0);
  const page = String(content).slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    content: page,
    offset,
    nextOffset: nextOffset < content.length ? nextOffset : null,
    totalChars: content.length,
    truncated: nextOffset < content.length,
    hasMore: nextOffset < content.length,
  };
}

function unifiedPatchPath(filePatch) {
  const value = filePatch?.newFileName && filePatch.newFileName !== "/dev/null"
    ? filePatch.newFileName
    : filePatch?.oldFileName;
  return String(value || "").replace(/^[ab][\\/]/, "").replace(/\\/g, "/");
}

export function createNativeToolExecutor({
  verifyExistingTarget,
  verifyWritableTarget,
  searchWorkspaceText,
  calculateLineChanges,
  runGitCommand,
  limits = {},
} = {}) {
  for (const [name, value] of Object.entries({
    verifyExistingTarget,
    verifyWritableTarget,
    searchWorkspaceText,
    calculateLineChanges,
    runGitCommand,
  })) {
    if (typeof value !== "function") {
      throw new Error(`Native tool executor requires ${name}.`);
    }
  }

  const maxFileReadChars = Number(limits.maxFileReadChars) || 120_000;
  const maxFileWriteChars = Number(limits.maxFileWriteChars) || 200_000;
  const maxDirectoryEntries = Number(limits.maxDirectoryEntries) || 200;
  const maxCommandChars = Number(limits.maxCommandChars) || 2_000;
  const maxCommandOutputChars = Number(limits.maxCommandOutputChars) || 80_000;
  const maxSearchResults = Number(limits.maxSearchResults) || 200;
  const maxPatchTextChars = Number(limits.maxPatchTextChars) || 120_000;
  const maxPatchedFileChars = Number(limits.maxPatchedFileChars) || maxFileWriteChars * 6;
  const maxGitDiffChars = Number(limits.maxGitDiffChars) || 120_000;

  return async function executeAuthorizedTool({
    toolCall,
    toolName = toolCall.function.name,
    input,
    workspaceRoot,
    signal,
    sandboxExecutor,
    sandboxStatus = null,
    browserRuntime = null,
    processManager = null,
    lspManager = null,
  }) {
    throwIfAborted(signal);

    if (isBrowserToolName(toolName)) {
      return {
        modelResult: await executeBrowserTool(browserRuntime, toolName, input),
      };
    }

    if (toolName === "list_directory") {
      const directoryPath = await verifyExistingTarget(workspaceRoot, input.path);
      const directoryStats = await lstat(directoryPath);
      if (!directoryStats.isDirectory()) {
        throw new Error("The requested path is not a directory.");
      }
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return {
        modelResult: {
          path: input.path,
          entries: entries.slice(0, maxDirectoryEntries).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
          })),
          truncated: entries.length > maxDirectoryEntries,
        },
      };
    }

    if (OFFICE_CREATE_TOOL_NAMES.has(toolName)) {
      const filePath = await verifyWritableTarget(workspaceRoot, input.path);
      let previousBuffer = Buffer.alloc(0);
      let created = true;
      try {
        previousBuffer = await readFile(filePath);
        created = false;
        if (previousBuffer.length > MAX_OFFICE_FILE_BYTES) {
          throw new Error(
            `Existing Office file exceeds the ${Math.floor(MAX_OFFICE_FILE_BYTES / 1_000_000)} MB checkpoint limit.`,
          );
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const generated = await createOfficeArtifact(toolName, input);
      throwIfAborted(signal);
      await writeFile(filePath, generated.buffer);
      return {
        modelResult: {
          path: generated.path,
          bytesWritten: generated.buffer.length,
          created,
          artifact: generated.artifact,
          additions: 0,
          deletions: 0,
        },
        change: {
          path: generated.path,
          beforeContent: previousBuffer.toString("base64"),
          afterContent: generated.buffer.toString("base64"),
          beforeMissing: created,
          afterMissing: false,
          binary: true,
          artifact: generated.artifact,
          created,
          reverted: false,
          additions: 0,
          deletions: 0,
        },
      };
    }

    if (toolName === "inspect_office_file") {
      if (!isOfficePath(input.path)) {
        throw new Error("Only .docx, .pptx, and .xlsx files can be inspected.");
      }
      const filePath = await verifyExistingTarget(workspaceRoot, input.path);
      const fileStats = await lstat(filePath);
      if (!fileStats.isFile()) {
        throw new Error("The requested path is not a file.");
      }
      if (fileStats.size > MAX_OFFICE_FILE_BYTES) {
        throw new Error(
          `Office inspection is limited to ${Math.floor(MAX_OFFICE_FILE_BYTES / 1_000_000)} MB.`,
        );
      }
      const inspection = await inspectOfficeArtifact(input.path, await readFile(filePath));
      return { modelResult: { path: input.path, inspection } };
    }

    if (toolName === "read_file" || toolName === "read_external_file") {
      if (isOfficePath(input.path)) {
        throw new Error("Office files are binary. Use inspect_office_file instead of read_file.");
      }
      let filePath;
      if (toolName === "read_external_file") {
        if (!isAbsolute(input.path) || input.path.includes("\0")) {
          throw new Error("External file path must be absolute.");
        }
        const lexicalStats = await lstat(input.path);
        if (lexicalStats.isSymbolicLink()) {
          throw new Error("External symbolic links are not accepted.");
        }
        filePath = await realpath(input.path);
      } else {
        filePath = await verifyExistingTarget(workspaceRoot, input.path);
      }
      const fileStats = await lstat(filePath);
      if (!fileStats.isFile()) {
        throw new Error("The requested path is not a file.");
      }
      if (extname(input.path).toLowerCase() === ".pdf") {
        if (fileStats.size > MAX_ATTACHMENT_BYTES) {
          throw new Error("PDF reading is limited to 8 MB.");
        }
        const requestedEnd = Math.min(
          1_000_000,
          Math.max(60_000, (Number(input.offset) || 0) + (Number(input.limit) || 60_000)),
        );
        const pdfBuffer = await readFile(filePath);
        const pdf = await extractPdfText(pdfBuffer, {
          maxChars: requestedEnd,
        });
        const page = paginateContent(pdf.content, input, maxFileReadChars);
        return {
          modelResult: {
            path: input.path,
            ...pdf,
            ...page,
            sha256: sha256(pdfBuffer),
            external: toolName === "read_external_file",
            content: pdf.requiresOcr
              ? `${page.content}\n\n[系统提示：该 PDF 没有可提取文本，可能是扫描件，需要 OCR。]`
              : page.content,
          },
        };
      }
      const content = await readFile(filePath, "utf8");
      return {
        modelResult: {
          path: input.path,
          ...paginateContent(content, input, maxFileReadChars),
          sha256: sha256(content),
          external: toolName === "read_external_file",
        },
      };
    }

    if (toolName === "search_text") {
      const maxResults = Number.isInteger(input.max_results)
        ? Math.min(maxSearchResults, Math.max(1, input.max_results))
        : 80;
      return {
        modelResult: await searchWorkspaceText({
          workspaceRoot,
          requestedPath: input.path || ".",
          query: input.query,
          caseSensitive: Boolean(input.case_sensitive),
          maxResults,
          mode: input.mode || "literal",
          includeGlobs: input.include_glob || [],
          excludeGlobs: input.exclude_glob || [],
          signal,
        }),
      };
    }

    if (toolName === "write_file") {
      if (
        typeof input.content !== "string" ||
        input.content.length > maxFileWriteChars
      ) {
        throw new Error(
          `File content must be at most ${maxFileWriteChars} characters.`,
        );
      }
      const filePath = await verifyWritableTarget(workspaceRoot, input.path);
      let previousContent = "";
      let created = true;
      try {
        previousContent = await readFile(filePath, "utf8");
        created = false;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const lineChanges = calculateLineChanges(previousContent, input.content);
      throwIfAborted(signal);
      await writeFile(filePath, input.content, "utf8");
      return {
        modelResult: {
          path: input.path,
          bytesWritten: Buffer.byteLength(input.content, "utf8"),
          created,
          ...lineChanges,
        },
        change: {
          path: input.path,
          beforeContent: previousContent,
          afterContent: input.content,
          beforeMissing: created,
          afterMissing: false,
          created,
          reverted: false,
          ...lineChanges,
        },
      };
    }

    if (toolName === "apply_patch") {
      if (typeof input.patch === "string" && input.patch.trim()) {
        if (input.patch.length > maxPatchTextChars) {
          throw new Error(`Unified patch must be at most ${maxPatchTextChars} characters.`);
        }
        const filePatches = parsePatch(input.patch);
        if (!filePatches.length || filePatches.length > 50) {
          throw new Error("Unified patch must contain between 1 and 50 file patches.");
        }
        const prepared = [];
        for (const filePatch of filePatches) {
          const path = unifiedPatchPath(filePatch);
          if (!path || isAbsolute(path) || path.split("/").includes("..")) {
            throw new Error(`Unsafe unified patch path: ${path || "unknown"}`);
          }
          const filePath = await verifyWritableTarget(workspaceRoot, path);
          let previousContent = "";
          let created = filePatch.oldFileName === "/dev/null";
          const deleted = filePatch.newFileName === "/dev/null";
          try {
            previousContent = await readFile(filePath, "utf8");
            created = false;
          } catch (error) {
            if (error?.code !== "ENOENT" || !created) throw error;
          }
          if (input.expected_sha256 && filePatches.length === 1 && sha256(previousContent) !== input.expected_sha256.toLowerCase()) {
            throw new Error("Patch precondition failed because the file SHA-256 changed.");
          }
          const nextContent = applyUnifiedPatch(previousContent, filePatch);
          if (nextContent === false) {
            throw new Error(`Unified patch context did not match: ${path}`);
          }
          if (nextContent.length > maxPatchedFileChars) {
            throw new Error(`Patched file exceeds ${maxPatchedFileChars} characters: ${path}`);
          }
          const lineChanges = calculateLineChanges(previousContent, nextContent);
          prepared.push({
            path,
            filePath,
            previousContent,
            nextContent,
            created,
            deleted,
            change: {
              path,
              beforeContent: previousContent,
              afterContent: nextContent,
              beforeMissing: created,
              afterMissing: deleted,
              deleted,
              created,
              reverted: false,
              ...lineChanges,
            },
          });
        }
        if (!input.dry_run) {
          const written = [];
          try {
            for (const item of prepared) {
              throwIfAborted(signal);
              if (item.deleted) await rm(item.filePath);
              else await writeFile(item.filePath, item.nextContent, "utf8");
              written.push(item);
            }
          } catch (error) {
            for (const item of written.reverse()) {
              if (item.created) await rm(item.filePath, { force: true }).catch(() => undefined);
              else await writeFile(item.filePath, item.previousContent, "utf8").catch(() => undefined);
            }
            throw error;
          }
        }
        return {
          modelResult: {
            path: prepared.length === 1 ? prepared[0].path : null,
            dryRun: Boolean(input.dry_run),
            files: prepared.map((item) => ({
              path: item.path,
              created: item.created,
              deleted: item.deleted,
              ...calculateLineChanges(item.previousContent, item.nextContent),
            })),
          },
          ...(input.dry_run ? {} : { changes: prepared.map((item) => item.change) }),
        };
      }
      if (
        typeof input.old_text !== "string" ||
        !input.old_text ||
        typeof input.new_text !== "string" ||
        input.old_text.length > maxPatchTextChars ||
        input.new_text.length > maxPatchTextChars
      ) {
        throw new Error(
          `Patch text must be non-empty and at most ${maxPatchTextChars} characters.`,
        );
      }
      const filePath = await verifyWritableTarget(workspaceRoot, input.path);
      const previousContent = await readFile(filePath, "utf8");
      if (input.expected_sha256 && sha256(previousContent) !== input.expected_sha256.toLowerCase()) {
        throw new Error("Patch precondition failed because the file SHA-256 changed.");
      }
      const occurrences = countExactOccurrences(previousContent, input.old_text);
      if (occurrences === 0) {
        throw new Error("Patch failed because old_text was not found.");
      }
      if (!input.replace_all && occurrences !== 1) {
        throw new Error(
          `Patch is ambiguous because old_text occurs ${occurrences} times.`,
        );
      }
      const nextContent = input.replace_all
        ? previousContent.split(input.old_text).join(input.new_text)
        : previousContent.replace(input.old_text, input.new_text);
      if (nextContent.length > maxPatchedFileChars) {
        throw new Error(
          `Patched file must be at most ${maxPatchedFileChars} characters.`,
        );
      }
      const lineChanges = calculateLineChanges(previousContent, nextContent);
      if (!input.dry_run) {
        throwIfAborted(signal);
        await writeFile(filePath, nextContent, "utf8");
      }
      return {
        modelResult: {
          path: input.path,
          replacements: input.replace_all ? occurrences : 1,
          dryRun: Boolean(input.dry_run),
          bytesWritten: Buffer.byteLength(nextContent, "utf8"),
          created: false,
          ...lineChanges,
        },
        ...(input.dry_run ? {} : { change: {
          path: input.path,
          beforeContent: previousContent,
          afterContent: nextContent,
          beforeMissing: false,
          afterMissing: false,
          created: false,
          reverted: false,
          ...lineChanges,
        } }),
      };
    }

    if (toolName === "lsp") {
      if (!lspManager) throw new Error("LSP runtime is unavailable for this task.");
      return { modelResult: await lspManager.execute(input) };
    }

    if (toolName === "run_command") {
      if (
        typeof input.command !== "string" ||
        !input.command.trim() ||
        input.command.length > maxCommandChars
      ) {
        throw new Error(
          `Command must be between 1 and ${maxCommandChars} characters.`,
        );
      }
      const commandDirectory = await verifyExistingTarget(
        workspaceRoot,
        input.cwd || ".",
      );
      const commandDirectoryStats = await lstat(commandDirectory);
      if (!commandDirectoryStats.isDirectory()) {
        throw new Error("The command working directory is not a directory.");
      }
      const result = await sandboxExecutor({
        command: input.command.trim(),
        workspaceRoot,
        cwd: commandDirectory,
        signal,
        sandboxStatus,
      });
      return {
        modelResult: {
          command: input.command.trim(),
          cwd: input.cwd || ".",
          ...result,
        },
      };
    }

    if (toolName === "start_process") {
      if (!processManager) throw new Error("Persistent terminal runtime is unavailable.");
      if (typeof input.command !== "string" || !input.command.trim() || input.command.length > maxCommandChars) {
        throw new Error(`Command must be between 1 and ${maxCommandChars} characters.`);
      }
      const commandDirectory = await verifyExistingTarget(workspaceRoot, input.cwd || ".");
      if (!(await lstat(commandDirectory)).isDirectory()) {
        throw new Error("The process working directory is not a directory.");
      }
      return {
        modelResult: processManager.start({
          command: input.command.trim(),
          cwd: commandDirectory,
        }),
      };
    }

    if (toolName === "read_process") {
      if (!processManager) throw new Error("Persistent terminal runtime is unavailable.");
      return {
        modelResult: processManager.read({
          processId: input.process_id,
          cursor: input.cursor,
          maxChars: input.max_chars,
        }),
      };
    }

    if (toolName === "write_stdin") {
      if (!processManager) throw new Error("Persistent terminal runtime is unavailable.");
      return {
        modelResult: processManager.write({
          processId: input.process_id,
          data: input.data,
          close: input.close,
        }),
      };
    }

    if (toolName === "kill_process") {
      if (!processManager) throw new Error("Persistent terminal runtime is unavailable.");
      return { modelResult: await processManager.kill(input.process_id) };
    }

    if (toolName === "git_status") {
      const result = await runGitCommand({
        args: ["status", "--short", "--branch", "--untracked-files=all"],
        cwd: workspaceRoot,
        signal,
      });
      if (result.exitCode !== 0) {
        if (/not a git repository/i.test(result.stderr)) {
          return {
            modelResult: {
              applicable: false,
              skipped: true,
              reason: "当前工作区不是 Git 仓库",
            },
          };
        }
        throw new Error(
          result.stderr.trim() ||
            "Unable to read Git status. The workspace may not be a repository.",
        );
      }
      return {
        modelResult: {
          branchAndChanges: result.stdout.trim(),
          clean: !result.stdout
            .split(/\r?\n/)
            .some((line) => line && !line.startsWith("##")),
          truncated: result.stdout.length >= maxCommandOutputChars,
        },
      };
    }

    if (toolName === "git_diff") {
      let requestedPath = null;
      if (input.path !== undefined) {
        if (
          typeof input.path !== "string" ||
          !input.path.trim() ||
          input.path.includes("\0")
        ) {
          throw new Error("Git diff path must be a workspace-relative path.");
        }
        const verifiedPath = await verifyExistingTarget(workspaceRoot, input.path);
        requestedPath = relative(workspaceRoot, verifiedPath).replace(/\\/g, "/");
      }
      const args = [
        "diff",
        "--no-ext-diff",
        "--no-color",
        ...(input.staged ? ["--cached"] : []),
        ...(requestedPath ? ["--", requestedPath] : []),
      ];
      const result = await runGitCommand({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() ||
            "Unable to read Git diff. The workspace may not be a repository.",
        );
      }
      return {
        modelResult: {
          path: requestedPath,
          staged: Boolean(input.staged),
          diff: result.stdout.slice(0, maxGitDiffChars),
          truncated: result.stdout.length > maxGitDiffChars,
        },
      };
    }

    throw new Error(`Unsupported tool: ${toolName}`);
  };
}
