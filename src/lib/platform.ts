// Which platform we're on, and the keyboard conventions that follow from it.
// ⌘ on macOS, Ctrl on Windows and Linux. Every shortcut and every shortcut label goes through here.

export type Platform = 'mac' | 'windows' | 'linux';

function detect(): Platform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'windows';
  return 'linux';
}

export const platform: Platform = detect();
export const isMac = platform === 'mac';

/** True when the platform's command key (⌘ or Ctrl) is held, and no other modifier that would change the meaning. */
export function modKey(e: KeyboardEvent): boolean {
  return (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
}

/** A shortcut as the user should see it: shortcutLabel('K') → '⌘K' on macOS, 'Ctrl+K' elsewhere. */
export function shortcutLabel(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}
