import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { groupChanges } from './changes-filters';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

async function newSession(win: Page, name: string): Promise<void> {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
}

test('exact: one writing call → that session (via Bash); a read-only call never counts; two writers → unclear under both; Edit wins, through a stash and pop, until a commit', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const repo = join(project, 'app');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) writeFileSync(join(repo, 'src', f), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  const file = (f: string) => join(repo, 'src', f);

  // The fake claude: "Alfa"/"Beta" sit in a Bash call (PreToolUse Bash, no PostToolUse yet); "Edit c" edits c.ts.
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-bash.pl'), ATELIER_FAKE_EDIT: file('c.ts') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const panel = win.locator('.changes');
    const row = (name: string) => panel.locator('.change-row', { hasText: name });
    await expect(panel).toContainText('Working tree clean', { timeout: 10000 });

    await newSession(win, 'Alfa');
    await expect(win.locator('.session-row', { hasText: 'Alfa' })).toContainText('Bash', { timeout: 15000 });

    // Only Alfa is in Bash: a.ts goes to Alfa, marked as a guess from Bash.
    writeFileSync(file('a.ts'), 'two\n');
    await expect(row('a.ts').locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 10000 });
    await expect(row('a.ts').locator('.dot')).toHaveAttribute('title', 'Alfa (via Bash)');
    // A guess from Bash is a hollow ring in the session's color (an Edit/Write attribution is a filled dot).
    // The color as painted, whatever its serialization (a theme's color-mix comes back as color(srgb …)).
    const ring = await row('a.ts').locator('.dot.via-bash').evaluate((el) => {
      const s = getComputedStyle(el);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = s.color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { background: s.backgroundColor, shadow: s.boxShadow, color: s.color, painted: `rgb(${r}, ${g}, ${b})` };
    });
    const alfa = await win.evaluate(async () => {
      const list = await (window as unknown as { atelier: { terminals: { list(): Promise<{ title: string; color: string }[]> } } }).atelier.terminals.list();
      const hex = list.find((x) => x.title === 'Alfa')!.color;
      const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
    });
    expect(ring.background).toBe('rgba(0, 0, 0, 0)');
    expect(ring.painted).toBe(alfa);
    expect(ring.shadow).toContain(ring.color);
    expect(ring.shadow).toContain('inset');

    // c.ts changes in Alfa's Bash window too, then another session edits it: the Edit attribution wins.
    writeFileSync(file('c.ts'), 'two\n');
    await expect(row('c.ts').locator('.dot')).toHaveAttribute('title', 'Alfa (via Bash)', { timeout: 10000 });
    await newSession(win, 'Edit c');
    await expect(row('c.ts').locator('.dot')).toHaveAttribute('title', 'Edit c', { timeout: 15000 });
    await expect(row('c.ts').locator('.dot')).toHaveCount(1);

    // "Read a.ts" sits in a read-only call (sed -n): it never counts, d.ts is still Alfa's alone.
    await newSession(win, 'Read a.ts');
    await expect(win.locator('.session-row', { hasText: 'Read a.ts' })).toContainText('Bash', { timeout: 15000 });
    writeFileSync(file('d.ts'), 'two\n');
    await expect(row('d.ts').locator('.dot')).toHaveAttribute('title', 'Alfa (via Bash)', { timeout: 10000 });

    // Beta writes too: a change while both run is unclear — one "either" chip with both colors, both named, no overlap warning.
    await newSession(win, 'Beta');
    await expect(win.locator('.session-row', { hasText: 'Beta' })).toContainText('Bash', { timeout: 15000 });
    writeFileSync(file('b.ts'), 'two\n');
    await expect(row('b.ts').locator('.either .either-dot')).toHaveCount(2, { timeout: 10000 });
    await expect(row('b.ts').locator('.either')).toHaveAttribute('title', 'Alfa or Beta: both had a command or tool running when it changed. Click to see why.');
    await expect(panel.locator('.clash')).toHaveCount(0);
    // The chip is a dashed pill, unlike the solid ring of a sure guess.
    expect(await row('b.ts').locator('.either').evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');

    // By session: b.ts in the Maybe sub-group of Alfa and of Beta; nothing under Unknown origin.
    await groupChanges(panel, 'session');
    const group = (name: string) => panel.locator('.change-group', { has: win.locator('.change-group-head', { hasText: name }) });
    await expect(group('Alfa').locator('.change-row')).toHaveText([/a\.ts/, /d\.ts/]);
    await expect(group('Alfa').locator('.maybe-head')).toContainText('b.ts');
    await expect(group('Beta').locator('.change-row')).toHaveCount(0);
    await expect(group('Beta').locator('.maybe-head')).toContainText('Maybe · 1');
    await expect(group('Edit c').locator('.change-row')).toHaveText([/c\.ts/]);
    await expect(panel.locator('.change-group-head', { hasText: 'Unknown origin' })).toHaveCount(0);
    await look(panel, 'test-results/exact-attribution.png');

    // The tree shows the same ring and tooltip.
    await win.getByRole('button', { name: /Files/ }).click();
    const treeRow = (name: string) => win.locator('.tree-row', { has: win.locator('.tree-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) });
    await treeRow('app').click();
    await treeRow('src').click();
    await expect(treeRow('a.ts').locator('.tree-dots .dot.via-bash')).toHaveAttribute('title', 'Alfa (via Bash)');
    expect(await treeRow('a.ts').locator('.dot.via-bash').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await expect(treeRow('c.ts').locator('.tree-dots .dot:not(.via-bash)')).toHaveCount(1);
    await look(win.locator('.tree'), 'test-results/bash-attribution-tree.png');

    // Persisted by the main process in ATELIER_HOME, readable by the owner only.
    const saved = JSON.parse(readFileSync(join(home, 'bash-attributions.json'), 'utf8')) as { list: { path: string; title: string }[] };
    expect(saved.list.map((a) => a.title)).toContain('Alfa');

    // Clean for a moment with the same HEAD (stash, stash pop): Edit c's attribution stays, though Alfa and Beta are
    // still in Bash when c.ts comes back (the guesses from Bash are made again: the other files are unclear now).
    git(repo, 'stash', '-q');
    await expect(panel).toContainText('Working tree clean', { timeout: 8000 });
    git(repo, 'stash', 'pop', '-q');
    await expect(group('Edit c').locator('.change-row')).toHaveText([/c\.ts/], { timeout: 8000 });
    await expect(group('Alfa').locator('.maybe-head')).toContainText('Maybe · 3');
    await expect(panel.locator('.change-group-head', { hasText: 'Unknown origin' })).toHaveCount(0);
    // A commit moves HEAD: the attribution goes; c.ts changed again is only Alfa's or Beta's.
    git(repo, 'commit', '-q', '-am', 'second');
    await expect(panel).toContainText('Working tree clean', { timeout: 8000 });
    writeFileSync(file('c.ts'), 'three\n');
    await expect(group('Alfa').locator('.maybe-head')).toContainText('c.ts', { timeout: 8000 });
    await expect(group('Beta').locator('.maybe-head')).toContainText('c.ts');
    await expect(panel.locator('.change-group-head', { hasText: 'Edit c' })).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('unsure files: one either chip, a collapsed Maybe sub-group, "Why unsure" with the commands, resolve by hand and undo', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const repo = join(project, 'app');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(repo, 'src', f), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  const file = (f: string) => join(repo, 'src', f);

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-bash.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const panel = win.locator('.changes');
    const row = (name: string) => panel.locator('.change-row', { hasText: name });
    await expect(panel).toContainText('Working tree clean', { timeout: 10000 });
    await newSession(win, 'Alfa');
    await expect(win.locator('.session-row', { hasText: 'Alfa' })).toContainText('Bash', { timeout: 15000 });
    await newSession(win, 'Beta');
    await expect(win.locator('.session-row', { hasText: 'Beta' })).toContainText('Bash', { timeout: 15000 });

    // Two files change at once while both sessions run a command: unsure, the same moment.
    writeFileSync(file('a.ts'), 'two\n');
    writeFileSync(file('b.ts'), 'two\n');

    // By repo: one chip per row with both colors and a "?", no dashed dots any more.
    const chip = row('a.ts').locator('.either');
    await expect(chip.locator('.either-dot')).toHaveCount(2, { timeout: 10000 });
    await expect(row('b.ts').locator('.either')).toHaveCount(1, { timeout: 10000 });
    await expect(chip).toHaveAttribute('title', 'Alfa or Beta: both had a command or tool running when it changed. Click to see why.');
    await expect(row('a.ts').locator('.dot.unclear')).toHaveCount(0);
    await look(panel, 'test-results/unsure-by-repo.png');

    // By session: no sure files, a collapsed Maybe sub-group with its count in the header.
    await groupChanges(panel, 'session');
    const group = (name: string) => panel.locator('.change-group', { has: win.locator('.change-group-head', { hasText: name }) });
    await expect(group('Alfa').locator('.unsure-count')).toHaveText('2 ?');
    await expect(group('Alfa')).toContainText('No files for sure.');
    await expect(group('Alfa').locator('.maybe-head')).toContainText('Maybe · 2');
    await expect(group('Alfa').locator('.maybe-head')).toHaveAttribute('aria-expanded', 'false');
    await expect(group('Alfa').locator('.change-row')).toHaveCount(0);
    await group('Alfa').locator('.maybe-head').click();
    await expect(group('Alfa').locator('.maybe-group .change-row')).toHaveText([/a\.ts/, /b\.ts/]);
    await expect(group('Beta').locator('.change-row')).toHaveCount(0);
    await look(panel, 'test-results/unsure-by-session.png');

    // The chip opens "Why unsure": both candidates with their command, outside Claude, the same-moment box ticked.
    await group('Alfa').locator('.change-row', { hasText: 'a.ts' }).locator('.either').click();
    const sheet = win.locator('.origin-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Not sure who changed it');
    await expect(sheet.getByRole('radio')).toHaveText([/Alfa.*sed -i/, /Beta.*sed -i/, /Someone outside Claude/]);
    // Where each call ran from (the hook's cwd): the sessions run from the project folder, the repo is app/.
    await expect(sheet.locator('.origin-where')).toHaveText(['from the project folder', 'from the project folder']);
    await expect(sheet.getByRole('checkbox', { name: 'Also the 1 other file that changed in the same moment' })).toBeChecked();
    await expect(win.locator('.tabs .tab', { hasText: 'a.ts' })).toHaveCount(0); // the click did not open the file
    await look(sheet, 'test-results/unsure-why.png');

    // Pick Beta (key 2) and confirm: both files are Beta's, marked "you said so"; Alfa has nothing left.
    await win.keyboard.press('2');
    await expect(sheet.getByRole('button', { name: 'It was Beta' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.toast')).toContainText('2 files given to Beta');
    await expect(group('Beta').locator('.change-row')).toHaveText([/a\.ts/, /b\.ts/]);
    await expect(group('Beta').locator('.change-row').first().locator('.dot.is-resolved')).toHaveAttribute('title', 'Beta (you said so)');
    await expect(panel.locator('.change-group-head', { hasText: 'Alfa' })).toHaveCount(0);
    await look(panel, 'test-results/unsure-resolved.png');

    // Undo: unsure again under both.
    await win.locator('.toast .toast-action').click();
    await expect(group('Alfa').locator('.unsure-count')).toHaveText('2 ?', { timeout: 5000 });
    await expect(group('Beta').locator('.unsure-count')).toHaveText('2 ?');

    // The keyboard way: the row's context menu → Who Changed This… → outside Claude, only this file. The sub-group
    // the user opened stays open for the window's life, even after its session's group went away and came back.
    await expect(group('Alfa').locator('.maybe-head')).toHaveAttribute('aria-expanded', 'true');
    await group('Alfa').locator('.change-row', { hasText: 'b.ts' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Who Changed This…' }).click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('checkbox').uncheck();
    await sheet.getByRole('radio', { name: /Someone outside Claude/ }).click();
    await sheet.getByRole('button', { name: 'It was outside Claude' }).click();
    await expect(win.locator('.toast')).toContainText('1 file marked as changed outside Claude');
    await expect(group('Unknown origin').locator('.change-row')).toHaveText([/b\.ts/]);
    await expect(group('Alfa').locator('.unsure-count')).toHaveText('1 ?');

    // Persisted: the resolution survives in ATELIER_HOME.
    const saved = JSON.parse(readFileSync(join(home, 'bash-attributions.json'), 'utf8')) as { list: { path: string; command?: string }[] };
    expect(saved.list.every((a) => !a.path.endsWith('b.ts'))).toBe(true);
    expect(saved.list.find((a) => a.path.endsWith('a.ts'))?.command).toContain('sed -i');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
