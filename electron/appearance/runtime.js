import { app, BrowserWindow, dialog, nativeImage } from 'electron';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createAppearanceStore } from './store.js';
let store;
export function appearanceStore() {
  return store ||= createAppearanceStore(app.getPath('userData'), { onChanged: value => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && win.getTitle() === 'AporiaX') win.webContents.send('appearance:changed', value);
  } });
}
export async function appearanceRequest(input, window) {
  const current = await appearanceStore();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('APPEARANCE_INVALID_ACTION');
  if (input.action === 'get' && Object.keys(input).length === 1) return current.snapshot();
  if (input.action === 'readImage' && Object.keys(input).every(key => ['action', 'id'].includes(key))) return current.readImage(input.id);
  if (input.action === 'importImage' && Object.keys(input).length === 1) {
    if (!current.snapshot().enabled) throw Error('APPEARANCE_DISABLED');
    const result = await dialog.showOpenDialog(window, { title: '选择背景图片', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0];
    if ((await stat(path)).size > 8 * 1024 * 1024) throw Error('THEME_IMAGE_SIZE');
    return current.importImage(await readFile(path), basename(path), buffer => {
      let image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw Error('THEME_IMAGE_TYPE');
      const size = image.getSize();
      if (size.width * size.height > 16000000) throw Error('THEME_IMAGE_SIZE');
      if (Math.max(size.width, size.height) > 2560) image = image.resize(size.width >= size.height ? { width: 2560 } : { height: 2560 });
      const { width, height } = image.getSize(); return { data: image.toPNG(), width, height };
    });
  }
  return current.change(input);
}
