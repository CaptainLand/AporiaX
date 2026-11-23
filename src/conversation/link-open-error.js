import { classifyLink } from '../../electron/link-target.js';

// Click failures belong to a transient UI notice, never the saved reply. Do not
// expose Electron's IPC wrapper, native stack traces or request internals.
export function describeLinkOpenError(error, href, language = 'zh-CN') {
  const tr = (zh, en) => language === 'en' ? en : zh;
  const detail = String(error?.message || error || '');
  const link = classifyLink(href);
  if (link?.kind === 'web') {
    const host = new URL(link.href).hostname;
    const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(host);
    if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(detail)) return local
      ? tr('本地预览暂时无法连接，预览服务可能已停止。', 'Cannot connect to the local preview. Its server may have stopped.')
      : tr('暂时无法连接此网站，请稍后重试。', 'Cannot connect to this website. Please try again later.');
    if (/ERR_(?:CONNECTION_)?TIMED_OUT|ETIMEDOUT/i.test(detail)) return tr('网页打开超时，请稍后重试。', 'The page took too long to open. Please try again.');
    if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(detail)) return tr('无法找到此网站，请检查网址或网络连接。', 'Cannot find this website. Check the address or network connection.');
    return tr('暂时无法打开此网页，请检查地址或稍后重试。', 'Cannot open this page. Check the address or try again later.');
  }
  if (link?.kind === 'file') {
    if (/ENOENT|ENOTDIR|FILE_LINK_MISSING|does not exist|not found|文件不存在|找不到文件/i.test(detail)) return tr('文件不存在或已移动，请核对文件名和所属工作区。', 'The file does not exist or was moved. Check the filename and workspace.');
    if (/FILE_ACCESS_DENIED|FILE_LINK_OUTSIDE|EACCES|EPERM|escapes|outside|not authorized|工作区内|访问.*关闭/i.test(detail)) return tr('此文件不在可访问范围内，请检查工作区或文件访问权限。', 'This file is outside the accessible scope. Check the workspace or file permissions.');
    return tr('暂时无法打开此文件，请检查文件位置和访问权限。', 'Cannot open this file. Check its location and permissions.');
  }
  return tr('暂时无法打开此链接，请检查地址后重试。', 'Cannot open this link. Check the address and try again.');
}
