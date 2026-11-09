import { describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import type { Attribution } from '@shared/attribution';
import {
  MAX_SNIPPET, composeReview, defaultTarget, docLineOf, isOutdated, newLineRange, parseComments, reviewPaste, sanitizeComment, saveComments, sendAvailability,
  snippetFields, snippetOf, type LineComment
} from './comments';

const c = (over: Partial<LineComment>): LineComment => ({ id: 'c1', path: '/p/api/rate-limit.ts', start: 40, end: 44, text: 'Use seconds, not milliseconds.', snippet: '', target: 't1', createdAt: 1, ...over });

describe('anchoring a selection to new-file lines', () => {
  test('a normal editor: the document lines are the file lines', () => {
    expect(newLineRange(null, 3, 5)).toEqual({ start: 3, end: 5 });
  });
  test('a diff: removed rows have no new line; the range spans the new lines selected', () => {
    const rows = [{ newNo: 1 }, { newNo: null }, { newNo: 2 }, { newNo: 3 }, { newNo: null }, { newNo: 4 }];
    expect(newLineRange(rows, 1, 4)).toEqual({ start: 1, end: 3 });
    // Only removed rows selected: the new line right after them.
    expect(newLineRange(rows, 2, 2)).toEqual({ start: 2, end: 2 });
    expect(newLineRange(rows, 5, 5)).toEqual({ start: 4, end: 4 });
    // Removed rows at the very end: the line before them.
    expect(newLineRange([{ newNo: 1 }, { newNo: null }], 2, 2)).toEqual({ start: 1, end: 1 });
    expect(newLineRange([{ newNo: null }], 1, 1)).toBeNull();
  });
  test('back from a new line to a document line (null: not shown in that view)', () => {
    const rows = [{ newNo: 10 }, { newNo: null }, { newNo: 11 }];
    expect(docLineOf(rows, 11, 3)).toBe(3);
    expect(docLineOf(rows, 12, 3)).toBeNull();
    expect(docLineOf(null, 7, 20)).toBe(7);
    expect(docLineOf(null, 21, 20)).toBeNull();
  });
});

describe('outdated comments', () => {
  const text = 'a\nb\nc\nd\n';
  test('the snippet is the commented lines; changed or gone lines make it outdated', () => {
    expect(snippetOf(text, 2, 3)).toBe('b\nc');
    expect(snippetOf(text, 4, 6)).toBeNull();
    const comment = c({ start: 2, end: 3, snippet: 'b\nc' });
    expect(isOutdated(comment, text)).toBe(false);
    expect(isOutdated(comment, 'a\nB\nc\nd\n')).toBe(true);
    expect(isOutdated(comment, 'a\n')).toBe(true);
    // Unknown text (not loaded): not marked.
    expect(isOutdated(comment, null)).toBe(false);
  });
  test('a long selection keeps 4 KB of snippet plus a hash of all of it: a change past the first 4 KB still counts', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `const line${i} = ${i};`);
    const file = lines.join('\n') + '\n';
    const full = snippetOf(file, 1, 2000)!;
    const kept = snippetFields(full);
    expect(kept.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET);
    expect(kept.hash).toBeTruthy();
    const comment = c({ start: 1, end: 2000, ...kept });
    expect(isOutdated(comment, file)).toBe(false);
    const changedLate = file.replace('const line1999 = 1999;', 'const line1999 = 0;');
    expect(isOutdated(comment, changedLate)).toBe(true);
    // A short selection is stored as it is, no hash.
    expect(snippetFields('a\nb')).toEqual({ snippet: 'a\nb' });
  });
});

const term = (id: string, state: SessionState | null, foreground = 'claude'): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p/api', title: id.toUpperCase(), name: null, color: '#fff', foreground, createdAt: 0,
  session: state ? { sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, cwd: '/p/api' } as never : null
});
const at = (path: string, terminalId: string): Attribution => ({ path, terminalId, sessionId: 's', color: '#c', title: terminalId, at: 1 });

describe('the session a comment goes to', () => {
  test('an unclear file is ambiguous even when only one candidate is still open', () => {
    const terms = [{ id: 'tA', session: { sessionId: 's' } }] as unknown as TerminalInfo[];
    const list: Attribution[] = [
      { path: '/p/a.ts', terminalId: 'tA', sessionId: 's', color: '#a', title: 'Alfa', at: 1, via: 'bash', unclear: ['tA', 'tB'] },
      { path: '/p/a.ts', terminalId: 'tB', sessionId: 's2', color: '#b', title: 'Beta', at: 1, via: 'bash', unclear: ['tA', 'tB'] }
    ];
    expect(defaultTarget('/p/a.ts', list, terms, null)).toEqual({ target: 'tA', ambiguous: true });
  });
  test('a maybe file (a background command alone) is ambiguous too: the composer asks', () => {
    const terms = [{ id: 'tA', session: { sessionId: 's' } }] as unknown as TerminalInfo[];
    const list: Attribution[] = [{ path: '/p/a.ts', terminalId: 'tA', sessionId: 's', color: '#a', title: 'Alfa', at: 1, via: 'bash', maybe: true }];
    expect(defaultTarget('/p/a.ts', list, terms, null)).toEqual({ target: 'tA', ambiguous: true });
  });
  const terms = [term('t1', 'done'), term('t2', 'idle'), term('sh', null)];
  test('the one session the file is attributed to', () => {
    expect(defaultTarget('/p/a.ts', [at('/p/a.ts', 't2')], terms, 't1')).toEqual({ target: 't2', ambiguous: false });
  });
  test('none or several: the session last selected (asked with a picker)', () => {
    expect(defaultTarget('/p/a.ts', [], terms, 't1')).toEqual({ target: 't1', ambiguous: true });
    expect(defaultTarget('/p/a.ts', [at('/p/a.ts', 't1'), at('/p/a.ts', 't2')], terms, 't2')).toEqual({ target: 't2', ambiguous: true });
    // The last selected is gone or not Claude: the first Claude session; none at all: no target.
    expect(defaultTarget('/p/a.ts', [], terms, 'sh')).toEqual({ target: 't1', ambiguous: true });
    expect(defaultTarget('/p/a.ts', [], [term('sh', null)], null)).toEqual({ target: null, ambiguous: true });
    // Attributed to a session that is closed now: as if none.
    expect(defaultTarget('/p/a.ts', [at('/p/a.ts', 'gone')], terms, 't2')).toEqual({ target: 't2', ambiguous: true });
  });
});

describe('the text typed into the session', () => {
  test('comment text: no control characters (escape sequences can never reach the prompt), tabs as spaces', () => {
    expect(sanitizeComment('  Use\tseconds\x1b[201~ now\x07\r\nplease\x9b  ')).toBe('Use  seconds[201~ now\nplease');
    expect(sanitizeComment(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`)).toBe('a\nb\nc');
    expect(sanitizeComment('\x1b\x00 ')).toBe('');
  });
  test('the block: a header, then one mention per comment relative to the session folder, in file and line order', () => {
    const list = [
      c({ id: '2', path: '/p/api/client.ts', start: 12, end: 12, text: 'Remove this retry.' }),
      c({ id: '1' }),
      c({ id: '3', path: '/p/api/my file.ts', start: 3, end: 4, text: 'Two lines\nof comment' })
    ];
    expect(composeReview(list, { cwd: '/p/api', root: '/p', realRoot: '/p' })).toBe([
      'Review comments:',
      '@client.ts#L12 Remove this retry.',
      '@"my file.ts#L3-4" Two lines',
      '  of comment',
      '@rate-limit.ts#L40-44 Use seconds, not milliseconds.'
    ].join('\n'));
    // A project opened through a symlink: real paths go back to the root's form; another folder gives ../ paths.
    expect(composeReview([c({ path: '/private/p/api/x.ts', start: 1, end: 1, text: 'x' })], { cwd: '/p', root: '/p', realRoot: '/private/p' }))
      .toBe('Review comments:\n@api/x.ts#L1 x');
  });
  test('one bracketed paste: newlines inside it, never its end marker, and no Enter after it', () => {
    const p = reviewPaste('Review comments:\n@a.ts#L1 x\x1b[201~\r\n');
    expect(p.startsWith('\x1b[200~')).toBe(true);
    expect(p.endsWith('\x1b[201~')).toBe(true);
    expect(p.slice(6, -6)).toBe('Review comments:\r@a.ts#L1 x[201~');
    expect(p.slice(6, -6)).not.toMatch(/\x1b/);
  });
});

describe('sending is enabled only when the prompt is free', () => {
  test('idle, done or error with Claude in front and bracketed paste on', () => {
    for (const s of ['idle', 'done', 'error'] as const) expect(sendAvailability(term('t', s), true)).toBe('ok');
    expect(sendAvailability(term('t', 'waiting'), true)).toBe('waiting');
    expect(sendAvailability(term('t', 'running'), true)).toBe('busy');
    expect(sendAvailability(term('t', 'idle', 'vim'), true)).toBe('busy');
    // Without bracketed paste every newline would be a submit.
    expect(sendAvailability(term('t', 'idle'), false)).toBe('busy');
    expect(sendAvailability(term('t', null), true)).toBe('not-claude');
    expect(sendAvailability(undefined, true)).toBe('not-claude');
  });
});

describe('stored drafts', () => {
  test('valid entries kept, broken ones dropped, text and count bounded', () => {
    const ok = c({});
    const parsed = parseComments([ok, { ...ok, id: 'x', start: 0 }, { ...ok, id: 'y', end: 30 }, null, 'x', { ...ok, id: 'z', text: 'a'.repeat(9000) }]);
    expect(parsed.map((x) => x.id)).toEqual(['c1', 'z']);
    expect(parsed[1]!.text.length).toBe(4000);
    expect(parseComments('nope')).toEqual([]);
    expect(parseComments(Array.from({ length: 600 }, (_, i) => ({ ...ok, id: `i${i}` })))).toHaveLength(500);
  });
  test('an old entry with a huge snippet is brought under the cap (hash of the whole), flags kept', () => {
    const big = 'x'.repeat(50000);
    const [p] = parseComments([c({ snippet: big, start: 1, end: 1, gone: true })]);
    expect(p!.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET);
    expect(isOutdated(p!, big + '\n')).toBe(false);
    expect(isOutdated(p!, big + 'y\n')).toBe(true);
    expect(p!.gone).toBe(true);
    expect(parseComments([c({ hash: 5 as never })])).toEqual([]);
  });
  test('saving never fails silently: a full storage says false (the store tells the user)', () => {
    const g = globalThis as { localStorage?: unknown };
    g.localStorage = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    try {
      expect(saveComments('/p', [c({})])).toBe(false);
      g.localStorage = { getItem: () => null, setItem: () => {} };
      expect(saveComments('/p', [c({})])).toBe(true);
    } finally { delete g.localStorage; }
  });
});
