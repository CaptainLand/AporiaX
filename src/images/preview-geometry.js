export const MIN_IMAGE_ZOOM = .5;
export const MAX_IMAGE_ZOOM = 6;
export function fittedImage(size, viewport) {
  const inset = viewport.width <= 600 ? 16 : 48;
  const ratio = Math.min(1, Math.max(1, viewport.width - inset * 2) / size.width, Math.max(1, viewport.height - inset * 2) / size.height);
  return { width: size.width * ratio, height: size.height * ratio };
}
export function boundedImageView(view, fitted, viewport) {
  const zoom = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, view.zoom));
  const xLimit = Math.max(0, (fitted.width * zoom - viewport.width) / 2 + 24);
  const yLimit = Math.max(0, (fitted.height * zoom - viewport.height) / 2 + 24);
  return { zoom, x: xLimit ? Math.max(-xLimit, Math.min(xLimit, view.x)) : 0, y: yLimit ? Math.max(-yLimit, Math.min(yLimit, view.y)) : 0 };
}
export function zoomImageAt(view, zoom, point, fitted, viewport) {
  zoom = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, zoom));
  const ratio = zoom / view.zoom;
  return boundedImageView({ zoom, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, fitted, viewport);
}
