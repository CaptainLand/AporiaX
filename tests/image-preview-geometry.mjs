import assert from 'node:assert/strict';
import { fittedImage, boundedImageView, zoomImageAt } from '../src/images/preview-geometry.js';
const viewport = { width: 1400, height: 900 }, size = { width: 1600, height: 1000 }, fit = fittedImage(size, viewport);
assert.equal(fit.height, 804); assert.equal(fit.width / fit.height, 1.6);
assert.deepEqual(fittedImage({ width: 40, height: 40 }, viewport), { width: 40, height: 40 }, 'small images are not enlarged on entry');
const point = { x: 150, y: 0 }, start = { zoom: 1, x: 0, y: 0 };
const zoomed = zoomImageAt(start, 2, point, fit, viewport);
assert.equal((point.x - zoomed.x) / zoomed.zoom, (point.x - start.x) / start.zoom, 'wheel zoom keeps the pixel under the pointer');
assert.deepEqual(zoomImageAt(zoomed, 1, point, fit, viewport), start);
assert.deepEqual(boundedImageView({ zoom: 1, x: 900, y: -900 }, fit, viewport), start, 'fit image cannot be lost by dragging');
assert.equal(boundedImageView({ zoom: 100, x: 0, y: 0 }, fit, viewport).zoom, 6);
assert.equal(boundedImageView({ zoom: .01, x: 0, y: 0 }, fit, viewport).zoom, .5);
for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 240 }, { width: 1800, height: 900 }]) {
  for (const size of [{ width: 100000, height: 100 }, { width: 100, height: 100000 }, { width: 600, height: 600 }]) {
    const fit = fittedImage(size, viewport);
    assert(fit.width <= viewport.width && fit.height <= viewport.height);
    const bounded = boundedImageView({ zoom: 2, x: 100000, y: -100000 }, fit, viewport);
    assert(bounded.x <= Math.max(0, fit.width - viewport.width / 2 + 24));
    assert(-bounded.y <= Math.max(0, fit.height - viewport.height / 2 + 24));
  }
}
console.log('PASS preview geometry: proportional fit, small images, anchored zoom, pan limits, zoom limits, narrow/extreme aspect ratios.');
