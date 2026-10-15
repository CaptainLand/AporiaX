import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { useWorkbenchContext } from './use-workbench.js';

export function useFileContextMenu({ workspacePath, onOpenFile, onNotice, onAddToChat }) {
  const { language, tr } = useI18n();
  const workbench = useWorkbenchContext();
  const scope = useRef(0);
  const add = onAddToChat || workbench?.addFileToChat;
  useEffect(() => { scope.current++; return () => { scope.current++; }; }, [workspacePath, workbench?.task?.id]);
  return async (event, entry) => {
    event.preventDefault(); event.stopPropagation();
    const generation = scope.current;
    try {
      if (!window.desktop?.workspace?.fileMenu) throw new Error(tr('文件右键菜单需要新版桌面进程，请退出后重新启动。', 'Restart the desktop app to enable the file menu.'));
      const result = await window.desktop.workspace.fileMenu({ workspacePath, path: entry.path, language, canAddToChat: Boolean(add) });
      if (!result || generation !== scope.current) return;
      if (result.action === 'add-to-chat') add?.(result.path);
      else if (result.action === 'preview') onOpenFile?.(result.path);
      else if (result.action.startsWith('copy-')) onNotice?.(tr('路径已复制。', 'Path copied.'));
    } catch (error) { if (generation === scope.current) onNotice?.(error.message); }
  };
}
