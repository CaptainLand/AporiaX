// Browser-side contrast measurement, including translucent ancestor surfaces
// and group opacity. Target text is tested against its rendered background.
export function measureTextContrast(element) {
  const parse = value => { const v = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0]; return [v[0], v[1], v[2], v[3] ?? 1]; };
  const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
  const chain = []; for (let node = element; node; node = node.parentElement) chain.unshift(node);
  const surfaces = []; let bg = [255, 255, 255];
  for (const node of chain) { const style = getComputedStyle(node); surfaces.push({ under: bg, opacity: Number(style.opacity) }); bg = over(parse(style.backgroundColor), bg); }
  let fg = over(parse(getComputedStyle(element).color), bg);
  for (const { under, opacity } of surfaces.reverse()) { fg = over([...fg, opacity], under); bg = over([...bg, opacity], under); }
  const luminance = rgb => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const a = luminance(fg), b = luminance(bg);
  return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), color: getComputedStyle(element).color, text: element.textContent.trim().slice(0, 40) };
}
