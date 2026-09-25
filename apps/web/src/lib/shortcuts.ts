// Desktop keyboard shortcuts (MASTER_PLAN §5.4): ⌘K / Ctrl+K palette, / search, N new, S scan,
// G then H/M/P/T/L/I/A go to a section, ? help. Pure: the shell feeds it key events.

export type ShortcutAction =
  | { type: 'palette' }
  | { type: 'new' }
  | { type: 'scan' }
  | { type: 'help' }
  | { type: 'go'; to: GoTarget };

export const GO_KEYS = {
  h: '/',
  m: '/money',
  p: '/pantry',
  t: '/things',
  l: '/places',
  i: '/insights',
  a: '/attention',
} as const;
export type GoTarget = (typeof GO_KEYS)[keyof typeof GO_KEYS];

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** The event came from a field the person is typing in. */
  typing: boolean;
}

/** Is this element a place where letters are text, not commands? */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const e = el as HTMLElement;
  const tag = e.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || e.isContentEditable;
}

/** A reader keeps the "G was pressed" state for 1.5 s. */
export function createShortcutReader(now: () => number = Date.now) {
  let gAt = -Infinity;
  return (e: KeyInput): ShortcutAction | null => {
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && k === 'k') return { type: 'palette' };
    if (e.typing || e.metaKey || e.ctrlKey || e.altKey) return null;

    if (now() - gAt < 1500) {
      gAt = -Infinity;
      const to = (GO_KEYS as Record<string, GoTarget>)[k];
      return to ? { type: 'go', to } : null;
    }
    switch (e.key) {
      case '/':
        return { type: 'palette' };
      case '?':
        return { type: 'help' };
    }
    switch (k) {
      case 'g':
        gAt = now();
        return null;
      case 'n':
        return { type: 'new' };
      case 's':
        return { type: 'scan' };
    }
    return null;
  };
}

/** "New" depends on the page: a transaction in Money, a product in Pantry, a thing in Things. */
export function newTargetFor(pathname: string): { to: string; search: Record<string, string> } | null {
  if (pathname.startsWith('/money')) return { to: '/money', search: { add: 'expense' } };
  if (pathname.startsWith('/pantry')) return { to: '/pantry', search: { new: '1' } };
  if (pathname.startsWith('/things')) return { to: '/things', search: { new: '1' } };
  return null;
}
