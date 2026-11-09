import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { groupChanges, setChangesFolders } from './changes-filters';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

test('Changes, attribution to two sessions, diff, gutter, refresh from disk, commit', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const ui = join(project, 'app-ui');
  mkdirSync(join(ui, 'src'), { recursive: true });
  git(ui, 'init', '-q', '-b', 'dev');
  const lines = Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
  const appPath = join(ui, 'src', 'App.tsx');
  writeFileSync(appPath, lines.join('\n') + '\n');
  writeFileSync(join(ui, 'serve.json'), '{}\n');
  git(ui, 'add', '.');
  git(ui, 'commit', '-q', '-m', 'primo');
  const storage = join(project, 'storage');
  mkdirSync(storage);
  git(storage, 'init', '-q', '-b', 'main');
  writeFileSync(join(storage, 'x.ts'), '1\n');
  git(storage, 'add', '.');
  git(storage, 'commit', '-q', '-m', 'primo');

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: appPath });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const panel = win.locator('.changes');
    // All clean: one quiet line, then one row per repo with its branch on the right; no ring,
    // no pills, no repeated "Clean" section.
    await expect(panel.locator('.clean-note')).toHaveText('All clean · 2 repos', { timeout: 10000 });
    await expect(panel.locator('.clean-ring, .clean-repo')).toHaveCount(0);
    const cleanRows = panel.locator('.clean-row');
    await expect(cleanRows).toHaveCount(2);
    await expect(cleanRows.filter({ hasText: 'app-ui' }).locator('.clean-branch')).toHaveText('dev');
    await expect(cleanRows.filter({ hasText: 'storage' }).locator('.clean-branch')).toHaveText('main');
    await expect(panel.locator('.clean')).toHaveCount(0);
    // The names flush with the check; the branches end where a group's count does.
    const left = (l: typeof panel) => l.evaluate((el) => Math.round(el.getBoundingClientRect().left));
    const nameX = await left(cleanRows.first().locator('.clean-name'));
    expect(await left(panel.locator('.clean-note > svg'))).toBe(nameX);
    const branchRight = await cleanRows.first().locator('.clean-branch').evaluate((el) => Math.round(el.getBoundingClientRect().right));
    await look(panel, 'test-results/changes-clean-start.png');

    // Changes made "by hand" (outside Claude): line 10 changed, a line added after 25, a new file.
    const changed = [...lines];
    changed[9] = 'export const v10 = 1000;';
    changed.splice(25, 0, 'export const nuova = true;');
    writeFileSync(appPath, changed.join('\n') + '\n');
    writeFileSync(join(ui, 'nuovo.ts'), 'a\nb\n');
    const appRow = panel.locator('.change-row', { hasText: 'App.tsx' });
    await expect(appRow).toContainText('+2 −1', { timeout: 8000 });
    await expect(panel.locator('.change-row', { hasText: 'nuovo.ts' })).toBeVisible();
    await expect(appRow.locator('.dot.unknown')).toBeVisible();
    // The first files arrive: app-ui's count ends where its branch did.
    const appHead = panel.locator('.change-group-head', { hasText: 'app-ui' });
    expect(await appHead.locator('.change-count').evaluate((el) => Math.round(el.getBoundingClientRect().right))).toBe(branchRight);

    // Two sessions "edit" the same file.
    for (const name of ['Alfa', 'Beta']) {
      await win.locator('.btn-new').click();
      await win.getByRole('menuitem', { name: 'Claude Session' }).click();
      await win.getByPlaceholder('Session name (optional)').fill(name);
      await win.keyboard.press('Enter');
      await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
    }
    // The notice is compact (spec compact clash notice): the sessions as avatars, the files as chips by name.
    const clash = panel.locator('.clash');
    await expect(clash).toContainText('on the same file', { timeout: 10000 });
    await expect(clash).toHaveAttribute('aria-label', /Alfa and Beta both touched 1 file/);
    await expect(clash.locator('.clash-avatar')).toHaveCount(2);
    // Both are done, and the ✓ badge would cover an 18 px avatar's initial: the state stays in the tooltip.
    await expect(clash.locator('.av-check, .av-done-dot')).toHaveCount(0);
    await expect(clash.getByRole('button', { name: 'Go to Beta' })).toBeVisible();
    const chip = clash.locator('.clash-chip', { hasText: 'App.tsx' });
    await expect(chip).toHaveText('App.tsx');
    await expect(appRow.locator('.dot:not(.unknown)')).toHaveCount(2);
    await look(win, 'test-results/changes-changes.png');
    await clash.locator('.clash-avatar').last().hover();
    await expect(win.locator('.tooltip')).toContainText('Click to go to this session');
    await look(win, 'test-results/changes-clash-tip.png');
    await chip.click();
    await expect(win.locator('.file-view:visible')).toBeVisible();
    // A file in front: no session row looks open, not even the last session shown.
    await expect(win.locator('.session-row.is-selected')).toHaveCount(0);
    await clash.getByRole('button', { name: 'Go to Beta' }).click();
    await expect(win.locator('.session-row.is-selected', { hasText: 'Beta' })).toBeVisible();

    await groupChanges(panel, 'session');
    const groups = panel.locator('.change-group');
    await expect(groups.filter({ hasText: 'Alfa' })).toContainText('App.tsx');
    await expect(groups.filter({ hasText: 'Beta' })).toContainText('App.tsx');
    await expect(groups.filter({ hasText: 'Unknown origin' })).toContainText('nuovo.ts');
    await groupChanges(panel, 'repo');

    // Diff and gutter.
    await appRow.click();
    const view = win.locator('.file-view:visible');
    await expect(view.locator('.cm-diff-del')).toHaveCount(1, { timeout: 10000 });
    await expect(view.locator('.cm-diff-add')).toHaveCount(2);
    // Syntax is colored in the Diff view too.
    await expect(view.locator('span[style*="var(--syn-keyword)"]').first()).toBeVisible({ timeout: 8000 });
    await look(win, 'test-results/changes-diff.png');
    await view.getByRole('button', { name: 'Margin' }).click();
    await expect(view.locator('.cm-git-mod')).toHaveCount(1, { timeout: 5000 });
    await expect(view.locator('.cm-git-add')).toHaveCount(1);
    await expect(view.locator('span[style*="var(--syn-keyword)"]').first()).toBeVisible({ timeout: 8000 });
    await look(win, 'test-results/changes-margin.png');

    // The file changes on disk again: the view updates by itself.
    writeFileSync(appPath, changed.join('\n') + '\nexport const fine = 1;\n');
    await expect(view.locator('.cm-content')).toContainText('export const fine = 1;', { timeout: 8000 });

    // Commit from outside: the panel empties and the attributions are pruned.
    git(ui, 'add', '-A');
    git(ui, 'commit', '-q', '-m', 'secondo');
    await expect(panel.locator('.clean-note')).toHaveText('All clean · 2 repos', { timeout: 8000 });
    await look(panel, 'test-results/changes-clean.png');
    // Compact rows (Show folders off): the names still under the check, the branches where the counts end.
    await setChangesFolders(panel, false);
    const compactX = await left(cleanRows.first().locator('.clean-name'));
    expect(await left(panel.locator('.clean-note > svg'))).toBe(compactX);
    const compactRight = await cleanRows.first().locator('.clean-branch').evaluate((el) => Math.round(el.getBoundingClientRect().right));
    // A long branch is cut with an ellipsis, the repository's name keeps its room.
    const longName = 'feature/a-branch-name-much-longer-than-the-room-in-this-panel';
    git(storage, 'checkout', '-q', '-b', longName);
    const longBranch = cleanRows.filter({ hasText: 'storage' }).locator('.clean-branch-text');
    await expect(longBranch).toHaveText(longName, { timeout: 10000 });
    expect(await longBranch.evaluate((s) => getComputedStyle(s).textOverflow === 'ellipsis' && s.scrollWidth > s.clientWidth)).toBe(true);
    await expect(cleanRows.filter({ hasText: 'storage' }).locator('.clean-name')).toHaveJSProperty('scrollWidth', await cleanRows.filter({ hasText: 'storage' }).locator('.clean-name').evaluate((n) => n.clientWidth));
    await look(panel, 'test-results/changes-clean-compact.png');
    writeFileSync(appPath, changed.join('\n') + '\nexport const ancora = 2;\n');
    await expect(appRow).toBeVisible({ timeout: 8000 });
    await expect(appRow.locator('.dot.unknown')).toBeVisible();
    await expect(appRow.locator('.dot:not(.unknown)')).toHaveCount(0);
    expect(await appHead.locator('.change-count').evaluate((el) => Math.round(el.getBoundingClientRect().right))).toBe(compactRight);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('the same-file notice: six files show four chips and "+2 more", by name and folder; renamed and closed sessions', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const repo = join(project, 'report-worker');
  const rels = ['CLAUDE.md', 'src/flows/chat.flow.ts', 'src/services/chat/agent/prompt.ts', 'src/agent/index.ts', 'src/flows/index.ts', 'src/tools.ts'];
  for (const rel of rels) { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), 'a\n'); }
  git(repo, 'init', '-q', '-b', 'dev');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'primo');
  for (const rel of rels) writeFileSync(join(repo, rel), 'b\n');

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: rels.map((r) => join(repo, r)).join(':') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    for (const name of ['Alfa', 'Beta']) {
      await win.locator('.btn-new').click();
      await win.getByRole('menuitem', { name: 'Claude Session' }).click();
      await win.getByPlaceholder('Session name (optional)').fill(name);
      await win.keyboard.press('Enter');
      await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
    }
    const clash = win.locator('.changes .clash');
    await expect(clash).toContainText('on the same 6 files', { timeout: 10000 });
    const chips = clash.locator('.clash-chip:not(.is-more)');
    // In the list's order (by path).
    await expect(chips).toHaveText(['CLAUDE.md', 'agent/index.ts', 'chat.flow.ts', 'flows/index.ts']);
    // A chip's name for a screen reader is its whole path, as its tooltip says.
    await expect(chips.nth(1)).toHaveAttribute('aria-label', 'report-worker/src/agent/index.ts');
    // The count reads whole; only the hint gives way when the row is short of room.
    expect(await clash.locator('.clash-what').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await look(clash, 'test-results/changes-clash-six.png');

    // "+2 more" from the keyboard: the rest show and the focus lands on the first of them.
    const more = clash.getByRole('button', { name: '+2 more' });
    await more.focus();
    await win.keyboard.press('Enter');
    await expect(chips).toHaveText(['CLAUDE.md', 'agent/index.ts', 'chat.flow.ts', 'flows/index.ts', 'prompt.ts', 'tools.ts']);
    await expect(chips.nth(4)).toBeFocused();
    await expect(more).toHaveCount(0);

    // Renamed: the card's sentence and its button follow the new name.
    const alfa = win.locator('.session-row', { hasText: 'Alfa' });
    await alfa.locator('.row-main').dblclick();
    await win.keyboard.press('Meta+A');
    await win.keyboard.type('Gamma');
    await win.keyboard.press('Enter');
    await expect(clash.getByRole('button', { name: 'Go to Gamma' })).toBeVisible();
    await expect(clash).toHaveAttribute('aria-label', /^Gamma and Beta both touched 6 files/);

    // Closed: its avatar stays, dimmed, and is no longer a button.
    const beta = win.locator('.session-row', { hasText: 'Beta' });
    await beta.hover();
    await beta.locator('.row-close').click();
    await win.locator('.session-row.is-confirming').getByRole('button', { name: /^Close/ }).click();
    await expect(beta).toHaveCount(0);
    await expect(clash.locator('.clash-avatar.is-closed')).toHaveCount(1);
    await expect(clash.getByRole('button', { name: 'Go to Beta' })).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
