// Accept both DOM KeyboardEvent and Electron before-input-event descriptors.
export function isBrowserConsoleShortcut(input) {
  if (!input || input.repeat || input.isAutoRepeat || input.isComposing) return false;
  if (input.type && !['keydown', 'keyDown', 'rawKeyDown'].includes(input.type)) return false;
  const key = String(input.key || '').toLowerCase();
  const control = Boolean(input.ctrlKey || input.control), meta = Boolean(input.metaKey || input.meta);
  const shift = Boolean(input.shiftKey || input.shift), alt = Boolean(input.altKey || input.alt);
  return !alt && (key === 'f12' && !control && !meta && !shift || (control || meta) && shift && ['i', 'j'].includes(key));
}
