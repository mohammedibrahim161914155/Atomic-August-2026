/**
 * src/hooks/useKeyboardShortcuts.ts
 *
 * Generic keyboard shortcut hook.
 * Key format: "mod+k", "mod+shift+h", "escape", "/", etc.
 * "mod" = Cmd on macOS, Ctrl on Windows/Linux.
 * Shortcuts are suppressed while the user is typing in an input / textarea.
 */

import { useEffect, useCallback, useRef } from 'react';

type ShortcutMap = Record<string, (e: KeyboardEvent) => void>;

function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName?.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (el as HTMLElement).isContentEditable
  );
}

function buildCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey)  parts.push('alt');
  const key = e.key.toLowerCase();
  // Normalise special keys
  parts.push(
    key === ' '         ? 'space'
    : key === 'enter'   ? 'enter'
    : key === 'escape'  ? 'escape'
    : key === 'arrowup' ? 'arrowup'
    : key === 'arrowdown' ? 'arrowdown'
    : key
  );
  return parts.join('+');
}

export function useKeyboardShortcuts(shortcuts: ShortcutMap): void {
  // Keep a stable ref so adding/removing the listener only happens once
  const shortcutsRef = useRef<ShortcutMap>(shortcuts);
  useEffect(() => { shortcutsRef.current = shortcuts; });

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (isEditableTarget(document.activeElement)) return;
    const combo   = buildCombo(e);
    const handler = shortcutsRef.current[combo];
    if (handler) {
      e.preventDefault();
      handler(e);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
