// Token estimates are planning heuristics, not provider billing. Encoded image
// bytes belong to transport limits, never text-token accounting.
function dimensions(url) {
  if (!/^data:image\/[^;,]+;base64,/i.test(url || "")) return null;
  const comma = url.indexOf(",");
  const b = Buffer.from(url.slice(comma + 1, comma + 1 + 87384), "base64");
  if (b.length >= 24 && b.toString("hex", 0, 8) === "89504e470d0a1a0a") return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b[0] === 255 && b[1] === 216) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i++] !== 255) break;
      while (b[i] === 255) i++;
      const marker = b[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const size = b.readUInt16BE(i);
      if (size < 2 || i + size > b.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))
        return [b.readUInt16BE(i + 5), b.readUInt16BE(i + 3)];
      i += size;
    }
  }
  return null;
}
export function conversationTokenMaterial(conversation) {
  let imageTokens = 0;
  let imageCount = 0;
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    if (["image_url", "input_image", "image"].includes(value.type)) {
      imageCount++;
      const image = value.image_url;
      const url = typeof image === "string" ? image : image?.url || value.url || "";
      const size = dimensions(url);
      // Conservative bounded patch estimate. Unknown/remote image: 4096.
      // Provider usage cannot separate text/image tokens, so never calibrate
      // the text estimator with this mixed request's total.
      imageTokens += (image?.detail || value.detail) === "low" ? 1024
        : size?.every(n => Number.isFinite(n) && n > 0)
          ? Math.max(1024, Math.min(16384, Math.ceil(size[0] / 32) * Math.ceil(size[1] / 32)))
          : 4096;
      return { type: value.type, image: "[image]" };
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["aporiaSource", "aporiaPinned", "aporiaSupersededBy"].includes(key)).map(([key, item]) => [key, visit(item)]));
  }
  return { serialized: JSON.stringify(visit(conversation || [])), imageTokens, imageCount };
}

