import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';
import JSZip from 'jszip';
import { hashFile } from '../storage/file-state.js';
import { filePathInside, nativeFilePath, verifyNativeFileTarget, withNativeFileScope } from './file-access-policy.js';
import { readBounded } from './task-acceptance.js';
import { mutateWorkspaceFiles } from './workspace-mutations.js';
import { markToolPreflightFailure, toolPreflightError } from './durable-run.js';

// Recognize data only. Never send the matched text to cmd.exe or PowerShell.
export function parseWorkspaceArchiveCommand(command) {
  if (typeof command !== 'string' || command.length > 2000 || /[;&|><`\u0000-\u001f$%]/.test(command)) return null;
  const text = command.trim();
  const wrapped = /^(?:powershell|pwsh)(?:\.exe)?(?: +-(?:NoProfile|NoLogo|NonInteractive))* +-(?:Command|c) +"([^"]+)"$/i.exec(text);
  const body = /^Compress-Archive +(.+)$/i.exec(wrapped?.[1].trim() ?? text)?.[1];
  if (!body) return null;
  const pathToken = /(?:'([^']+)'|"([^"]+)"|([\p{L}\p{M}\p{N}_.:/\\*-]+))(?: +|$)/uy;
  const values = new Map();
  for (let offset = 0; offset < body.length;) {
    const flagMatch = /^-(LiteralPath|Path|DestinationPath|CompressionLevel|Force)(?: +|$)/i.exec(body.slice(offset));
    if (!flagMatch) return null;
    const flag = flagMatch[1].toLowerCase().replace('literalpath', 'path');
    if (values.has(flag)) return null;
    offset += flagMatch[0].length;
    if (flag === 'force') { values.set(flag, true); continue; }
    pathToken.lastIndex = offset;
    const token = pathToken.exec(body);
    if (!token || token[3]?.startsWith('-')) return null;
    values.set(flag, token[1] ?? token[2] ?? token[3]);
    if (flag === 'path') values.set('literal', /^LiteralPath$/i.test(flagMatch[1]));
    offset = pathToken.lastIndex;
  }
  const source = values.get('path'), destination = values.get('destinationpath');
  const level = String(values.get('compressionlevel') || 'Optimal').toLowerCase();
  if (!['optimal', 'fastest', 'nocompression'].includes(level)) return null;
  if (!source || !destination || !/\.(zip|osk)$/i.test(destination) || /[*?]/.test(destination)) return null;
  const contentsOnly = !values.get('literal') && /(?:^|[/\\])\*$/.test(source);
  const sourcePath = contentsOnly ? source.slice(0, -1) || '.' : source;
  if (/[*?]/.test(sourcePath) || (!values.get('literal') && /[\[\]]/.test(sourcePath))) return null;
  return Object.freeze({ source: sourcePath, destination, contentsOnly, overwrite: values.has('force'), level });
}

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const archiveError = toolPreflightError;
const deniedPath = () => archiveError('FILE_ACCESS_DENIED', 'Archive paths must be local workspace files or directories, without links or control metadata.');
const samePath = (a, b) => relative(a, b) === '';

async function prepareWorkspaceArchive({ archive, workspaceRoot, cwd, signal }) {
  async function checkedPath(path, writable = false) {
    if (path !== path.trimEnd() || !filePathInside(workspaceRoot, path) ||
        relative(workspaceRoot, path).split(sep).some(part => /^\.(?:git|aporiax)$/i.test(part))) throw deniedPath();
    const resolved = await verifyNativeFileTarget(workspaceRoot, path, { writable });
    if (!samePath(path, resolved)) throw deniedPath();
    return resolved;
  }
  function fromCwd(value) {
    // A drive-root-relative spelling has different meaning in PowerShell and
    // native file tools. Require a full drive path or a workspace-relative one.
    if (process.platform === 'win32' && /^[\\/]/.test(value)) throw deniedPath();
    return nativeFilePath(cwd, value);
  }

  signal?.throwIfAborted();
  const source = await checkedPath(fromCwd(archive.source));
  const destination = await checkedPath(fromCwd(archive.destination), true);
  if (samePath(source, destination)) throw archiveError('ARCHIVE_SAME_PATH', 'The source and output cannot be the same file.');
  const parent = await lstat(dirname(destination)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!parent?.isDirectory()) throw archiveError('ARCHIVE_INVALID_DESTINATION', 'Choose an existing output directory.');
  const existing = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing && !archive.overwrite) throw archiveError('ARCHIVE_EXISTS', 'The output already exists. Choose another name or explicitly use -Force.');
  if (existing && existing.nlink !== 1) throw deniedPath();
  if (existing && existing.size > MAX_SOURCE_BYTES + 4 * 1024 * 1024) throw archiveError('ARCHIVE_LIMIT', 'Existing output is too large to replace safely. Choose a new output filename.');
  const before = existing ? { filePath: destination, ...await hashFile(destination, { signal }) } : null;

  const zip = new JSZip();
  let bytes = 0, entries = 0, files = 0;
  async function add(path, name, depth) {
    signal?.throwIfAborted();
    if (++entries > MAX_ENTRIES || depth > 64) throw archiveError('ARCHIVE_LIMIT', 'Too many archive entries or directory levels; choose a smaller folder.');
    if (samePath(path, destination)) return; // Do not include a previous output in the new archive.
    const target = await checkedPath(path);
    const info = await lstat(target);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if (name) zip.folder(name);
      for await (const entry of await opendir(target)) {
        if (/^\.(?:git|aporiax)$/i.test(entry.name)) continue;
        // Never let characters in a POSIX filename become ZIP path separators.
        if (entry.name.includes('\\') || entry.name.includes(':')) throw deniedPath();
        await add(nativeFilePath(target, entry.name), name ? `${name}/${entry.name}` : entry.name, depth + 1);
      }
      return;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw deniedPath();
    if (!name) throw archiveError('ARCHIVE_INVALID_SOURCE', 'Use the contents wildcard only with a directory.');
    if (info.size > MAX_SOURCE_BYTES - bytes) throw archiveError('ARCHIVE_LIMIT', 'Archive source exceeds 64 MiB; choose fewer files.');
    const data = await readBounded(workspaceRoot, target, MAX_SOURCE_BYTES - bytes);
    bytes += data.length;
    zip.file(name, data, { date: info.mtime });
    files++;
  }
  await add(source, archive.contentsOnly || samePath(source, workspaceRoot) ? '' : basename(source), 0);
  if (!files) throw archiveError('ARCHIVE_EMPTY', 'No files were selected for the archive.');
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: archive.level === 'nocompression' ? 'STORE' : 'DEFLATE',
    compressionOptions: { level: archive.level === 'fastest' ? 1 : 6 }, streamFiles: true });
  signal?.throwIfAborted();
  return { destination, before, files, buffer };
}

export async function createWorkspaceArchive({ archive, workspaceRoot, cwd, signal }) {
  const { destination, before, files, buffer } = await prepareWorkspaceArchive({ archive, workspaceRoot, cwd, signal })
    .catch(error => { throw markToolPreflightFailure(error); });
  const recovery = await withNativeFileScope('write_file', workspaceRoot, () => mutateWorkspaceFiles({
    workspaceRoot, signal, edits: [{ path: destination, before, after: buffer }],
  }));
  return { path: relative(workspaceRoot, destination).replaceAll('\\', '/'), files, bytesWritten: buffer.length, recovery };
}
