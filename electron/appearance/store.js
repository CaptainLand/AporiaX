import { mkdir, readFile, rename, writeFile, lstat, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultAppearance, validateAppearance, validateTheme, IMAGE_ID } from '../../shared/appearance.js';

export async function createAppearanceStore(dataDirectory, { onChanged = () => {} } = {}) {
  const directory = join(dataDirectory, 'appearance'), file = join(directory, 'themes.json');
  let value = defaultAppearance(), error = '', tail = Promise.resolve();
  try { value = validateAppearance(JSON.parse(await readFile(file, 'utf8'))); }
  catch (cause) { if (cause.code !== 'ENOENT') error = 'APPEARANCE_RECOVERED'; }
  const snapshot = () => ({ ...structuredClone(value), ...(error ? { error } : {}) });
  const commit = async next => {
    const updated = validateAppearance({ ...next, revision: value.revision + 1 });
    await mkdir(directory, { recursive: true });
    if (error) await copyFile(file, join(directory, `themes-recovery-${randomUUID()}.json`));
    const temporary = join(directory, `.themes-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(updated), { flag: 'wx' }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    value = updated; error = ''; onChanged(snapshot()); return snapshot();
  };
  const queue = operation => { const result = tail.catch(() => {}).then(operation); tail = result; return result; };
  const assetPath = id => { if (!IMAGE_ID.test(id)) throw Error('THEME_INVALID_IMAGE'); return join(directory, `${id}.png`); };
  return {
    snapshot,
    importCommunity(id,theme){
      return queue(async()=>{
        if(error)throw Error('COMMUNITY_LOCAL_READ_FAILED');
        const draft=validateTheme(theme),before=value.themes.find(item=>item.id===id);
        if(before){if(!Object.entries(draft).every(([key,v])=>JSON.stringify(before[key])===JSON.stringify(v)))throw Error('COMMUNITY_LOCAL_CONFLICT');return before;}
        if(value.themes.length>=40)throw Error('THEME_LIMIT');
        const saved={...draft,id,source:'manual',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        await commit({...value,themes:[...value.themes,saved]});return saved;
      });
    },
    change(input, { source = 'manual', signal } = {}) {
      return queue(async () => {
        signal?.throwIfAborted();
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('APPEARANCE_INVALID_ACTION');
        const allowed = { preferences: ['action', 'revision', 'enabled', 'selectedId', 'base'], save: ['action', 'revision', 'id', 'theme'], delete: ['action', 'revision', 'id'] }[input.action];
        if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) throw Error('APPEARANCE_INVALID_ACTION');
        if (input.revision !== value.revision) throw Error('APPEARANCE_CHANGED');
        let next = structuredClone(value);
        if (input.action === 'preferences') {
          if (source !== 'manual') throw Error('APPEARANCE_USER_ONLY');
          if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') throw Error('APPEARANCE_INVALID'); next.enabled = input.enabled; }
          if (input.base !== undefined) { if (!['light', 'dark'].includes(input.base)) throw Error('THEME_INVALID_BASE'); next.base = input.base; }
          if (input.selectedId !== undefined) next.selectedId = input.selectedId;
          if (!next.enabled) next.selectedId = null;
          if (next.selectedId) next.base = next.themes.find(theme => theme.id === next.selectedId)?.base;
        } else {
          if (!next.enabled) throw Error('APPEARANCE_DISABLED');
          if (input.action === 'save') {
            if (source === 'ai' && input.id) throw Error('APPEARANCE_USER_ONLY');
            const draft = validateTheme(input.theme);
            if (draft.backgroundId && !next.images.some(image => image.id === draft.backgroundId)) throw Error('THEME_INVALID_IMAGE');
            const before = input.id ? next.themes.find(theme => theme.id === input.id) : null;
            if (input.id && !before) throw Error('THEME_NOT_FOUND');
            if (!before && next.themes.length >= 40) throw Error('THEME_LIMIT');
            const theme = { ...draft, id: before?.id || `theme-${randomUUID()}`, source,
              createdAt: before?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
            // Editing an applied theme produces an unapplied candidate until the user applies it.
            next.themes = before ? next.themes.map(item => item.id === theme.id ? theme : item) : [...next.themes, theme];
            if (next.selectedId === theme.id) { next.selectedId = null; next.base = before.base; }
          } else {
            if (source !== 'manual') throw Error('APPEARANCE_USER_ONLY');
            const target = next.themes.find(theme => theme.id === input.id);
            if (!target) throw Error('THEME_NOT_FOUND');
            next.themes = next.themes.filter(theme => theme.id !== input.id);
            if (next.selectedId === input.id) { next.selectedId = null; next.base = target.base; }
          }
        }
        signal?.throwIfAborted(); return commit(next);
      });
    },
    importImage(buffer, name, decodeImage) {
      return queue(async () => {
        if (!value.enabled) throw Error('APPEARANCE_DISABLED');
        if (value.images.length >= 32) throw Error('THEME_IMAGE_LIMIT');
        if (!Buffer.isBuffer(buffer) || buffer.length > 8 * 1024 * 1024 || buffer.length < 12) throw Error('THEME_IMAGE_SIZE');
        const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
        const webp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
        if (!png && !jpeg && !webp) throw Error('THEME_IMAGE_TYPE');
        const decoded = await decodeImage(buffer);
        if (!decoded || decoded.width * decoded.height > 16000000 || decoded.width < 1 || decoded.height < 1 || decoded.data.length > 12 * 1024 * 1024) throw Error('THEME_IMAGE_SIZE');
        const image = { id: `bg-${randomUUID()}`, name: String(name || 'Background').slice(0, 120), width: decoded.width, height: decoded.height };
        await mkdir(directory, { recursive: true }); await writeFile(assetPath(image.id), decoded.data, { flag: 'wx' });
        try { return await commit({ ...value, images: [...value.images, image] }); }
        catch (cause) { await rm(assetPath(image.id), { force: true }); throw cause; }
      });
    },
    async readImage(id) {
      if (!value.images.some(image => image.id === id)) throw Error('THEME_INVALID_IMAGE');
      const path = assetPath(id), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12 * 1024 * 1024) throw Error('THEME_INVALID_IMAGE');
      return `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
    },
  };
}
