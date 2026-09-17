/** Parse dimensions before any native image decode. This is a resource guard,
 * not validation of every format feature or a security certification. */
export function inspectImageDimensions(input) {
  const b = Buffer.from(input);
  let width, height;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (b.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG header.');
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b[0] === 255 && b[1] === 216) {
    let p = 2;
    while (p + 4 <= b.length && p < 1024 * 1024) {
      if (b[p++] !== 255) throw new Error('Invalid JPEG header.');
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = b.readUInt16BE(p);
      if (length < 2 || p + length > b.length) throw new Error('Truncated JPEG header.');
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) throw new Error('Invalid JPEG dimensions.');
        height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break;
      }
      p += length;
    }
  } else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    for (let p = 12; p + 8 <= b.length;) {
      const kind = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4), q = p + 8;
      if (q + size > b.length) throw new Error('Truncated WebP header.');
      if (kind === 'VP8X' && size >= 10) {
        if (b[q] & 2) throw new Error('Animated WebP is not supported for OCR.');
        width = 1 + b.readUIntLE(q + 4, 3); height = 1 + b.readUIntLE(q + 7, 3); break;
      }
      if (kind === 'VP8 ' && size >= 10) { width = b.readUInt16LE(q + 6) & 0x3fff; height = b.readUInt16LE(q + 8) & 0x3fff; break; }
      if (kind === 'VP8L' && size >= 5 && b[q] === 0x2f) {
        const bits = b.readUInt32LE(q + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; break;
      }
      p = q + size + (size & 1);
    }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('Unable to verify image dimensions before decoding.');
  if (width * height > 16000000 || Math.max(width, height) > 10000)
    throw new Error('图片尺寸过大，请缩小到 1600 万像素以内。');
  return { width, height };
}
export function shouldRecognizePage({ text = '', hasImages = false, forceOcr = false } = {}) {
  return forceOcr || !text.trim() || hasImages;
}
export function mergeRecognizedText(original, recognized) {
  const normalized = (s) => s.replace(/\s+/g, '').toLowerCase();
  const seen = new Set(recognized.split(/\r?\n/).map(normalized));
  const extras = original.split(/\r?\n/).filter((line) => line.trim() && !seen.has(normalized(line)));
  return [recognized.trim(), ...extras].filter(Boolean).join('\n');
}
