// A green run of the whole suite on a clean tree stamps HEAD, which `npm run release` and
// `npm run e2e:affected` read. Only that: a filtered, red or dirty-tree run never stamps.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readStamps, stampDecision, writeStamp } from './full-green';
import FullGreenReporter from './full-green-reporter';

const all = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'];
const full = { status: 'passed', ran: all, allSpecs: all, argv: ['node', 'playwright', 'test'], dirty: [] as string[], tests: 6, results: 6,
  built: 'f00d', head: 'f00d', headAtEnd: 'f00d' };

test('a green run of every spec, unfiltered, on a clean tree stamps', () => {
  expect(stampDecision(full)).toEqual({ stamp: true });
});

test('a partial run never stamps, silently (most runs are partial)', () => {
  expect(stampDecision({ ...full, ran: ['a.spec.ts'] })).toEqual({ stamp: false, why: null });
});

test('a full run that would not count says why', () => {
  expect(stampDecision({ ...full, status: 'failed' })).toEqual({ stamp: false, why: 'the run was not green' });
  expect(stampDecision({ ...full, status: 'interrupted' })).toEqual({ stamp: false, why: 'the run was not green' });
  for (const [arg, flag] of [['--grep', '--grep'], ['-g', '-g'], ['-gsmoke', '-g'], ['--grep-invert', '--grep-invert'], ['--shard', '--shard'], ['--shard=1/2', '--shard']])
    expect(stampDecision({ ...full, argv: [...full.argv, arg!, 'x'] })).toEqual({ stamp: false, why: `filtered (${flag})` });
  for (const arg of ['--list', '--last-failed', '--only-changed', '--only-changed=main', '--test-list', '--test-list=x.txt'])
    expect(stampDecision({ ...full, argv: [...full.argv, arg] })).toEqual({ stamp: false, why: `filtered (${arg.replace(/=.*/, '')})` });
  expect(stampDecision({ ...full, dirty: ['src/x.ts', 'y.ts'] })).toEqual({ stamp: false, why: 'uncommitted changes when it started (src/x.ts, y.ts)' });
});

// `playwright test --list` loads every spec and ends "passed" without running one.
test('a run where not every test produced a result never stamps (--list, a crash, an empty suite)', () => {
  expect(stampDecision({ ...full, results: 0 })).toEqual({ stamp: false, why: 'only 0 of 6 tests ran' });
  expect(stampDecision({ ...full, results: 5 })).toEqual({ stamp: false, why: 'only 5 of 6 tests ran' });
  expect(stampDecision({ ...full, ran: [], allSpecs: [], tests: 0, results: 0 })).toEqual({ stamp: false, why: null });
});

// The build happens before the lock wait; a commit made meanwhile would be stamped untested.
test('only a run built from that very HEAD stamps (npm run e2e and e2e:affected say which HEAD they built)', () => {
  expect(stampDecision({ ...full, built: null })).toEqual({ stamp: false, why: 'not built by npm run e2e (no ATELIER_E2E_BUILT_HEAD)' });
  expect(stampDecision({ ...full, built: 'beef' })).toEqual({ stamp: false, why: 'HEAD moved since the build (built beef, now f00d)' });
  expect(stampDecision({ ...full, headAtEnd: 'cafe' })).toEqual({ stamp: false, why: 'HEAD moved during the run' });
});

// One shared file, several runs: a green run on a branch doesn't push main's stamp out.
test('the stamp file keeps the last 10 green runs, newest first; a missing, broken or legacy one reads sensibly', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'stamp-')), 'atelier-e2e-full-green');
  expect(readStamps(p)).toEqual([]);
  writeStamp(p, 'abc123', '2026-10-16T10:00:00.000Z');
  writeStamp(p, 'def456', '2026-10-16T11:00:00.000Z');
  writeStamp(p, 'abc123', '2026-10-16T12:00:00.000Z');
  expect(readStamps(p)).toEqual([{ sha: 'abc123', at: '2026-10-16T12:00:00.000Z' }, { sha: 'def456', at: '2026-10-16T11:00:00.000Z' }]);
  for (let i = 0; i < 12; i++) writeStamp(p, `aa${i.toString(16).padStart(2, '0')}`, `t${i}`);
  expect(readStamps(p)).toHaveLength(10);
  expect(readStamps(p)[0]!.sha).toBe('aa0b');
  writeFileSync(p, JSON.stringify({ sha: 'beef', at: 'x' }));
  expect(readStamps(p)).toEqual([{ sha: 'beef', at: 'x' }]);
  writeFileSync(p, 'nope');
  expect(readStamps(p)).toEqual([]);
});

type T = { id: string; location: { file: string } };
const suiteOf = (files: string[]): { allTests: () => T[] } => ({ allTests: () => files.flatMap((f) => [1, 2].map((n) => ({ id: `${f}#${n}`, location: { file: `/r/tests/e2e/${f}` } }))) });

function reporter(o: { stampPath: string; lines: string[]; dirty?: string[]; built?: string | null; heads?: string[]; reaches?: (p: string) => boolean }) {
  const heads = [...(o.heads ?? ['f00dcafe1234'])];
  return new FullGreenReporter({
    git: { head: () => (heads.length > 1 ? heads.shift()! : heads[0]!), dirty: () => o.dirty ?? [], stampPath: () => o.stampPath },
    reaches: o.reaches ?? (() => true), built: o.built === undefined ? 'f00dcafe1234' : o.built,
    allSpecs: () => all, argv: ['node', 'playwright', 'test'], log: (l: string) => o.lines.push(l), now: () => '2026-10-16T12:00:00.000Z'
  });
}

async function play(r: InstanceType<typeof FullGreenReporter>, files: string[], run = true) {
  const suite = suiteOf(files);
  r.onBegin({} as never, suite as never);
  if (run) for (const t of suite.allTests()) r.onTestEnd(t as never, { status: 'passed' } as never);
  await r.onEnd({ status: 'passed' } as never);
}

test('the reporter: a full green run stamps the HEAD it built; a partial one leaves the stamp alone', async () => {
  const stampPath = join(mkdtempSync(join(tmpdir(), 'rep-')), 'atelier-e2e-full-green');
  const lines: string[] = [];
  await play(reporter({ stampPath, lines }), ['a.spec.ts']);
  expect(readStamps(stampPath)).toEqual([]);
  await play(reporter({ stampPath, lines }), all);
  expect(readStamps(stampPath)).toEqual([{ sha: 'f00dcafe1234', at: '2026-10-16T12:00:00.000Z' }]);
  expect(lines).toEqual(['Full e2e green at f00dcaf: stamped (npm run release reads it).']);
});

test('the reporter: --list (every spec loaded, none run) does not stamp', async () => {
  const stampPath = join(mkdtempSync(join(tmpdir(), 'rep-')), 'atelier-e2e-full-green');
  const lines: string[] = [];
  await play(reporter({ stampPath, lines }), all, false);
  expect(readStamps(stampPath)).toEqual([]);
  expect(lines).toEqual(['Full e2e run not stamped: only 0 of 6 tests ran.']);
});

test('the reporter: a plain playwright run (no build HEAD) or a HEAD that moved does not stamp', async () => {
  const stampPath = join(mkdtempSync(join(tmpdir(), 'rep-')), 'atelier-e2e-full-green');
  const lines: string[] = [];
  await play(reporter({ stampPath, lines, built: null }), all);
  await play(reporter({ stampPath, lines, heads: ['f00dcafe1234', 'cafecafe9999'] }), all);
  expect(readStamps(stampPath)).toEqual([]);
  expect(lines).toEqual(['Full e2e run not stamped: not built by npm run e2e (no ATELIER_E2E_BUILT_HEAD).', 'Full e2e run not stamped: HEAD moved during the run.']);
});

test('the reporter: uncommitted files that cannot reach the e2e (CHANGELOG.md during a release) do not block the stamp', async () => {
  const stampPath = join(mkdtempSync(join(tmpdir(), 'rep-')), 'atelier-e2e-full-green');
  const lines: string[] = [];
  const reaches = (p: string) => !p.endsWith('.md');
  await play(reporter({ stampPath, lines, reaches, dirty: ['CHANGELOG.md', 'src/x.ts'] }), all);
  expect(readStamps(stampPath)).toEqual([]);
  expect(lines).toEqual(['Full e2e run not stamped: uncommitted changes when it started (src/x.ts).']);
  await play(reporter({ stampPath, lines, reaches, dirty: ['CHANGELOG.md'] }), all);
  expect(readStamps(stampPath)[0]?.sha).toBe('f00dcafe1234');
});

test('playwright.config.ts keeps the list reporter and adds the stamp; the manual config does not stamp', () => {
  const root = join(__dirname, '../..');
  expect(readFileSync(join(root, 'playwright.config.ts'), 'utf8')).toContain("reporter: [['list'], ['./tests/support/full-green-reporter.ts']]");
  expect(readFileSync(join(root, 'playwright.manual.config.ts'), 'utf8')).not.toContain('full-green');
});
