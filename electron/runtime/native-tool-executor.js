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
import {
  parseGitHubJson,
  runGitHubCli as defaultRunGitHubCli,
} from "./github-runtime.js";
import { installLanguageServer as defaultInstallLanguageServer } from "./lsp-installer.js";

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

function normalizeGitPath(value) {
  const path = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || isAbsolute(path) || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error(`Unsafe Git path: ${path || "unknown"}`);
  }
  return path;
}

function normalizeGitToken(value, label, fallback = "") {
  const token = String(value || fallback).trim();
  if (!token || token.startsWith("-") || !/^[A-Za-z0-9._\/-]+$/.test(token)) {
    throw new Error(`Invalid ${label}.`);
  }
  return token;
}

function normalizeGitRemoteUrl(value) {
  const url = String(value || "").trim();
  if (!url || url.length > 2048 || url.startsWith("-") || /[\0\r\n]/.test(url)) {
    throw new Error("Invalid Git remote URL.");
  }
  return url;
}

function normalizeGitHubRepoName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  if (name.startsWith("-") || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(name)) {
    throw new Error("Invalid GitHub repository name.");
  }
  return name;
}

export function createNativeToolExecutor({
  verifyExistingTarget,
  verifyWritableTarget,
  searchWorkspaceText,
  calculateLineChanges,
  runGitCommand,
  runGitHubCli = defaultRunGitHubCli,
  installLanguageServer = defaultInstallLanguageServer,
  limits = {},
} = {}) {
  for (const [name, value] of Object.entries({
    verifyExistingTarget,
    verifyWritableTarget,
    searchWorkspaceText,
    calculateLineChanges,
    runGitCommand,
    runGitHubCli,
    installLanguageServer,
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

    if (toolName === "lsp_install") {
      return { modelResult: await installLanguageServer({ language: input.language, signal }) };
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


    if (toolName === "git_log") {
      const maxCount = Math.max(1, Math.min(100, Number(input.max_count) || 20));
      const result = await runGitCommand({ args: ["log", "--oneline", "--decorate", "--max-count=" + maxCount], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read Git log.");
      return { modelResult: { log: result.stdout.trim(), maxCount } };
    }

    if (toolName === "git_init") {
      const existing = await runGitCommand({ args: ["rev-parse", "--is-inside-work-tree"], cwd: workspaceRoot, signal });
      if (existing.exitCode === 0 && existing.stdout.trim() === "true") {
        return { modelResult: { initialized: false, alreadyRepository: true } };
      }
      const initialBranch = normalizeGitToken(input.initial_branch, "initial branch", "main");
      let result = await runGitCommand({ args: ["init", "-b", initialBranch], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0 && /unknown option|usage:/i.test(result.stderr)) {
        result = await runGitCommand({ args: ["init"], cwd: workspaceRoot, signal });
        if (result.exitCode === 0) {
          const rename = await runGitCommand({ args: ["branch", "-M", initialBranch], cwd: workspaceRoot, signal });
          if (rename.exitCode !== 0) throw new Error(rename.stderr.trim() || "Unable to set the initial Git branch.");
        }
      }
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to initialize Git repository.");
      return { modelResult: { initialized: true, alreadyRepository: false, initialBranch, output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "git_stage") {
      const paths = [...new Set((Array.isArray(input.paths) ? input.paths : []).map(normalizeGitPath))];
      if (!paths.length) throw new Error("git_stage requires at least one explicit path.");
      const staged = await runGitCommand({ args: ["add", "--", ...paths], cwd: workspaceRoot, signal });
      if (staged.exitCode !== 0) throw new Error(staged.stderr.trim() || "Unable to stage Git paths.");
      const summary = await runGitCommand({ args: ["diff", "--cached", "--name-status"], cwd: workspaceRoot, signal });
      return { modelResult: { paths, staged: summary.stdout.trim() } };
    }

    if (toolName === "git_commit") {
      const message = String(input.message || "").trim();
      if (!message || message.length > 4_000) throw new Error("Commit message must be between 1 and 4000 characters.");
      const stagedCheck = await runGitCommand({ args: ["diff", "--cached", "--quiet"], cwd: workspaceRoot, signal });
      if (stagedCheck.exitCode === 0) throw new Error("No staged changes are available to commit. Use git_stage first.");
      if (stagedCheck.exitCode !== 1) throw new Error(stagedCheck.stderr.trim() || "Unable to inspect staged changes.");
      const result = await runGitCommand({ args: ["commit", "-m", message], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git commit failed.");
      return { modelResult: { committed: true, message, output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "git_create_branch") {
      const name = normalizeGitToken(input.name, "branch name");
      const check = await runGitCommand({ args: ["check-ref-format", "--branch", name], cwd: workspaceRoot, signal });
      if (check.exitCode !== 0) throw new Error(check.stderr.trim() || "Invalid Git branch name.");
      const result = await runGitCommand({ args: ["switch", "-c", name], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to create Git branch.");
      return { modelResult: { created: true, branch: name, output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "git_remote_list") {
      const result = await runGitCommand({ args: ["remote", "-v"], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to list Git remotes.");
      return { modelResult: { remotes: result.stdout.trim() } };
    }

    if (toolName === "git_remote_add") {
      const remote = normalizeGitToken(input.remote, "remote name");
      const url = normalizeGitRemoteUrl(input.url);
      const result = await runGitCommand({ args: ["remote", "add", remote, url], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to add Git remote.");
      return { modelResult: { added: true, remote, url } };
    }

    if (toolName === "git_pull") {
      const status = await runGitCommand({ args: ["status", "--porcelain"], cwd: workspaceRoot, signal });
      if (status.exitCode !== 0) throw new Error(status.stderr.trim() || "Unable to inspect workspace before pull.");
      if (status.stdout.trim()) throw new Error("git_pull requires a clean working tree. Commit or stash local changes first.");
      const strategy = input.strategy === "rebase" ? "rebase" : "ff-only";
      const args = ["pull", strategy === "rebase" ? "--rebase" : "--ff-only"];
      if (input.remote) args.push(normalizeGitToken(input.remote, "remote name"));
      if (input.branch) args.push(normalizeGitToken(input.branch, "branch name"));
      const result = await runGitCommand({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git pull failed.");
      return { modelResult: { pulled: true, strategy, output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "git_push") {
      const remote = normalizeGitToken(input.remote, "remote name", "origin");
      let branch = input.branch ? normalizeGitToken(input.branch, "branch name") : "";
      if (!branch) {
        const current = await runGitCommand({ args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: workspaceRoot, signal });
        if (current.exitCode !== 0) throw new Error(current.stderr.trim() || "Unable to resolve current branch.");
        branch = normalizeGitToken(current.stdout.trim(), "current branch");
        if (branch === "HEAD") throw new Error("Cannot push from a detached HEAD without an explicit branch.");
      }
      const args = ["push", ...(input.set_upstream ? ["--set-upstream"] : []), remote, branch];
      const result = await runGitCommand({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git push failed.");
      return { modelResult: { pushed: true, remote, branch, setUpstream: Boolean(input.set_upstream), output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "github_repo_create") {
      const inside = await runGitCommand({ args: ["rev-parse", "--is-inside-work-tree"], cwd: workspaceRoot, signal });
      if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
        throw new Error("github_repo_create requires a local Git repository. Use git_init first.");
      }
      const name = normalizeGitHubRepoName(input.name);
      const visibility = ["public", "internal"].includes(input.visibility) ? input.visibility : "private";
      const remote = normalizeGitToken(input.remote, "remote name", "origin");
      const description = String(input.description || "").trim();
      const args = ["repo", "create"];
      if (name) args.push(name);
      args.push("--source", ".", "--" + visibility, "--remote", remote);
      if (description) args.push("--description", description.slice(0, 500));
      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "GitHub repository creation failed.");
      const view = await runGitHubCli({ args: ["repo", "view", "--json", "nameWithOwner,url,visibility,defaultBranchRef"], cwd: workspaceRoot, signal });
      return {
        modelResult: {
          created: true,
          remote,
          visibility,
          repository: view.exitCode === 0 ? parseGitHubJson(view.stdout, "gh repo view") : null,
          output: result.stdout.trim() || result.stderr.trim(),
        },
      };
    }

    if (toolName === "github_pr_create") {
      const title = String(input.title || "").trim();
      const body = String(input.body || "");
      if (!title || title.length > 240 || body.length > 20_000) throw new Error("Invalid pull request title or body.");
      const args = ["pr", "create", "--title", title, "--body", body];
      if (input.base) args.push("--base", normalizeGitToken(input.base, "base branch"));
      if (input.head) args.push("--head", normalizeGitToken(input.head, "head branch"));
      if (input.draft) args.push("--draft");
      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "GitHub pull request creation failed.");
      return { modelResult: { created: true, title, url: result.stdout.trim(), draft: Boolean(input.draft) } };
    }

    if (toolName === "github_pr_view") {
      const args = ["pr", "view"];
      if (Number.isInteger(input.number) && input.number > 0) args.push(String(input.number));
      args.push("--json", "number,title,state,url,headRefName,baseRefName,isDraft,mergeable");
      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read GitHub pull request.");
      return { modelResult: { pullRequest: parseGitHubJson(result.stdout, "gh pr view") } };
    }

    if (toolName === "github_pr_checks") {
      const args = ["pr", "checks"];
      if (Number.isInteger(input.number) && input.number > 0) args.push(String(input.number));
      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });
      return { modelResult: { checks: result.stdout.trim(), diagnostics: result.stderr.trim(), exitCode: result.exitCode, passing: result.exitCode === 0 } };
    }

    throw new Error(`Unsupported tool: ${toolName}`);
  };
}
