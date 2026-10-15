import { parseMentionTokens } from '../../shared/mention-tokens.js';

export function appendFileMention(current, path) {
  const normalized = String(path || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || /[\r\n\0]/.test(normalized)) throw new Error('此文件名无法添加为对话引用。');
  // Prefix avoids treating files named browser:... / git:... as resource mentions.
  const value = `./${normalized}`;
  const token = !value.includes('}') ? `@{${value}}` : !value.includes('"') ? `@"${value}"` : '';
  const parsed = parseMentionTokens(token);
  if (parsed.length !== 1 || parsed[0].kind !== 'file' || parsed[0].value !== normalized) throw new Error('此文件名无法添加为对话引用，请使用复制路径。');
  const existing = parseMentionTokens(current);
  if (existing.some(item => item.kind === 'file' && item.value === normalized)) return current;
  return `${current}${current && !/\s$/.test(current) ? '\n' : ''}${token} `;
}
