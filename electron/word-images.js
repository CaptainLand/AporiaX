export function wordImageInfo(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) throw new Error("Invalid Word image.");
  let type, width, height;
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString("ascii", 12, 16) === "IHDR") {
    type = "png"; width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data[0] === 255 && data[1] === 216) {
    type = "jpg";
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) continue;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xDA || marker === 0xD9) break;
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker) && length >= 7) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width * height > 50_000_000) throw new Error("Word images must be bounded PNG/JPEG files (at most 50 MP).");
  return { data, type, width, height };
}
