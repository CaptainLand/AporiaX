import { lstat } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import { getVerifiedWorkspaceRoot, verifyExistingTarget } from './runtime/workspace-runtime.js';

export const FILE_MENU_ACTIONS = ['add-to-chat', 'preview', 'open-default', 'reveal', 'copy-path', 'copy-relative'];
const EXECUTABLE = /\.(?:exe|com|bat|cmd|ps1|msi|msp|scr|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|sh|app|desktop)$/i;

export async function resolveFileMenuTarget(workspacePath, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0')) throw new Error('文件路径无效。');
  const root = await getVerifiedWorkspaceRoot(workspacePath);
  const path = await verifyExistingTarget(root, requestedPath);
  const stat = await lstat(path);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('只支持普通文件和目录。');
  return { root, path, relativePath: relative(root, path).replaceAll('\\', '/') || '.', type: stat.isDirectory() ? 'directory' : 'file' };
}

export function fileMenuTemplate(target, { language, canAddToChat = true } = {}) {
  const en = language === 'en', file = target.type === 'file';
  return [
    { id: 'add-to-chat', label: en ? 'Add to chat' : '添加到对话', enabled: file && canAddToChat },
    { id: 'preview', label: en ? 'Open in AporiaX' : '在 AporiaX 中打开', enabled: file },
    { type: 'separator' },
    { id: 'open-default', label: en ? 'Open with default application' : '使用系统默认应用打开' },
    { id: 'reveal', label: en ? 'Show in File Explorer' : '在文件资源管理器中显示' },
    { type: 'separator' },
    { id: 'copy-path', label: en ? 'Copy full path' : '复制完整路径' },
    { id: 'copy-relative', label: en ? 'Copy relative path' : '复制相对路径' },
  ];
}

export async function executeFileMenuAction(target, action, { shell, clipboard, confirmExecutable }) {
  if (!FILE_MENU_ACTIONS.includes(action)) throw new Error('未知文件操作。');
  const fresh = await resolveFileMenuTarget(target.root, target.relativePath);
  if (fresh.path !== target.path || fresh.type !== target.type) throw new Error('文件位置已变化，请重新打开菜单。');
  if (['add-to-chat', 'preview'].includes(action) && fresh.type !== 'file') throw new Error('请选择普通文件。');
  if (action === 'open-default') {
    if (fresh.type === 'file' && EXECUTABLE.test(extname(fresh.path)) && !await confirmExecutable(fresh.path)) return null;
    const afterConfirmation = await resolveFileMenuTarget(target.root, target.relativePath);
    if (afterConfirmation.path !== fresh.path || afterConfirmation.type !== fresh.type) throw new Error('文件位置已变化，请重新打开菜单。');
    const error = await shell.openPath(fresh.path);
    if (error) throw new Error(error);
  } else if (action === 'reveal') shell.showItemInFolder(fresh.path);
  else if (action === 'copy-path') clipboard.writeText(fresh.path);
  else if (action === 'copy-relative') clipboard.writeText(fresh.relativePath);
  return { action, path: fresh.relativePath };
}

export function registerWorkspaceFileMenu({ handle, Menu, BrowserWindow, shell, clipboard, dialog }) {
  handle('workspace:file-menu', async (event, request = {}) => {
    const target = await resolveFileMenuTarget(request.workspacePath, request.path);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return null;
    const en = request.language === 'en';
    const action = await new Promise(resolve => {
      const done = value => { owner.removeListener('closed', closed); resolve(value); };
      const closed = () => done(null);
      owner.once('closed', closed);
      const menu = Menu.buildFromTemplate(fileMenuTemplate(target, request).map(item => item.id ? { ...item, click: () => done(item.id) } : item));
      menu.popup({ window: owner, callback: () => done(null) });
    });
    if (!action || owner.isDestroyed()) return null;
    return executeFileMenuAction(target, action, { shell, clipboard, confirmExecutable: async path => {
      const result = await dialog.showMessageBox(owner, { type: 'warning', defaultId: 1, cancelId: 1,
        buttons: en ? ['Open', 'Cancel'] : ['打开', '取消'],
        message: en ? 'Opening this file may execute code on your computer.' : '打开此文件可能会在本机执行代码。', detail: path });
      return result.response === 0;
    } });
  });
}
