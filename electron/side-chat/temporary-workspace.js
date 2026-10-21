import { mkdtemp, mkdir, readdir, lstat, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { verifyNativeFileTarget } from '../runtime/file-access-policy.js';
import { mutateWorkspaceFiles } from '../runtime/workspace-mutations.js';

const OMIT = /^(?:\.git|\.aporiax|node_modules|\.venv|venv|dist|release|coverage|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.env(?:\..*)?|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx))$/i;
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'); };
export async function prepareTemporaryWorkspace({ workspacePath, dataDirectory, writable, signal }) {
  if (!workspacePath) return { workspacePath: '', async finish(result) { return result; } };
  const source = await realpath(workspacePath);
  const sourceIdentity = await lstat(source);
  if (!writable) return { workspacePath: source, async finish(result) { return result; } };
  const storage = resolve(dataDirectory, 'temporary-workspaces');
  if (inside(source, storage)) throw new Error('临时文件存储不能位于项目目录内部。');
  await mkdir(storage, { recursive: true });
  const directory = await mkdtemp(join(storage, 'fork-')), workspace = join(directory, 'workspace');
  const baseline = new Map(); let bytes = 0, finalizing = false;
  async function inventory(root, destination, before = false, path = '') {
    if (!finalizing) signal?.throwIfAborted();
    const result = new Map();
    async function walk(part) {
      if (!finalizing) signal?.throwIfAborted();
      const full = join(root, part), info = await lstat(full);
      if (info.isSymbolicLink()) return;
      if (!inside(root, await realpath(full))) throw new Error('临时工作目录发生越界变化。');
      if (before) {
        try { await verifyNativeFileTarget(source, part || '.', { writable: false }); }
        catch (error) { if (error.code === 'FILE_ACCESS_DENIED') return; throw error; }
      }
      if (info.isDirectory()) {
        if (destination) await mkdir(join(destination, part), { recursive: true });
        for (const entry of await readdir(full)) if (!OMIT.test(entry)) await walk(join(part, entry));
      } else if (info.isFile()) {
        bytes += info.size;
        if (result.size >= 30000 || bytes > 256 * 1024 ** 2) throw new Error('临时工作副本过大，请选择更小的工作目录。');
        const value = await readFile(full);
        if (value.length !== info.size) throw new Error('文件在复制期间变化，请重新尝试。');
        const key = part.replaceAll('\\', '/'); result.set(key, value);
        if (destination) await writeFile(join(destination, part), value, { mode: info.mode & 0o777, flag: 'wx' });
      }
    }
    await walk(path); return result;
  }
  try { for (const [path, value] of await inventory(source, workspace, true)) baseline.set(path, value); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { workspacePath: workspace,
    async finish(result, { cancelled = false, signal: finishSignal = signal } = {}) {
      // A stopped/failed task may still have useful edits. Keep files, not chat
      // transcripts, for recovery. Never silently delete the only output copy.
      bytes = 0; finalizing = true;
      const after = await inventory(workspace).catch(error => { throw Object.assign(error, { retainedWorkspace: workspace }); });
      const changed = [...new Set([...baseline.keys(), ...after.keys()])].filter(path => {
        const a = baseline.get(path), b = after.get(path); return a == null || b == null ? a !== b : !a.equals(b);
      });
      if (!changed.length) return result;
      if (cancelled || result.status !== 'completed') return { ...result, retainedWorkspace: workspace,
        content: `${result.content || ''}\n\n临时修改尚未写回，文件已保留：[恢复副本](<${workspace}>)。` };
      try {
        const currentIdentity = await lstat(source);
        if (currentIdentity.ino !== sourceIdentity.ino || currentIdentity.dev !== sourceIdentity.dev || await realpath(source) !== source) throw new Error('原工作目录已被替换或重定向。');
        const edits = [];
        for (const path of changed) {
          await verifyNativeFileTarget(source, path, { writable: true });
          edits.push({ path, before: baseline.get(path) ?? null, after: after.get(path) ?? null });
        }
        await mutateWorkspaceFiles({ workspaceRoot: source, edits, signal: finishSignal, recoveryDirectory: join(dataDirectory, 'file-recovery') });
        baseline.clear(); for (const [path, value] of after) baseline.set(path, value);
        return { ...result, integrated: true };
      } catch (error) {
        return { ...result, status: 'partial', retainedWorkspace: workspace,
          content: `${result.content || ''}\n\n未覆盖主任务文件：写回检查未通过（${error.message}）。修改已保留：[恢复副本](<${workspace}>)。` };
      }
    },
    async close() {
      finalizing = true; bytes = 0;
      const after = await inventory(workspace).catch(() => null);
      if (!after) return { retainedWorkspace: workspace };
      const pending = [...new Set([...baseline.keys(), ...after.keys()])].some(path => {
        const a = baseline.get(path), b = after.get(path); return a == null || b == null ? a !== b : !a.equals(b);
      });
      if (pending) return { retainedWorkspace: workspace };
      await rm(directory, { recursive: true, force: true }); return {};
    },
  };
}
