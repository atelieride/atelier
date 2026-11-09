import { expect, test } from 'vitest';
import { DANGER_FLAG, DEFAULT_FLAGS, MAX_FLAGS, MAX_LIST_SIZE, SUGGESTED_FLAGS, effectiveFlags, expandFlags, flagError, flagLabel, isDangerFlag, listSize, normalizeFlags, parseFlags, pruneFlags, skipsPermissions } from './claude-flags';

test('a flag: --name, --name=value or -x, then its values', () => {
  expect(flagError(['--verbose'])).toBeNull();
  expect(flagError(['--add-dir', '/a b'])).toBeNull();
  expect(flagError(['--allowedTools', 'Bash(git log:*)', 'Edit'])).toBeNull();
  expect(flagError(['--add-dir=~/x'])).toBeNull();
  expect(flagError(['-d'])).toBeNull();
  expect(flagError([DANGER_FLAG])).toBeNull();
  for (const bad of [[], ['verbose'], ['-'], ['--'], ['---x'], ['-ab'], ['--9x'], ['--a b'], ['--x', '']]) expect(flagError(bad), JSON.stringify(bad)).toBe('shape');
  expect(flagError(['--x', ...Array(16).fill('v')])).toBe('many');
  expect(flagError(['--x', 'a'.repeat(1025)])).toBe('long');
  for (const c of ['\n', '\x1b', '\x7f', '\x9b', '\0']) expect(flagError(['--x', `a${c}b`])).toBe('chars');
  expect(flagError(['--x=a\nb'])).toBe('chars');
});

test('reserved flags: Atelier sets them, or they would end or break the session', () => {
  for (const f of ['--model', '--permission-mode', '--name', '-n', '--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '--print', '-p', '--output-format', '--input-format', '--settings', '--help', '-h', '--version', '-v']) {
    expect(flagError([f]), f).toBe('reserved');
  }
  expect(flagError(['--model=opus'])).toBe('reserved');
  expect(flagError(['--settings', '/x.json'])).toBe('reserved');
});

test('parseFlags: a shell-like split, values join the flag before them', () => {
  expect(parseFlags('--verbose')).toEqual({ flags: [['--verbose']] });
  expect(parseFlags('  --add-dir ~/notes   --ide ')).toEqual({ flags: [['--add-dir', '~/notes'], ['--ide']] });
  expect(parseFlags(`--allowedTools "Bash(git log:*)" 'Edit Read'`)).toEqual({ flags: [['--allowedTools', 'Bash(git log:*)', 'Edit Read']] });
  expect(parseFlags('--append-system-prompt "it\'s fine"')).toEqual({ flags: [['--append-system-prompt', "it's fine"]] });
  expect(parseFlags('--add-dir=/x')).toEqual({ flags: [['--add-dir=/x']] });
  expect(parseFlags('')).toEqual({ flags: [] });
  expect(parseFlags('notes --verbose')).toEqual({ error: 'shape', token: 'notes' });
  expect(parseFlags('--model opus')).toEqual({ error: 'reserved', token: '--model' });
  expect(parseFlags('--x "unclosed')).toEqual({ error: 'quote', token: '"unclosed' });
});

test('normalizeFlags: valid flags kept once, invalid dropped, empty account entries dropped', () => {
  expect(normalizeFlags(undefined)).toBeUndefined();
  expect(normalizeFlags([])).toBeUndefined();
  expect(normalizeFlags({})).toEqual(DEFAULT_FLAGS);
  const v = normalizeFlags({
    all: [['--verbose'], ['--verbose'], ['--model', 'x'], 'x', [DANGER_FLAG]],
    accounts: { work: { flags: [['--add-dir', '/w']], shared: false }, side: { flags: [], shared: true }, off: { flags: [], shared: false }, 'Bad id': { flags: [['--ide']], shared: true }, x: 'y' }
  });
  expect(v).toEqual({ all: [['--verbose'], [DANGER_FLAG]], accounts: { work: { flags: [['--add-dir', '/w']], shared: false }, off: { flags: [], shared: false } } });
  const many = Array.from({ length: MAX_FLAGS + 5 }, (_, i) => [`--f${i}`]);
  expect(normalizeFlags({ all: many })!.all).toHaveLength(MAX_FLAGS);
  // shared defaults to true
  expect(normalizeFlags({ accounts: { work: { flags: [['--ide']] } } })!.accounts.work).toEqual({ flags: [['--ide']], shared: true });
});

test('pruneFlags: entries of accounts that no longer exist go', () => {
  const f = { all: [['--ide']], accounts: { work: { flags: [['--verbose']], shared: true }, gone: { flags: [['--verbose']], shared: true } } };
  expect(pruneFlags(f, ['default', 'work'])).toEqual({ all: [['--ide']], accounts: { work: { flags: [['--verbose']], shared: true } } });
  expect(pruneFlags(f, ['default', 'work', 'gone'])).toBe(f);
});

test('effectiveFlags: all accounts first unless left out, then the account, each once', () => {
  const f = { all: [['--ide'], ['--verbose']], accounts: { work: { flags: [['--verbose'], [DANGER_FLAG]], shared: true }, solo: { flags: [['--add-dir', '/s']], shared: false } } };
  expect(effectiveFlags(f, 'default')).toEqual([['--ide'], ['--verbose']]);
  expect(effectiveFlags(f, 'work')).toEqual([['--ide'], ['--verbose'], [DANGER_FLAG]]);
  expect(effectiveFlags(f, 'solo')).toEqual([['--add-dir', '/s']]);
  expect(skipsPermissions(effectiveFlags(f, 'work'))).toBe(true);
  expect(skipsPermissions(effectiveFlags(f, 'solo'))).toBe(false);
});

test('expandFlags: ~ at the start of a token or after = becomes the home folder', () => {
  expect(expandFlags([['--add-dir', '~/notes'], ['--add-dir=~/x'], ['--x', '~'], ['--y', 'a~/b'], ['--z', '~user']], '/Users/me')).toEqual([['--add-dir', '/Users/me/notes'], ['--add-dir=/Users/me/x'], ['--x', '/Users/me'], ['--y', 'a~/b'], ['--z', '~user']]);
});

test('flagLabel and the suggestions', () => {
  expect(flagLabel(['--add-dir', '/a b'])).toBe("--add-dir '/a b'");
  expect(flagLabel(['--verbose'])).toBe('--verbose');
  expect(SUGGESTED_FLAGS.at(-1)!.flag).toBe(DANGER_FLAG);
  for (const s of SUGGESTED_FLAGS) expect(flagError([s.flag]), s.flag).toBeNull();
});

// Review fixes (2026-10-20).
test('a value never starts with -: it would be a flag of its own (reserved ones and the skip flag included)', () => {
  for (const v of ['--dangerously-skip-permissions', '--settings', '-p', '-']) expect(flagError(['--append-system-prompt', v]), v).toBe('shape');
  expect(flagError(['--append-system-prompt=-be terse'])).toBeNull();
  expect(normalizeFlags({ all: [['--add-dir', '--dangerously-skip-permissions'], ['--add-dir', '/x']] })!.all).toEqual([['--add-dir', '/x']]);
});

test('flags that take no value refuse one (it would reach Claude as a prompt or a subcommand)', () => {
  for (const f of ['--verbose', '--ide', DANGER_FLAG, '--allow-dangerously-skip-permissions']) {
    expect(flagError([f, 'x']), f).toBe('novalue');
    expect(flagError([f]), f).toBeNull();
  }
  expect(parseFlags('--ide update')).toEqual({ error: 'novalue', token: '--ide' });
});

test('parseFlags: quoted and plain parts of one word join; an unmatched quote anywhere is refused', () => {
  expect(parseFlags('--allowedTools="Bash(git log:*)"')).toEqual({ flags: [['--allowedTools=Bash(git log:*)']] });
  expect(parseFlags(`--append-system-prompt a"b c"d 'e f'`)).toEqual({ flags: [['--append-system-prompt', 'ab cd', 'e f']] });
  expect(parseFlags(`--append-system-prompt "it's"`)).toEqual({ flags: [['--append-system-prompt', "it's"]] });
  expect(parseFlags(`--append-system-prompt 'Don't do it'`)).toEqual({ error: 'quote', token: "it'" });
  expect(parseFlags('--x a"b')).toEqual({ error: 'quote', token: 'a"b' });
  expect(parseFlags('--x ""')).toEqual({ error: 'shape', token: '--x' });
});

test('a list stays short enough for the command line atelierd takes (two lists, a name and a folder under 10000)', () => {
  const big = (c: string) => ['--append-system-prompt', c.repeat(1000)];
  const four = [big('a'), big('b'), big('c'), big('d')];
  expect(listSize(four)).toBeGreaterThan(MAX_LIST_SIZE);
  // The one that doesn't fit is left out; a small one after it still fits.
  expect(normalizeFlags({ all: [...four, ['--ide']] })!.all).toEqual([big('a'), big('b'), big('c'), ['--ide']]);
  expect(listSize(normalizeFlags({ all: [...four, big('e')] })!.all)).toBeLessThanOrEqual(MAX_LIST_SIZE);
  // Quotes count as the shell quoting makes them.
  expect(listSize([['--x', "'"]])).toBe(listSize([['--x', 'a']]) + 3);
});

test('the skip flag in any form is the skip flag; the one that allows it is rose but skips nothing', () => {
  expect(skipsPermissions([['--dangerously-skip-permissions=true']])).toBe(true);
  expect(skipsPermissions([['--allow-dangerously-skip-permissions']])).toBe(false);
  expect(isDangerFlag(['--allow-dangerously-skip-permissions'])).toBe(true);
  expect(isDangerFlag([DANGER_FLAG])).toBe(true);
  expect(isDangerFlag(['--verbose'])).toBe(false);
});

test('pruneFlags: with only the default account left, its own flags become the flags for all accounts', () => {
  const f = { all: [['--ide']], accounts: { default: { flags: [[DANGER_FLAG]], shared: true }, work: { flags: [['--verbose']], shared: true } } };
  expect(pruneFlags(f, ['default'])).toEqual({ all: [['--ide'], [DANGER_FLAG]], accounts: {} });
  expect(pruneFlags({ all: [['--ide']], accounts: { default: { flags: [['--verbose']], shared: false } } }, ['default'])).toEqual({ all: [['--verbose']], accounts: {} });
});
