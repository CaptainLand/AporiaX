import React, { useLayoutEffect, useRef } from 'react';
import './scroll-fade.css';

// Keep the real scrolling element and its scroll restoration unchanged.
// Decorative overlays live outside it, so menus, selection and scrollbars
// are not clipped by a mask and hit testing still reaches the content.
export function ScrollFadeSurface({ scrollRef, enabled = true, fadeBottom = true, className = '', children }) {
  const surfaceRef = useRef(null);
  useLayoutEffect(() => {
    const surface = surfaceRef.current, scroll = scrollRef.current;
    if (!surface || !scroll) return undefined;
    surface.dataset.fadeTop = 'false';
    surface.dataset.fadeBottom = 'false';
    if (!enabled) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const remaining = scroll.scrollHeight - scroll.clientHeight;
      surface.dataset.fadeTop = String(remaining > 1 && scroll.scrollTop > 1);
      surface.dataset.fadeBottom = String(fadeBottom && remaining > 1 && remaining - scroll.scrollTop > 1);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(scroll);
    for (const child of scroll.children) resize.observe(child);
    const content = new MutationObserver(schedule);
    content.observe(scroll, { childList: true, subtree: true, characterData: true });
    scroll.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect(); content.disconnect();
      scroll.removeEventListener('scroll', schedule);
    };
  }, [scrollRef, enabled, fadeBottom]);
  return <div ref={surfaceRef} className={`scroll-fade-surface ${className}`}>{children}</div>;
}
