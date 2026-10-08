import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../control/credentials.js';
import { defaultRoleSettings, normalizeRoleSettings } from '../../shared/professional-roles.js';

export async function createRoleSettingsStore(dataDirectory) {
  const path = join(dataDirectory, 'security', 'professional-roles.json');
  let value = defaultRoleSettings(), error = '', tail = Promise.resolve();
  try { value = normalizeRoleSettings(await readPrivateJson(path)); }
  catch (cause) { if (cause.code !== 'ENOENT') error = '专业角色配置读取失败；已禁用委派，请检查配置后重新保存。'; }
  const snapshot = () => ({ ...structuredClone(value), ...(error ? { error } : {}) });
  return {
    snapshot,
    save(input) {
      const next = normalizeRoleSettings(input);
      const operation = tail.catch(() => {}).then(async () => {
        if (next.revision !== value.revision) throw new Error('配置已被更新，请重新加载后保存。');
        const updated = { ...next, revision: value.revision + 1 };
        await writePrivateJson(path, updated);
        value = updated; error = ''; return snapshot();
      });
      tail = operation; return operation;
    },
  };
}
const stores = new Map();
export function roleSettingsStore(directory) {
  if (!stores.has(directory)) stores.set(directory, createRoleSettingsStore(directory));
  return stores.get(directory);
}
