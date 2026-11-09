import { afterEach, expect, test, vi } from 'vitest';
import { useApp } from '../store';
import { openClaudeCompat } from './ClaudeCompatibility';

// The palette's "Claude Code Compatibility…": Settings › Claude, the row in
// view, and the keyboard's focus on it (as openLaunchFlags does for its field). A fake DOM: each element logs what
// happens to it.

type Log = string[];
const fake = (log: Log, name: string, inside: Record<string, unknown> = {}) => ({
  scrollIntoView: () => { log.push(`scroll ${name}`); },
  focus: () => { log.push(`focus ${name}`); },
  querySelector: (sel: string) => inside[sel] ?? null
});

function open(inside: (log: Log) => Record<string, unknown>): Log {
  const log: Log = [];
  const row = fake(log, 'row', inside(log));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('document', { querySelector: (sel: string) => (sel === '.compat' ? row : null) });
  openClaudeCompat();
  return log;
}

afterEach(() => { vi.unstubAllGlobals(); useApp.setState({ settingsOpen: null }); });

test('entries noted: Settings › Claude, the row scrolled into view, the focus on the list\'s toggle', () => {
  const log = open((l) => ({ '.compat-fold': fake(l, 'fold'), '.compat-copy': fake(l, 'copy') }));
  expect(useApp.getState().settingsOpen).toBe('claude');
  expect(log).toEqual(['scroll row', 'focus fold']);
});

test('nothing noted (no toggle): the focus on Copy', () => {
  expect(open((l) => ({ '.compat-copy': fake(l, 'copy') }))).toEqual(['scroll row', 'focus copy']);
});
