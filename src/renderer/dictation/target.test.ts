import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { Split } from '../split';
import { dictationPane, dictationTarget } from './target';

const t = (id: string, claude: boolean): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: claude ? 'claude' : 'zsh', createdAt: 0,
  session: claude ? { sessionId: id, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } : null
});

test('the selected session if it is Claude', () => {
  expect(dictationTarget([t('a', true), t('b', true)], 'b', 'a')).toBe('b');
});

test('a plain terminal selected: the last Claude session used, if it still exists', () => {
  expect(dictationTarget([t('a', true), t('b', true), t('sh', false)], 'sh', 'b')).toBe('b');
  expect(dictationTarget([t('a', true), t('sh', false)], 'sh', 'gone')).toBe('a');
});

test('no Claude session: null (the text will go to the clipboard)', () => {
  expect(dictationTarget([t('sh', false)], 'sh', null)).toBeNull();
  expect(dictationTarget([], null, null)).toBeNull();
});

// minor 4: in the split view the pill sits over the pane where the text will go, not blindly the focused one.
test('pill pane: the pane showing the target session; otherwise (not shown, no target, one pane) the focused pane', () => {
  const split: Split = { panes: [{ tabs: ['t:sh', 't:x'], front: 't:sh' }, { tabs: ['t:b'], front: 't:b' }, { tabs: [], front: null }], focus: 0, fractions: [1 / 3, 1 / 3, 1 / 3] };
  expect(dictationPane(split, 'b')).toBe(1);
  expect(dictationPane(split, 'a')).toBe(0);
  // A session behind another tab of its pane is not on screen: the focused pane.
  expect(dictationPane({ ...split, focus: 2 }, 'x')).toBe(2);
  expect(dictationPane({ ...split, focus: 2 }, null)).toBe(2);
  expect(dictationPane({ panes: [{ tabs: [], front: null }], focus: 0, fractions: [1] }, 'b')).toBe(0);
});
