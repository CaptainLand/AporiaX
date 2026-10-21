import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Parser } from 'htmlparser2';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

export const MAX_WEB_BODY_BYTES = 1_500_000;
export const MAX_WEB_TEXT_CHARS = 160_000;
export const webError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// Only globally routable addresses. This deliberately excludes transition,
// mapped, documentation, multicast and metadata ranges as well as RFC1918.
export function isPublicWebAddress(address) {
  const ip = String(address).toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(ip) !== 6) return false;
  const [first, second = '0'] = ip.split(':');
  const a = parseInt(first, 16), b = parseInt(second || '0', 16);
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && !(a === 0x3fff && b < 0x1000);
}

export function publicWebUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw webError('WEB_URL_INVALID', '请提供完整的公开 HTTP(S) 链接。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048 ||
    url.port && !['80', '443'].includes(url.port) || !host.includes('.') && !isIP(host) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) ||
    isIP(host) && !isPublicWebAddress(host)) {
    throw webError('WEB_URL_BLOCKED', '仅支持公开网页；不读取本机、内网、凭据链接或非标准端口。');
  }
  url.hash = '';
  return url;
}

async function requestPage(url, { signal, resolveHost, request }) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveHost(host, { all: true, verbatim: true }); }
  catch { throw webError('WEB_FETCH_DNS', '无法解析网页地址，可使用浏览器检查网络。'); }
  signal?.throwIfAborted();
  if (addresses.length && addresses.every(item => /^198\.(?:18|19)\./.test(item.address))) {
    // TUN fake-IP mode cannot be pinned as a public IP. Do not connect to this
    // range; the caller may use the existing remote extraction provider.
    throw webError('WEB_FETCH_PROXY_DNS', '当前网络使用代理虚拟 IP，不能安全地直接读取。');
  }
  if (!addresses.length || addresses.some(item => !isPublicWebAddress(item.address))) {
    throw webError('WEB_URL_BLOCKED', '网页地址解析到了本机、内网或保留地址。');
  }
  const selected = addresses.find(item => item.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    // Resolve once and pin the validated address through connect; no second
    // system DNS lookup (DNS rebinding), cookies, proxy env, or ambient auth.
    const req = request(url, {
      method: 'GET', signal, agent: false,
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      headers: { 'User-Agent': 'AporiaX-Web/1.0', Accept: 'text/markdown, text/plain, text/html;q=0.9, application/json;q=0.7', 'Accept-Encoding': 'gzip, deflate, br' },
    }, res => {
      const status = Number(res.statusCode);
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.destroy();
        resolve({ status, location: res.headers.location });
        return;
      }
      let body = res;
      const fail = error => { body.destroy(); res.destroy(); reject(error); };
      if (status < 200 || status >= 300) {
        fail(webError(status === 429 ? 'WEB_FETCH_RATE_LIMITED' : 'WEB_FETCH_HTTP', `网页返回 HTTP ${status}，可使用浏览器进一步查看。`));
        return;
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (!/^(?:text\/(?:html|plain|markdown|x-markdown)|application\/(?:xhtml\+xml|json))\b/.test(type)) {
        fail(webError('WEB_FETCH_UNSUPPORTED_TYPE', '此链接不是可读取的网页或文本，不会下载二进制文件。'));
        return;
      }
      const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
      if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
        fail(webError('WEB_FETCH_ENCODING', '网页使用不支持的传输编码，请使用浏览器读取。'));
        return;
      }
      if (Number(res.headers['content-length']) > MAX_WEB_BODY_BYTES) {
        fail(webError('WEB_FETCH_TOO_LARGE', '网页超过单次读取大小，请选择更具体的页面或使用浏览器。'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      if (encoding !== 'identity') {
        body = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : createInflate();
        let transferBytes = 0;
        res.on('data', chunk => {
          transferBytes += chunk.length;
          if (transferBytes > MAX_WEB_BODY_BYTES) fail(webError('WEB_FETCH_TOO_LARGE', '网页压缩数据超过单次读取大小。'));
        });
        res.pipe(body);
      }
      body.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_WEB_BODY_BYTES) fail(webError('WEB_FETCH_TOO_LARGE', '网页超过单次读取大小。'));
        else chunks.push(chunk);
      });
      body.on('error', error => fail(webError('WEB_FETCH_INCOMPLETE', '网页传输或解压失败，未得到完整内容。')));
      res.on('error', reject);
      res.on('aborted', () => fail(webError('WEB_FETCH_INCOMPLETE', '网页传输中断，未得到完整内容。')));
      body.on('end', () => {
        const charset = type.match(/charset=["']?([^\s;"']+)/)?.[1] || 'utf-8';
        let text;
        try { text = new TextDecoder(charset).decode(Buffer.concat(chunks)); }
        catch { text = Buffer.concat(chunks).toString('utf8'); }
        resolve({ status, type, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPublicPage(value, { signal, resolveHost = lookup, request } = {}) {
  let url = publicWebUrl(value);
  const visited = new Set();
  for (let hop = 0; hop <= 3; hop += 1) {
    signal?.throwIfAborted();
    if (visited.has(url.href)) throw webError('WEB_FETCH_REDIRECT', '网页出现循环重定向。');
    visited.add(url.href);
    const page = await requestPage(url, { signal, resolveHost,
      request: request || (url.protocol === 'https:' ? httpsRequest : httpRequest) });
    if (!page.location) {
      if (page.status >= 300) throw webError('WEB_FETCH_REDIRECT', '网页重定向缺少目标地址。');
      return { ...page, url: url.href };
    }
    if (hop === 3) throw webError('WEB_FETCH_REDIRECT', '网页重定向次数过多。');
    const next = publicWebUrl(new URL(page.location, url).href);
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw webError('WEB_FETCH_REDIRECT', '拒绝从 HTTPS 降级到 HTTP。');
    url = next; // Every destination is checked and resolved again before GET.
  }
}

const IGNORED = new Set(['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'nav', 'footer', 'aside', 'form', 'template']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'blockquote', 'ul', 'ol', 'li', 'table', 'tr', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr']);
const clean = text => text.replace(/[\t \f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export function extractWebText(page) {
  if (!/html/.test(page.type)) return { title: page.title || new URL(page.url).hostname, content: page.text.slice(0, MAX_WEB_TEXT_CHARS), extractionTruncated: page.extractionTruncated === true || page.text.length > MAX_WEB_TEXT_CHARS };
  const sections = { body: [], main: [], article: [] }, sizes = { body: 0, main: 0, article: 0 };
  const stack = [];
  let title = '', titleDepth = 0, ignored = 0, main = 0, article = 0, pre = 0;
  const append = text => {
    if (ignored || !text) return;
    for (const key of ['body', ...(main ? ['main'] : []), ...(article ? ['article'] : [])]) {
      if (sizes[key] < MAX_WEB_TEXT_CHARS + 1) {
        const chunk = text.slice(0, MAX_WEB_TEXT_CHARS + 1 - sizes[key]);
        sections[key].push(chunk); sizes[key] += chunk.length;
      }
    }
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (stack.length >= 2048) throw webError('WEB_FETCH_HTML_DEPTH', '网页结构过深，请使用浏览器读取。');
      const skip = IGNORED.has(name) || name === 'head' || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || '');
      stack.push({ name, skip });
      if (skip) ignored += 1;
      if (name === 'title') titleDepth += 1;
      if (name === 'main') main += 1;
      if (name === 'article') article += 1;
      if (name === 'pre') pre += 1;
      if (BLOCKS.has(name)) append('\n\n');
      if (/^h[1-6]$/.test(name)) append(`${'#'.repeat(Number(name[1]))} `);
      if (name === 'li') append('- ');
      if (name === 'td' || name === 'th') append(' | ');
    },
    ontext(text) {
      if (titleDepth && title.length < 300) title += text.slice(0, 300 - title.length);
      append(pre ? text : text.replace(/\s+/g, ' '));
    },
    onclosetag(name) {
      if (BLOCKS.has(name)) append('\n\n');
      const frame = stack.pop();
      if (frame?.skip) ignored -= 1;
      if (name === 'title') titleDepth -= 1;
      if (name === 'main') main -= 1;
      if (name === 'article') article -= 1;
      if (name === 'pre') pre -= 1;
    },
  }, { decodeEntities: true });
  parser.end(page.text);
  const preferred = ['main', 'article', 'body'].find(key => clean(sections[key].join('')).length >= 100) || 'body';
  const content = clean(sections[preferred].join(''));
  return { title: clean(title) || new URL(page.url).hostname, content: content.slice(0, MAX_WEB_TEXT_CHARS), extractionTruncated: sizes[preferred] > MAX_WEB_TEXT_CHARS };
}
