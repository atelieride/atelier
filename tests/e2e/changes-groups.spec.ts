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

function repo(dir: string, branch: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
}

test('Changes: collapsible groups (click, keyboard, ⌥-click, remembered), compact mode, and a file that joins the list flashes in', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const ui = join(project, 'app-ui');
  const storage = join(project, 'storage');
  repo(ui, 'dev', { 'src/App.tsx': '1\n', 'src/components/Button.tsx': '1\n' });
  repo(storage, 'main', { 'x.ts': '1\n', 'y.ts': '1\n', 'z.ts': '1\n' });
  const appPath = join(ui, 'src', 'App.tsx');

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: appPath });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const panel = win.locator('.changes');
    await expect(panel).toContainText('All clean · 2 repos', { timeout: 10000 });
    writeFileSync(appPath, '2\n');
    writeFileSync(join(ui, 'src', 'components', 'Button.tsx'), '2\n');
    writeFileSync(join(storage, 'x.ts'), '2\n');
    await expect(panel.locator('.change-row')).toHaveCount(3, { timeout: 8000 });

    // One session "edits" App.tsx, so By session has two groups.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Alfa brainstorming the app UI with sessions and files');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    await expect(panel.locator('.change-row', { hasText: 'App.tsx' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 10000 });
    await look(panel, 'test-results/changes-normal.png');

    // The group header is a real button with aria-expanded; a collapsed group keeps its count.
    const head = (name: string) => panel.locator('.change-group-head', { hasText: name });
    const group = (name: string) => panel.locator('.change-group', { has: win.locator('.change-group-head', { hasText: name }) });
    await expect(head('app-ui')).toHaveJSProperty('tagName', 'BUTTON');
    await expect(head('app-ui')).toHaveAttribute('aria-expanded', 'true');
    await head('app-ui').click();
    await expect(head('app-ui')).toHaveAttribute('aria-expanded', 'false');
    await expect(group('app-ui').locator('.change-row')).toHaveCount(0);
    await expect(head('app-ui')).toContainText('2 files');
    await expect(group('storage').locator('.change-row')).toHaveCount(1);
    // The chevron turns back to point right once the rotation ends.
    await win.mouse.move(5, 300);
    await expect(head('app-ui').locator('.change-group-chev')).toHaveCSS('transform', 'none');
    await look(panel, 'test-results/changes-collapsed.png');

    // Keyboard: Enter on the focused header expands it again.
    await head('app-ui').focus();
    await win.keyboard.press('Enter');
    await expect(head('app-ui')).toHaveAttribute('aria-expanded', 'true');
    await expect(group('app-ui').locator('.change-row')).toHaveCount(2);

    // ⌥-click: every group follows the clicked one.
    await head('storage').click({ modifiers: ['Alt'] });
    await expect(panel.locator('.change-group-head[aria-expanded="false"]')).toHaveCount(2);
    await expect(panel.locator('.change-row')).toHaveCount(0);
    await head('storage').click({ modifiers: ['Alt'] });
    await expect(panel.locator('.change-group-head[aria-expanded="true"]')).toHaveCount(2);

    // By session: its own groups, its own states.
    await head('app-ui').click();
    await groupChanges(panel, 'session');
    await expect(head('Alfa')).toHaveAttribute('aria-expanded', 'true');
    // A long session name is cut with an ellipsis on one line; the file count never wraps.
    const lines = await head('Alfa').evaluate((h) => {
      const one = (el: Element) => { const r = el.getBoundingClientRect(); return r.height <= parseFloat(getComputedStyle(el).lineHeight) * 1.5; };
      const title = h.querySelector('.change-group-title')!;
      return { title: one(title), count: one(h.querySelector('.change-count')!), cut: title.scrollWidth > title.clientWidth };
    });
    expect(lines).toEqual({ title: true, count: true, cut: true });
    await look(panel, 'test-results/changes-by-session-long-name.png');
    await head('Unknown origin').click({ modifiers: ['Alt'] });
    await expect(head('Alfa')).toHaveAttribute('aria-expanded', 'false');
    await expect(head('Unknown origin')).toHaveAttribute('aria-expanded', 'false');
    await expect(head('Unknown origin')).toContainText('2 files');
    await groupChanges(panel, 'repo');
    await expect(head('app-ui')).toHaveAttribute('aria-expanded', 'false');
    await expect(head('storage')).toHaveAttribute('aria-expanded', 'true');

    // The head: the label and its count, Review, the funnel; grouping, scope and folders are
    // in the Filters popover, which a click outside closes.
    await expect(panel.locator('.changes-head .seg')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Show folders' })).toHaveCount(0);
    const funnel = panel.getByRole('button', { name: /^Filters/ });
    await funnel.click();
    const pop = panel.getByRole('dialog', { name: 'Filters' });
    await expect(pop.getByRole('radio', { name: 'Repository' })).toHaveAttribute('aria-checked', 'true');
    await expect(pop.getByRole('radiogroup', { name: 'Show' })).toHaveCount(0);
    await look(panel, 'test-results/changes-filters.png', { settle: 300 });
    // A click on the popover's own text keeps the focus in it: Esc still closes it, back on the funnel.
    await pop.locator('.cf-k').first().click();
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(funnel).toBeFocused();
    // The focus leaving it closes it, through the funnel too (Shift+Tab to the funnel, then to Review).
    await funnel.click();
    await expect(pop.getByRole('radio', { name: 'Repository' })).toBeFocused();
    await win.keyboard.press('Shift+Tab');
    await expect(funnel).toBeFocused();
    await expect(pop).toBeVisible();
    await win.keyboard.press('Shift+Tab');
    await expect(pop).toHaveCount(0);
    // A press outside closes it.
    await funnel.click();
    await panel.locator('.changes-head .section-label').click();
    await expect(pop).toHaveCount(0);

    // Rows with their folder by default: two lines.
    await head('app-ui').click();
    await expect(panel).not.toHaveClass(/is-compact/);
    await expect(panel.locator('.change-dir')).toHaveCount(3);
    await look(panel, 'test-results/changes-expanded.png');
    // Show folders off compacts them: one line per file, path in the tooltip, small icons, short rows.
    await setChangesFolders(panel, false);
    await expect(panel).toHaveClass(/is-compact/);
    await expect(panel.locator('.change-dir')).toHaveCount(0);
    const button = panel.locator('.change-row', { hasText: 'Button.tsx' });
    // The tooltip keeps the delta, which a narrow panel hides.
    await expect(button).toHaveAttribute('title', 'src/components/Button.tsx · +1 −1');
    const box = (await button.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(24);
    expect((await button.locator('svg').first().boundingBox())!.width).toBe(14);
    await look(panel, 'test-results/changes-compact.png');

    // Remembered: after a reload, the rows are still compact and app-ui collapsed again.
    await head('app-ui').click();
    await win.reload();
    await expect(panel).toHaveClass(/is-compact/, { timeout: 10000 });
    await expect(head('app-ui')).toHaveAttribute('aria-expanded', 'false', { timeout: 10000 });
    await expect(head('storage')).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('.change-dir')).toHaveCount(0);

    // Palette command: the folders again.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>folders in changes');
    await expect(win.locator('.palette-item', { hasText: 'Show folders in Changes' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(panel).not.toHaveClass(/is-compact/);
    await expect(panel.locator('.change-dir')).toHaveCount(1);

    // A file that joins the list flashes in; the ones already listed (here: since the reload) never do. (Unknown origin
    // opened first, for the regrouping below.)
    await groupChanges(panel, 'session');
    await head('Unknown origin').click();
    await expect(head('Unknown origin')).toHaveAttribute('aria-expanded', 'true');
    await groupChanges(panel, 'repo');
    const row = (name: string) => panel.locator('.change-row', { hasText: name });
    await expect(row('x.ts')).not.toHaveClass(/\bis-new\b/);
    writeFileSync(join(storage, 'y.ts'), '2\n');
    await expect(row('y.ts')).toHaveClass(/\bis-new\b/, { timeout: 8000 });
    await expect(row('x.ts')).not.toHaveClass(/\bis-new\b/);
    // Tinted while it flashes (then the tint fades out).
    expect(await row('y.ts').evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
    await look(panel, 'test-results/changes-flash.png');
    // A row remounted mid-flash (here: By session regroups every row) carries on, it doesn't start over.
    await win.waitForTimeout(500);
    await groupChanges(panel, 'session');
    const into = () => row('y.ts').evaluate((el) => {
      const a = el.getAnimations().find((x) => (x as CSSAnimation).animationName === 'atl-flash-in');
      // Its progress (the negative delay that carries it on doesn't show in currentTime): null once over.
      return a ? a.effect!.getComputedTiming().progress ?? null : null;
    });
    const p = await into();
    expect(p === null || p > 0.3).toBe(true);
    await groupChanges(panel, 'repo');
    // It lasts a moment, then the row is plain again.
    await expect(row('y.ts')).not.toHaveClass(/\bis-new\b/, { timeout: 3000 });

    // A collapsed group: its count pulses instead.
    await head('storage').click();
    await expect(head('storage')).toHaveAttribute('aria-expanded', 'false');
    writeFileSync(join(storage, 'z.ts'), '2\n');
    await expect(head('storage').locator('.change-count')).toHaveClass(/\bis-new\b/, { timeout: 8000 });
    await expect(head('storage')).toContainText('3 files');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
