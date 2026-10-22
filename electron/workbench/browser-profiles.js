import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function createBrowserProfiles(directory) {
  const file = join(directory, 'browser-profiles.json');
  let selected = new Set(), tail = Promise.resolve();
  const ready = readFile(file, 'utf8').then(text => {
    const value = JSON.parse(text);
    if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 10000 || value.profiles.some(id => !/^[a-f0-9]{64}$/.test(id))) throw Error('BROWSER_PROFILE_CONFIG_INVALID');
    selected = new Set(value.profiles);
  }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const key = context => { const path = resolve(context.workspacePath || '.'); return createHash('sha256').update(JSON.stringify([context.taskId, process.platform === 'win32' ? path.toLowerCase() : path])).digest('hex'); };
  return { ready,
    partition(context) { const id = key(context); return selected.has(id) ? `persist:aporiax-task-${id}` : ''; },
    set(context, enabled) {
      const operation = async () => {
        await ready;
        const next = new Set(selected), id = key(context); enabled ? next.add(id) : next.delete(id);
        if (next.size > 10000) throw Error('已保存的任务浏览器过多，请先清除不再使用的登录记录。');
        await mkdir(directory, { recursive: true });
        const temporary = join(directory, `.browser-profiles-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, profiles: [...next] }), { flag: 'wx', mode: 0o600 });
          await rename(temporary, file); selected = next;
        } finally { await rm(temporary, { force: true }); }
      };
      const result = tail.catch(() => {}).then(operation); tail = result; return result;
    },
  };
}
