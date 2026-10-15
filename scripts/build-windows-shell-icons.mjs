import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Windows desktop shortcut / taskbar / tray assets only.
// Keep public/aporiax-icon*.png and the in-app branding unchanged.
const buildDirectory = new URL('../build/', import.meta.url);
const sourcePath = new URL('windows-shell-icon-source.png', buildDirectory);
const sourceBytes = await readFile(sourcePath);
// Some native decoders mistake embedded C2PA metadata for SVG content.
// Exclude that ancillary chunk from the decoder input, not the saved original.
const pngChunks = [sourceBytes.subarray(0, 8)];
for (let offset = 8; offset < sourceBytes.length;) {
  const length = sourceBytes.readUInt32BE(offset);
  const end = offset + 12 + length;
  if (end > sourceBytes.length) throw new Error('Invalid source PNG chunk');
  if (sourceBytes.toString('ascii', offset + 4, offset + 8) !== 'caBX') {
    pngChunks.push(sourceBytes.subarray(offset, end));
  }
  offset = end;
}
const source = await loadImage(Buffer.concat(pngChunks));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = sizes.map(size => {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // Resolution conversion only: preserve the selected image and its alpha.
  context.drawImage(source, 0, 0, size, size);
  return canvas.toBuffer('image/png');
});

const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  directory[entry] = size === 256 ? 0 : size;
  directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frames[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
});
const icon = Buffer.concat([directory, ...frames]);
for (const name of ['icon.ico', 'icon-dark.ico']) {
  const destination = new URL(name, buildDirectory);
  if (process.argv.includes('--check')) {
    if (!(await readFile(destination)).equals(icon)) {
      throw new Error(`${name} does not match the selected shell icon source`);
    }
  } else {
    await writeFile(destination, icon);
  }
  console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${fileURLToPath(destination)}`);
}
console.log(`Windows icon resolutions: ${sizes.join(', ')}px; in-app assets untouched.`);
