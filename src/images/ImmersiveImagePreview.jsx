import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n.jsx';
import { boundedImageView, fittedImage, zoomImageAt } from './preview-geometry.js';

export const PREVIEW_CHANGED = 'aporiax:image-preview-changed';
const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight });
const pointDistance = points => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
const midpoint = points => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });

export default function ImmersiveImagePreview({ src, alt, sourceRef, onClose }) {
  const { tr } = useI18n();
  const dialogRef = useRef(null), imageRef = useRef(null), animationRef = useRef(null), closingRef = useRef(false), openedRef = useRef(false);
  const pointers = useRef(new Map()), gesture = useRef(null), outsidePress = useRef(null);
  const [size, setSize] = useState(null), [viewport, setViewport] = useState(viewportSize), [failed, setFailed] = useState(false);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 }), viewRef = useRef(view);
  const [dragging, setDragging] = useState(false), [closing, setClosing] = useState(false), [smooth, setSmooth] = useState(false);
  const fit = size ? fittedImage(size, viewport) : null;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const applyView = (next, animate = false) => { viewRef.current = next; setSmooth(animate); setView(next); };
  const relative = point => ({ x: point.x - viewport.width / 2, y: point.y - viewport.height / 2 });

  useLayoutEffect(() => {
    const dialog = dialogRef.current, previousFocus = document.activeElement;
    dialog.showModal(); dialog.focus({ preventScroll: true });
    window.dispatchEvent(new Event(PREVIEW_CHANGED));
    const resize = () => setViewport(viewportSize());
    window.addEventListener('resize', resize);
    return () => {
      animationRef.current?.cancel(); window.removeEventListener('resize', resize);
      dialog.close(); window.dispatchEvent(new Event(PREVIEW_CHANGED));
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (!size || closingRef.current) return;
    // Resize never leaves the photo off-screen, even when the window shrinks.
    applyView(boundedImageView({ ...viewRef.current, x: 0, y: 0 }, fittedImage(size, viewport), viewport));
    if (openedRef.current) {
      animationRef.current?.cancel(); pointers.current.clear(); gesture.current = null; setDragging(false);
      return;
    }
    openedRef.current = true;
    const origin = sourceRef.current?.getBoundingClientRect(), image = imageRef.current;
    if (!origin?.width || !origin.height || !image || reducedMotion()) return;
    const target = image.getBoundingClientRect();
    animationRef.current = image.animate([
      { transform: `translate(${origin.left + origin.width / 2 - viewport.width / 2}px, ${origin.top + origin.height / 2 - viewport.height / 2}px) scale(${origin.width / target.width}, ${origin.height / target.height})`, opacity: .65 },
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
    ], { duration: 260, easing: 'cubic-bezier(.2,.75,.25,1)' });
  }, [size, viewport]);

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true; setClosing(true);
    const image = imageRef.current, origin = sourceRef.current?.getBoundingClientRect();
    if (!image || !size || reducedMotion()) { onClose(); return; }
    const current = getComputedStyle(image).transform;
    animationRef.current?.cancel();
    const backToSource = origin?.width && origin.height && origin.bottom > 0 && origin.top < viewport.height;
    const animation = image.animate([
      { transform: current, opacity: 1 },
      { transform: backToSource ? `translate(${origin.left + origin.width / 2 - viewport.width / 2}px, ${origin.top + origin.height / 2 - viewport.height / 2}px) scale(${origin.width / fit.width}, ${origin.height / fit.height})` : current, opacity: 0 },
    ], { duration: 200, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
    animationRef.current = animation;
    animation.onfinish = onClose;
  };
  const toggleZoom = point => {
    if (!fit || closingRef.current) return;
    animationRef.current?.cancel();
    const current = viewRef.current;
    applyView(current.zoom > 1.05 ? { zoom: 1, x: 0, y: 0 }
      : zoomImageAt(current, Math.max(2, Math.min(4, size.width / fit.width)), point, fit, viewport), true);
  };
  const onPointerDown = event => {
    if (!fit || closingRef.current || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); animationRef.current?.cancel();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 1) gesture.current = { start: points[0], view: viewRef.current, moved: false, pinched: false };
    else if (points.length === 2) gesture.current = { view: viewRef.current, distance: pointDistance(points), center: midpoint(points), moved: true, pinched: true };
    setSmooth(false); setDragging(true);
  };
  const onPointerMove = event => {
    if (!pointers.current.has(event.pointerId) || closingRef.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()], active = gesture.current;
    if (!active) return;
    if (points.length >= 2 && active.distance) {
      const center = midpoint(points), next = zoomImageAt(active.view, active.view.zoom * pointDistance(points) / Math.max(1, active.distance), relative(active.center), fit, viewport);
      applyView(boundedImageView({ ...next, x: next.x + center.x - active.center.x, y: next.y + center.y - active.center.y }, fit, viewport));
    } else if (active.start) {
      const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
      if (Math.hypot(dx, dy) > 5) active.moved = true;
      if (active.moved) applyView(boundedImageView({ ...active.view, x: active.view.x + dx, y: active.view.y + dy }, fit, viewport));
    }
  };
  const finishPointer = (event, cancelled = false) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const active = gesture.current;
    if (pointers.current.size) {
      gesture.current = { start: [...pointers.current.values()][0], view: viewRef.current, moved: true, pinched: true };
    } else {
      setDragging(false); gesture.current = null;
      if (!cancelled && active && !active.moved && !active.pinched) toggleZoom(relative({ x: event.clientX, y: event.clientY }));
    }
  };
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const wheel = event => {
      event.preventDefault();
      if (!fit || closingRef.current || pointers.current.size) return;
      animationRef.current?.cancel();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1);
      applyView(zoomImageAt(viewRef.current, viewRef.current.zoom * Math.exp(-Math.max(-240, Math.min(240, delta)) * .002), relative({ x: event.clientX, y: event.clientY }), fit, viewport));
    };
    dialog.addEventListener('wheel', wheel, { passive: false });
    return () => dialog.removeEventListener('wheel', wheel);
  }, [size, viewport]);
  const onKeyDown = event => {
    event.stopPropagation();
    if (event.key === 'Tab') { event.preventDefault(); dialogRef.current.focus({ preventScroll: true }); return; }
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (!fit || closingRef.current) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleZoom({ x: 0, y: 0 }); }
    else if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); animationRef.current?.cancel(); const current = viewRef.current;
      if (event.key === '0') applyView({ zoom: 1, x: 0, y: 0 }, true);
      else if (['+', '=', '-'].includes(event.key)) applyView(zoomImageAt(current, current.zoom * (event.key === '-' ? .8 : 1.25), { x: 0, y: 0 }, fit, viewport), true);
      else applyView(boundedImageView({ ...current, x: current.x + (event.key === 'ArrowLeft' ? 60 : event.key === 'ArrowRight' ? -60 : 0), y: current.y + (event.key === 'ArrowUp' ? 60 : event.key === 'ArrowDown' ? -60 : 0) }, fit, viewport), true);
    }
  };
  return createPortal(<dialog ref={dialogRef} className="image-preview-dialog image-preview-immersive" tabIndex={-1} aria-label={tr('查看图片', 'View image')}
    aria-describedby="image-preview-help" data-closing={closing || undefined} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onKeyDown={onKeyDown}
    onPointerDown={event => { if (event.target === dialogRef.current) outsidePress.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; }}
    onPointerUp={event => { const press = outsidePress.current; outsidePress.current = null; if (event.target === dialogRef.current && press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) close(); }}
    onPointerCancel={() => { outsidePress.current = null; }}>
    <p id="image-preview-help" className="image-preview-accessible">{tr('点击图片放大或还原，滚轮缩放，拖动移动。按加减号缩放、方向键移动、0 还原。点击空白处或按 Esc 关闭。', 'Click the image to zoom or fit, scroll to zoom, drag to pan. Use plus/minus to zoom, arrows to pan, 0 to fit. Click outside or press Escape to close.')}</p>
    {failed ? <p className="image-preview-error" role="alert">{tr('图片已失效或无法读取。按 Esc 关闭。', 'Image unavailable. Press Escape to close.')}</p> : <img ref={imageRef} className="image-preview-photo" src={src} alt={alt || tr('图片', 'Image')} draggable={false}
      data-zoomed={view.zoom > 1.05 || undefined} data-dragging={dragging || undefined} data-smooth={smooth || undefined}
      onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={event => finishPointer(event)} onPointerCancel={event => finishPointer(event, true)} onLostPointerCapture={event => finishPointer(event, true)}
      style={{ width: fit?.width || 0, height: fit?.height || 0, marginLeft: fit ? -fit.width / 2 : 0, marginTop: fit ? -fit.height / 2 : 0,
        opacity: size ? 1 : 0, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }} />}
  </dialog>, document.body);
}
