import assert from 'node:assert/strict';
import { describeLinkOpenError } from '../src/conversation/link-open-error.js';

const wrapped = detail => new Error(`Error invoking remote method 'workbench.request': Error: ${detail}`);
for (const host of ['localhost', '127.0.0.1', '[::1]']) {
  const message = describeLinkOpenError(wrapped('ERR_CONNECTION_REFUSED (-102) loading an internal URL'), `http://${host}:8092/page.html`);
  assert.match(message, /本地预览暂时无法连接.*可能已停止/);
  assert.doesNotMatch(message, /ERR_|workbench\.request|Error invoking|8092|page\.html/);
}
assert.match(describeLinkOpenError(wrapped('ECONNREFUSED'), 'https://example.com'), /暂时无法连接此网站/);
assert.match(describeLinkOpenError(wrapped('ERR_NAME_NOT_RESOLVED'), 'https://example.com'), /检查网址或网络连接/);
assert.match(describeLinkOpenError(wrapped('ERR_CONNECTION_TIMED_OUT'), 'https://example.com'), /打开超时/);
assert.match(describeLinkOpenError('File does not exist', 'missing.txt'), /文件不存在或已移动/);
assert.match(describeLinkOpenError(wrapped('FILE_LINK_MISSING'), 'missing.txt'), /文件不存在或已移动/);
assert.match(describeLinkOpenError(wrapped('Path escapes the authorized workspace'), 'private.txt'), /文件访问权限/);
assert.match(describeLinkOpenError(wrapped('EACCES'), 'private.txt'), /文件访问权限/);
assert.match(describeLinkOpenError(wrapped('FILE_ACCESS_DENIED'), 'private.txt'), /文件访问权限/);
assert.match(describeLinkOpenError(wrapped('Unexpected native failure'), 'page.html'), /暂时无法打开此文件/);
assert.match(describeLinkOpenError(wrapped('Unexpected native failure'), 'https://example.com'), /暂时无法打开此网页/);
assert.match(describeLinkOpenError(null, 'javascript:alert(1)'), /无法打开此链接/);
assert.match(describeLinkOpenError(wrapped('ECONNREFUSED'), 'http://localhost:8080', 'en'), /local preview.*may have stopped/);
assert.match(describeLinkOpenError('ENOENT', 'missing.txt', 'en'), /does not exist or was moved/);
console.log('PASS friendly link notices: local/remote connection, DNS, timeout, missing file, permission, unknown errors and English; no raw IPC details.');
