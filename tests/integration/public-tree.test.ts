// The public tree: what the repository says on its own once the code is published. Comments, tests and configs carry
// no references to the private working notes (specs, plans, rulings, ledger items, the handoff), no notes about who
// decided what, no personal paths or addresses, and no comparisons with other products (their functional names, such
// as environment variables, stay). The tree holds to a baseline that can only shrink: a file may not gain a reference.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { BASELINE_FILE, RULES, compare, isPrivate, isScanned, rulesWith, scanText, scanTree, serializeBaseline, tighten } from '../../scripts/public-tree.mjs';
// @ts-expect-error: .mjs script without types
import { localWords, parseWords } from '../../scripts/local-words.mjs';

type Counts = Record<string, number>;
const root = resolve(__dirname, '../..');
const ids = (RULES as { id: string }[]).map((r) => r.id);
const counts = (text: string): Counts => scanText(text) as Counts;

describe('the rules', () => {
  test.each([
    ['spec', '// Kept in order (spec website-live-demo §3).'],
    ['spec', '* the window frame (spec 2026-10-15-session-coalitions-design.md)'],
    ['spec', '// Spec e2e-affected §1 and Testing: the areas map'],
    ['spec', '// as the app does (spec v2.1 §2)'],
    ['spec', '// stays docked (spec live demo §6 "Screenshots looked at")'],
    ['section', '// the home strip (§1.5)'],
    ['doc-slug', '// see 2026-10-15-website-live-demo for the contract'],
    ['plan', '// the Windows half (plan windows phase 4)'],
    ['plan', '// (plan 2026-10-15-website-live-demo, "Performance")'],
    ['plan', '// created in the editor (spec automations; plan A6)'],
    ['review', "test('a socket is not a file: refused (review M9)', () => {"],
    ['review', '// Re-review N1: the interrupted phases say what the facts show'],
    ['review', '// What he chose is kept, whole (round 1, item 12)'],
    ['ruling', '// nothing looked for (ruling R116)'],
    ['ruling', '// a test home never names real jobs (R2)'],
    ['ruling', '// Ruling: a command, never a custom demo state'],
    ['ruling', '/** R6: resolve_assignees gives ids only */'],
    ['ruling', '// the hosts (rulings R33, R38, R43: a host name or an IP literal)'],
    ['plan', '/** Tab tear-off (amendment T2): a CSS colour as the avatar draws it */'],
    ['phase', '// The MSIX as a file (Windows port Phase 5), with Node built-ins only'],
    ['phase', "describe('phase 9 review', () => {"],
    ['phase', '// POSIX: POSIX home fixtures through node:path (Phase 2).'],
    ['ledger', '// without decrypting it (ledger T15)'],
    ['ledger', '// the open questions, ledgered'],
    ['notes', '// see HANDOFF for the state'],
    ['mockup', '// A grid cell (board 3 "In the grid"): a cell view'],
    ['mockup', '// The Databases sidebar (boards 1 and 6): the head'],
    ['mockup', '// Closing from a sidebar row (variant A): the row grows into the question.'],
    ['mockup', "test('the mockup\\'s card (388 px): nodes of ~104 px', () => {"],
    ['mockup', '/* A deeper teal than the canvas\'s #14B8A6 */'],
    ['task', '        // NULL or empty: nothing to copy, nothing said (T23).'],
    ['task', "          // the popover under the pointer (T31's e2e)."],
    ['task', '// An open asked in a pop-out (carry T19): preview or not.'],
    ['task', '// Without ⌘ nothing shows (main is never asked: D2).'],
    ['spec', ' * canonical (`C:/…`, `~/…`; spec'],
    ['task', "test('the lock in the page (T21): every field read-only', () => {"],
    ['task', "describe('the sheet\\'s run (task 21 round 1)', () => {"],
    ['notes', '// docs/superpowers/specs/x.md'],
    ['notes', "join(root, '.superpowers', 'worktrees')"],
    ['spike', '// Atlassian refuses unbounded JQL (spike), so every query is bounded.'],
    ['spike', "test('Backlog, mine, by deadline (the spike\\'s request, verbatim)', () => {"],
    ['spec', '/** It is over (a report is not: see the spec). */'],
    ['ruling', '// A connection held (one truth for every window: R106): its tab waits.'],
    ['ruling', "// The user's Connect: R48's hold goes."],
    ['ruling', '// a glyph (worktrees in Changes R8)'],
    ['review', "describe('a pull aborts only the rebase it started (final review 1)', () => {"],
    ['review', '// First widths, once per tab (review round 1): a column seen before keeps its width.'],
    ['review', "test('the cut is linear (round 2)', () => {"],
    ['review', "describe('keep-set holds (M4)', () => {"],
    ['review', '// A folder is never taken for a file (review 2 M5).'],
    ['review', '// would carry them every 10 s for nothing (minors).'],
    ['review', "describe('round two', () => {"],
    ['author-notes', '// (Mario, 2026-01-02: one bar again)'],
    ['author-notes', '// off by default (her call, 2026-01-01)'],
    ['author-notes', '// what he asked for'],
    ['author-notes', '// Measured on his app: the shimmer kept the GPU busy.'],
    ['people', 'First beta for colleagues.'],
    ['pronoun', '// A connection he disconnected stays closed.'],
    ['pronoun', "test('a read he causes connects first', () => {"],
    ['pronoun', ' * His own Connect: the hold goes.'],
    ['personal', '// write to someone@gmail.com'],
    ['other-products', '// pasted instead, as cmux does'],
    ['other-products', "test('Claude Code and cmux session variables', () => {"],
    ['other-products', '// Preview tab (VSCode style): italic until it is kept open.'],
    ['other-products', '// the view in front clicked again hides it, as in VS Code'],
    ['other-products', '// The menu folded behind a hamburger, as IntelliJ has it on Windows'],
    ['other-products', '// each line an event, as Ghostty does'],
    ['other-products', "// The row as a record (DBeaver's record view)"]
  ])('%s catches: %s', (rule, text) => {
    expect(counts(text)[rule], text).toBeGreaterThan(0);
  });

  test("a developer's own words come from the git common dir, never from the repository", () => {
    const repo = mkdtempSync(join(tmpdir(), 'atl-words-'));
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'public-tree-words'), '# names only this copy knows\nacme-secret-name\n\n');
    expect(localWords(repo)).toEqual(['acme-secret-name']);
    expect(scanText('// see acme-secret-name', rulesWith(localWords(repo))).local).toBe(1);
    expect(scanText('// see acme-secret-name').local).toBeUndefined();
    expect(localWords(mkdtempSync(join(tmpdir(), 'atl-nogit-')))).toEqual([]);
    expect(() => parseWords('acme-(')).toThrow();
  });

  test.each([
    'const HANDOFF_TEXT_MAX = 64 * 1024 * 1024;',
    "test('runs and ledgers are saved', () => { expect(seen.ledger).toEqual({}); });",
    "author: 'Francesco Musso',",
    "IDENTITY: 'Developer ID Application: Francesco Musso (AFMH6BSX52)'",
    "const FAMILY = 'FrancescoMusso.AtelierIDE_q82zjjpjsmf54';",
    "export const DROPPED_PREFIXES = ['ELECTRON_', 'CMUX_', 'VSCODE_'];",
    "PATH: '/var/folders/x/T/cmux-cli-shims/ABC:/Applications/cmux.app/Contents/Resources/bin:/usr/bin', CMUX_SOCKET: '/c'",
    '// Rerun that spec alone before investigating; every spec is in SPECS.',
    "await page.goto('tests/e2e/workspaces.spec.ts');",
    '// The Docsy themes: blue and gold, JetBrains Mono for code.',
    '## 0.2.0-beta.20 — 2026-10-26',
    "const user = 'mario@example.com';",
    '// plan the next poll; the plan is the release plan',
    '// A review of the diff: Changes shows it before the commit.',
    "const p = book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });",
    '// The clipboard 2 times; the keyboard 3 keys.',
    "const phase = steps[1]; if (phase === 2) return; // the second phase of the drag",
    "at: ms('2026-10-31T11:51:00.000Z')",
    "'2 R. N... 100644 100644 100644 eee eee R100 src/after.ts', 'src/before.ts',",
    ' * `git diff --name-status -z <commit>`: "M\\0path\\0", "R087\\0old\\0new\\0"',
    '// Amend: no Undo (resetting would drop the commit it replaced, not the amendment).',
    "export const DROPPED_PREFIXES = ['VSCODE_', 'ITERM_', 'WEZTERM_', 'GHOSTTY_'];",
    '// File icons from the Seti set (MIT, jesseweed/seti-ui), VSCode\'s default, with its colors.',
    '* the sequence that Claude Code\'s /terminal-setup configures in VS Code and Zed.',
    "wt('spike', 'spike', { upstream: null });",
    '.cb-bar.is-cut-top { clip-path: inset(0 0 2px 0 round 0 0 999px 999px); }',
    '<a href="mailto:?subject=Atelier">Tell a colleague</a>',
    '// Apple Silicon (M1 or later), macOS 13 or later.',
    '// The menu, built from its spec (MENU_SPEC).',
    'const he = sessions.length; // the user picks one'
  ])('nothing to report in: %s', (text) => {
    expect(Object.values(counts(text)).reduce((a, b) => a + b, 0), JSON.stringify(counts(text))).toBe(0);
  });

  test('every rule has an id, and counts come back per rule', () => {
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(counts('(spec x §1) (spec y §2)'))).toEqual(['spec', 'section']);
    expect(counts('(spec x §1) (spec y §2)')).toEqual({ spec: 2, section: 2 });
  });
});

describe('the baseline only shrinks', () => {
  const base = { 'a.ts': { spec: 2, ruling: 1 }, 'b.ts': { spec: 1 } };

  test('more references than the baseline, or a file it doesn\'t know: violations', () => {
    expect(compare({ 'a.ts': { spec: 3, ruling: 1 }, 'b.ts': { spec: 1 }, 'c.ts': { notes: 1 } }, base)).toEqual([
      { file: 'a.ts', rule: 'spec', count: 3, allowed: 2 },
      { file: 'c.ts', rule: 'notes', count: 1, allowed: 0 }
    ]);
  });

  test('fewer references or a file gone: fine', () => {
    expect(compare({ 'a.ts': { spec: 1 } }, base)).toEqual([]);
  });

  test('tighten lowers to what is left and drops what is clean, never raises or adds', () => {
    expect(tighten({ 'a.ts': { spec: 1, ruling: 4 }, 'c.ts': { notes: 2 } }, base)).toEqual({ 'a.ts': { spec: 1, ruling: 1 } });
  });

  test('serialized one file per line, sorted, so parallel cleanups merge', () => {
    const text = serializeBaseline({ 'b.ts': { spec: 1 }, 'a.ts': { ruling: 1, spec: 2 } }) as string;
    const lines = text.trim().split('\n');
    expect(lines.filter((l) => l.includes('.ts'))).toEqual(['    "a.ts": {"ruling":1,"spec":2},', '    "b.ts": {"spec":1}']);
    expect(JSON.parse(text).files).toEqual({ 'a.ts': { ruling: 1, spec: 2 }, 'b.ts': { spec: 1 } });
  });
});

describe('the tree', () => {
  test('which files are scanned: all but the guard itself and lockfiles', () => {
    for (const f of ['src/main/index.ts', 'CHANGELOG.md', 'README.md', '.github/workflows/release.yml', 'CLAUDE.md']) {
      expect(isScanned(f), f).toBe(true);
    }
    for (const f of ['package-lock.json', 'site/package-lock.json', 'scripts/public-tree.mjs', 'tests/integration/public-tree.test.ts',
      BASELINE_FILE]) {
      expect(isScanned(f), f).toBe(false);
    }
  });

  test('the private working notes are never tracked: they live in a repository of their own', () => {
    for (const f of ['CLAUDE.local.md', 'HANDOFF.md', 'docs/superpowers/specs/x.md', 'docs/superpowers/plans/y.md']) {
      expect(isPrivate(f), f).toBe(true);
    }
    for (const f of ['README.md', 'CLAUDE.md', 'docs/releases-README.md', 'src/main/CLAUDE.local.md', 'tests/fixtures/x/HANDOFF.md']) {
      expect(isPrivate(f), f).toBe(false);
    }
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0');
    expect(tracked.filter(isPrivate)).toEqual([]);
  });

  test('no file gains a reference to the private notes, the author\'s notes, personal data or other products', () => {
    const { files, lines } = scanTree(root) as { files: Record<string, Counts>; lines: Record<string, string[]> };
    const baseline = JSON.parse(readFileSync(resolve(root, BASELINE_FILE), 'utf8')).files as Record<string, Counts>;
    const found = (compare(files, baseline) as { file: string; rule: string; count: number; allowed: number }[])
      .map((v) => `${v.file}: ${v.rule} ${v.count} (allowed ${v.allowed})\n${(lines[v.file] ?? []).slice(0, 5).map((l) => `    ${l}`).join('\n')}`);
    expect(found, 'Public-ready code: say the why in the comment itself, with no references to specs, plans, '
      + 'rulings, ledger items or HANDOFF, no notes on who decided, no personal data, no comparisons with other products. '
      + 'Fix the text, never raise the baseline; `node scripts/public-tree.mjs --tighten` lowers it after a cleanup.').toEqual([]);
  });

  test('the baseline names only scanned files and real counts', () => {
    const baseline = JSON.parse(readFileSync(resolve(root, BASELINE_FILE), 'utf8')).files as Record<string, Counts>;
    for (const [file, c] of Object.entries(baseline)) {
      expect(isScanned(file), file).toBe(true);
      for (const [rule, n] of Object.entries(c)) {
        expect(ids, `${file}: ${rule}`).toContain(rule);
        expect(n, `${file}: ${rule}`).toBeGreaterThan(0);
      }
    }
  });
});
