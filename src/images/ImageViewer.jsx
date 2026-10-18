import React, { useLayoutEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useI18n } from '../i18n.jsx';
import './image-viewer.css';
import ImmersiveImagePreview, { PREVIEW_CHANGED } from './ImmersiveImagePreview.jsx';

export function useImagePreviewOpen() {
  const [open, setOpen] = useState(() => Boolean(document.querySelector('.image-preview-dialog[open]')));
  useLayoutEffect(() => {
    const update = () => setOpen(Boolean(document.querySelector('.image-preview-dialog[open]')));
    window.addEventListener(PREVIEW_CHANGED, update); update();
    return () => window.removeEventListener(PREVIEW_CHANGED, update);
  }, []);
  return open;
}

// Explicit workspace image tabs retain their file tools and OCR actions.
export function ImageSurface({ src, alt, actions, stageClassName = '' }) {
  const { tr } = useI18n();
  const [fit, setFit] = useState(true), [zoom, setZoom] = useState(1), [size, setSize] = useState(null), [failed, setFailed] = useState(false);
  return <section className="image-surface" aria-label={tr('图片查看器', 'Image viewer')}>
    <div className="image-surface-toolbar">
      {actions}
      <div className="image-surface-modes" role="group" aria-label={tr('图片显示方式', 'Image display mode')}>
        <button type="button" aria-pressed={fit} onClick={() => { setFit(true); setZoom(1); }}>{tr('适应', 'Fit')}</button>
        <button type="button" aria-pressed={!fit && zoom === 1} onClick={() => { setFit(false); setZoom(1); }}>{tr('原始', 'Original')}</button>
      </div>
      <button type="button" className="image-surface-icon" aria-label={tr('缩小', 'Zoom out')} disabled={!size || (!fit && zoom <= .25)} onClick={() => { setFit(false); setZoom(value => Math.max(.25, value - .25)); }}><ZoomOut size={15} /></button>
      <button type="button" className="image-surface-icon" aria-label={tr('放大', 'Zoom in')} disabled={!size || (!fit && zoom >= 4)} onClick={() => { setFit(false); setZoom(value => Math.min(4, value + .25)); }}><ZoomIn size={15} /></button>
      <span className="image-surface-status" role="status">{fit ? tr('适应窗口', 'Fit to window') : Math.round(zoom * 100) + '%'}{size && ` · ${size.width} × ${size.height}`}</span>
    </div>
    {failed ? <div className="image-surface-error" role="alert">{tr('图片已失效或无法读取，请重新添加附件。', 'Image unavailable. Please attach it again.')}</div> : <div className={'image-surface-stage ' + stageClassName} data-fit={fit ? 'contain' : 'original'} tabIndex={0} aria-label={tr('图片预览区域', 'Image preview area')}>
      <img src={src} alt={alt || tr('图片', 'Image')} onError={() => setFailed(true)} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        style={!fit && size ? { width: size.width * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined} />
    </div>}
  </section>;
}

// A message image opens a modal on its existing surface; it never creates,
// selects or resizes a workbench tab. Draft attachment dragging stays native.
export function PreviewImage({ src, alt, ...props }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false), thumbnailRef = useRef(null);
  return <>
    <img {...props} ref={thumbnailRef} src={src} alt={alt || tr('图片附件', 'Image attachment')} role="button" tabIndex={0} title={tr('查看图片', 'View image')}
      onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setOpen(true); } }} />
    {open && <ImmersiveImagePreview key={src} src={src} alt={alt} sourceRef={thumbnailRef} onClose={() => setOpen(false)} />}
  </>;
}
