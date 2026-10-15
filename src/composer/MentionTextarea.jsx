import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { tokenizeDisplayMentions } from '../agent-process-model.js';
import './mention-textarea.css';

// Keep the native textarea for IME, undo, selection and accessibility. The
// non-interactive mirror only paints text; the submitted value stays unchanged.
export const MentionTextarea = forwardRef(function MentionTextarea({ value = '', onScroll, ...props }, ref) {
  const inputRef = useRef(null), mirrorRef = useRef(null);
  useImperativeHandle(ref, () => inputRef.current);
  const parts = tokenizeDisplayMentions(value);
  const highlighted = parts.some(part => part.type === 'mention');
  const sync = () => {
    const input = inputRef.current, mirror = mirrorRef.current;
    if (!input || !mirror) return;
    const style = getComputedStyle(input);
    for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textIndent', 'textAlign', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'wordSpacing']) mirror.style[key] = style[key];
    mirror.style.width = `${input.clientWidth}px`;
    mirror.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
  };
  useLayoutEffect(() => {
    sync();
    const observer = new ResizeObserver(sync);
    if (inputRef.current) observer.observe(inputRef.current);
    return () => observer.disconnect();
  }, [value]);
  return <div className={`mention-textarea ${highlighted ? 'has-mentions' : ''}`}>
    <div className="mention-textarea-overlay" aria-hidden="true"><div ref={mirrorRef} className="mention-textarea-mirror">
      {parts.map((part, index) => part.type === 'mention' ? <span className="mention-textarea-token" key={index}>{part.value}</span> : part.value)}{value.endsWith('\n') ? '\u200b' : ''}
    </div></div>
    <textarea {...props} ref={inputRef} value={value} onScroll={event => { sync(); onScroll?.(event); }} />
  </div>;
});
