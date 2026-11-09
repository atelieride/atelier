import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TRIGGERS, LineSplitter, MAX_LINE, MAX_PATTERN, MAX_TRIGGERS, TriggerThrottle, checkPattern, compileRules,
  matchLines, normalizeTriggers, scopeAllows, stripAnsi, type TriggerRule
} from './triggers';

const rule = (over: Partial<TriggerRule> = {}): TriggerRule => ({ id: 'r1', pattern: 'tests failed', action: 'notify', scope: 'all', enabled: true, ...over });

describe('checkPattern', () => {
  test('plain text: matched literally and case-sensitively', () => {
    const c = checkPattern('a.b (x)');
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.re.test('xx a.b (x) yy')).toBe(true);
    expect(c.re.test('aXb (x)')).toBe(false);
    expect(c.re.test('A.B (X)')).toBe(false);
  });

  test('/regex/flags: a regular expression; only i, m, s, u flags', () => {
    const c = checkPattern('/err(or)?:\\s+\\d+/i');
    expect(c.ok && c.re.test('ERROR: 42')).toBe(true);
    // Not a /regex/ with known flags: plain text (a path stays a path).
    const p = checkPattern('/usr/bin');
    expect(p.ok && p.re.test('see /usr/bin here')).toBe(true);
    expect(p.ok && p.re.test('usr')).toBe(false);
    expect(checkPattern('/x/ii')).toMatchObject({ ok: false });
  });

  test('errors: empty, too long, control characters, invalid regex', () => {
    expect(checkPattern('')).toEqual({ ok: false, error: 'Type some text or a /regex/.' });
    expect(checkPattern('   ')).toEqual({ ok: false, error: 'Type some text or a /regex/.' });
    expect(checkPattern('x'.repeat(MAX_PATTERN + 1))).toEqual({ ok: false, error: `Up to ${MAX_PATTERN} characters.` });
    expect(checkPattern('x'.repeat(MAX_PATTERN)).ok).toBe(true);
    expect(checkPattern('a\x1bb')).toEqual({ ok: false, error: 'No control characters.' });
    const bad = checkPattern('/a(b/');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/^Invalid regular expression/);
  });

  test('a regex that matches every line is refused', () => {
    expect(checkPattern('/x*/')).toEqual({ ok: false, error: 'This pattern matches every line.' });
    expect(checkPattern('/^/')).toEqual({ ok: false, error: 'This pattern matches every line.' });
  });

  test('ReDoS: nested repetition and backreferences are refused', () => {
    const nested = { ok: false, error: 'Nested repetition like (a+)+ can freeze the terminal.' };
    expect(checkPattern('/(a+)+$/')).toEqual(nested);
    expect(checkPattern('/(a*)*/')).toEqual(nested);
    expect(checkPattern('/(?:\\w+\\s?)*x/')).toEqual(nested);
    expect(checkPattern('/((ab)+c)+/')).toEqual(nested);
    expect(checkPattern('/(x+){2,}/')).toEqual(nested);
    expect(checkPattern('/(a|b)\\1/')).toEqual({ ok: false, error: 'Backreferences are not allowed.' });
    expect(checkPattern('/(?<n>a)\\k<n>/')).toEqual({ ok: false, error: 'Backreferences are not allowed.' });
    // Fine: a single level, an optional group, quantifiers inside a class, escaped parentheses.
    for (const ok of ['/(ab)+c/', '/(a+)?b/', '/[(+)]+x/', '/\\(a+\\)+/', '/(a+){1}/', '/\\d+ (passed|failed)/']) expect(checkPattern(ok).ok, ok).toBe(true);
  });

  test('ReDoS: optional parts under a counted repeat, overlapping alternatives under + or *, piled-up .* are refused', () => {
    expect(checkPattern('/(a?){30}a{30}/')).toEqual({ ok: false, error: 'Nested repetition like (a+)+ can freeze the terminal.' });
    const overlap = { ok: false, error: 'Alternatives that can match the same text under + or * can freeze the terminal.' };
    expect(checkPattern('/(\\w|\\d)+$/')).toEqual(overlap);
    expect(checkPattern('/(a|aa)+b/')).toEqual(overlap);
    expect(checkPattern('/(?:x|X)*y/i')).toEqual(overlap);
    expect(checkPattern('/((a|ab)c)*/')).toEqual(overlap);
    expect(checkPattern('/(.|\\s){2,}z/')).toEqual(overlap);
    expect(checkPattern('/.*.*.*.*.*.*x/')).toEqual({ ok: false, error: 'Three or more open-ended repeats like .* can freeze the terminal.' });
    expect(checkPattern('/\\w+\\s+\\S*x/')).toEqual({ ok: false, error: 'Three or more open-ended repeats like .* can freeze the terminal.' });
    // Fine: distinct literal first characters, alternation not repeated, two open-ended repeats.
    for (const ok of ['/(foo|bar)+/', '/(?:get|put|del)*x/', '/(passed|failed)/', '/error:\\s+\\d+/', '/.*failed.*/', '/(\\d+|x)/']) expect(checkPattern(ok).ok, ok).toBe(true);
  });
});

describe('normalizeTriggers', () => {
  test('not an array: undefined (the defaults apply)', () => {
    expect(normalizeTriggers(undefined)).toBeUndefined();
    expect(normalizeTriggers({})).toBeUndefined();
  });

  test('invalid rules dropped, duplicate ids once, capped', () => {
    const list = normalizeTriggers([
      rule(), rule({ id: 'r1', pattern: 'dup' }), rule({ id: 'bad id!' }), rule({ id: 'r2', pattern: '/(a+)+/' }),
      rule({ id: 'r3', action: 'shout' as never }), rule({ id: 'r4', scope: 'mars' as never }), rule({ id: 'r5', enabled: 'yes' as never }),
      { ...rule({ id: 'r6' }), extra: 1 }, 'junk', rule({ id: 'r7', pattern: 'ERROR', action: 'highlight', scope: 'terminals', enabled: false })
    ]);
    expect(list!.map((r) => r.id)).toEqual(['r1', 'r6', 'r7']);
    expect(list![1]).toEqual(rule({ id: 'r6' }));
    expect(normalizeTriggers(Array.from({ length: MAX_TRIGGERS + 5 }, (_, i) => rule({ id: `x${i}` })))!.length).toBe(MAX_TRIGGERS);
  });

  test('defaults: two disabled examples', () => {
    expect(DEFAULT_TRIGGERS).toHaveLength(2);
    expect(DEFAULT_TRIGGERS.every((r) => !r.enabled)).toBe(true);
    expect(DEFAULT_TRIGGERS.map((r) => [r.pattern, r.action])).toEqual([['tests failed', 'notify'], ['ERROR', 'highlight']]);
    expect(normalizeTriggers(DEFAULT_TRIGGERS)).toEqual(DEFAULT_TRIGGERS);
  });
});

describe('stripAnsi', () => {
  test('CSI, OSC (BEL and ST), other escapes and control characters go; tabs stay', () => {
    expect(stripAnsi('\x1b[1;31mtests failed\x1b[0m')).toBe('tests failed');
    expect(stripAnsi('\x1b]0;title\x07a\x1b]133;D;1\x1b\\b')).toBe('ab');
    expect(stripAnsi('a\x1b(Bb\x1b=c\x07d\x00e\tf')).toBe('abcde\tf');
    expect(stripAnsi('x\x9b31my')).toBe('xy');
  });
});

describe('LineSplitter', () => {
  test('complete lines only, ANSI stripped, CRLF and LF', () => {
    const s = new LineSplitter();
    expect(s.feed('one\r\ntw')).toEqual(['one']);
    expect(s.feed('o\nthree')).toEqual(['two']);
    expect(s.feed('\n')).toEqual(['three']);
  });

  test('an escape sequence cut between chunks is not leaked as text', () => {
    const s = new LineSplitter();
    expect(s.feed('\x1b[3')).toEqual([]);
    expect(s.feed('1mred\x1b')).toEqual([]);
    expect(s.feed('[0m!\n')).toEqual(['red!']);
    expect(s.feed('\x1b]0;ti')).toEqual([]);
    expect(s.feed('tle\x07ok\n')).toEqual(['ok']);
  });

  test('a lone CR starts the line over (progress bars)', () => {
    const s = new LineSplitter();
    expect(s.feed('10%\r20%\r100% done\n')).toEqual(['100% done']);
  });

  test(`lines longer than ${MAX_LINE} characters are cut into pieces`, () => {
    const s = new LineSplitter();
    const out = s.feed('x'.repeat(MAX_LINE * 2 + 10) + '\n');
    expect(out.map((l) => l.length)).toEqual([MAX_LINE, MAX_LINE, 10]);
  });

  test('reset drops the partial line (the attach snapshot is never matched)', () => {
    const s = new LineSplitter();
    s.feed('tests fai');
    s.reset();
    expect(s.feed('led\n')).toEqual(['led']);
  });
});

describe('matchLines', () => {
  const rules = compileRules([
    rule({ id: 'n', pattern: 'tests failed' }),
    rule({ id: 'h', pattern: '/ERR\\w*/', action: 'highlight' }),
    rule({ id: 'off', pattern: 'tests', enabled: false }),
    rule({ id: 'sess', pattern: 'tests', scope: 'sessions' })
  ]);

  test('enabled rules in scope; notify once per line, highlight with every matched text', () => {
    const r = matchLines(rules, ['3 tests failed', 'ERROR and ERRNO', 'fine'], 'terminal', { now: () => 0, budgetMs: 50 });
    expect(r.hits).toEqual([
      { ruleId: 'n', line: '3 tests failed', texts: ['tests failed'] },
      { ruleId: 'h', line: 'ERROR and ERRNO', texts: ['ERROR', 'ERRNO'] }
    ]);
    expect(r.truncated).toBe(false);
    expect(matchLines(rules, ['tests'], 'session', { now: () => 0, budgetMs: 50 }).hits.map((h) => h.ruleId)).toEqual(['sess']);
  });

  test('time budget per batch: the rest of the lines is skipped', () => {
    let t = 0;
    const r = matchLines(rules, ['tests failed', 'tests failed', 'tests failed'], 'terminal', { now: () => (t += 30), budgetMs: 50 });
    expect(r.hits.length).toBeLessThan(3);
    expect(r.truncated).toBe(true);
  });

  test('a regex with the global flag state never leaks between lines', () => {
    const one = compileRules([rule({ id: 'x', pattern: '/a/' })]);
    const r = matchLines(one, ['a', 'a', 'a'], 'terminal', { now: () => 0, budgetMs: 50 });
    expect(r.hits).toHaveLength(3);
  });
});

test('scopeAllows', () => {
  expect(scopeAllows('all', 'session')).toBe(true);
  expect(scopeAllows('all', 'terminal')).toBe(true);
  expect(scopeAllows('sessions', 'session')).toBe(true);
  expect(scopeAllows('sessions', 'terminal')).toBe(false);
  expect(scopeAllows('terminals', 'session')).toBe(false);
});

test('TriggerThrottle: one per rule per terminal every 30 s', () => {
  const th = new TriggerThrottle(30_000);
  expect(th.allow('t1', 'r', 0)).toBe(true);
  expect(th.allow('t1', 'r', 29_999)).toBe(false);
  expect(th.allow('t2', 'r', 1)).toBe(true);
  expect(th.allow('t1', 'q', 1)).toBe(true);
  expect(th.allow('t1', 'r', 30_000)).toBe(true);
  expect(th.allow('t1', 'r', 31_000)).toBe(false);
});

test('TriggerThrottle: its memory stays bounded even when every pair is recent', () => {
  const th = new TriggerThrottle(30_000);
  for (let i = 0; i < 5000; i++) th.allow(`t${i}`, 'r', 1);
  expect(th.size()).toBeLessThanOrEqual(1000);
});
