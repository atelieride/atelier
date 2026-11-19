import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Changes' Show › This session and This activity: only what the session or activity in front changed, each choice
// offered only when its feature is on, in a list that fits the narrowest panel.

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l && it.visible) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

const LONG = 'Alfa refactoring the authentication callback and its tests';

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
}

/** Opens Filters, picks a Show choice, closes it. */
async function show(panel: Locator, name: string) {
  await panel.getByRole('button', { name: /^Filters/ }).click();
  const pop = panel.getByRole('dialog', { name: 'Filters' });
  await pop.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name, exact: true }).click();
  await pop.press('Escape');
  await expect(pop).toHaveCount(0);
}

const rowNames = (panel: Locator) => panel.locator('.change-row .change-name').allTextContents();

test('Changes › Show: this session follows the Claude session in front, this activity the activity in front; each offered only when on', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'hand.ts']) writeFileSync(join(project, f), '1\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  const byName = `Alfa=${join(project, 'a.ts')};Beta=${join(project, 'b.ts')};Gamma=${join(project, 'c.ts')}`;
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT_BY_NAME: byName });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    const panel = win.locator('aside.changes');
    const funnel = panel.getByRole('button', { name: /^Filters/ });
    const pop = panel.getByRole('dialog', { name: 'Filters' });
    await expect(panel.locator('.clean-note')).toHaveText('Working tree clean', { timeout: 10000 });
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'hand.ts']) writeFileSync(join(project, f), '2\n');
    await expect(panel.locator('.change-row')).toHaveCount(4, { timeout: 8000 });

    // Workspaces off: Show offers All and This session.
    await funnel.click();
    await expect(pop.getByRole('radiogroup', { name: 'Show' }).getByRole('radio')).toHaveText([/^All/, /^This session/]);
    await win.keyboard.press('Escape');

    // No session yet: nothing to show, said so, with the way back to All.
    await show(panel, 'This session');
    await expect(panel.locator('.change-row')).toHaveCount(0);
    await expect(panel.locator('.clean-note')).toContainText('No session in front');
    await expect(funnel).toHaveAttribute('aria-label', 'Filters · this session');
    await look(panel, 'test-results/changes-scope-no-session.png');
    // Under the pointer it lights with a fill, not an underline as well.
    const showAll = panel.getByRole('button', { name: 'Show all' });
    await showAll.hover();
    expect(await showAll.evaluate((b) => getComputedStyle(b).textDecorationLine)).toBe('none');
    await showAll.click();
    await expect(panel.locator('.change-row')).toHaveCount(4);
    await expect(funnel).toHaveAttribute('aria-label', 'Filters');

    // Two sessions, each editing its own file; hand.ts is nobody's.
    await newSession(win, LONG);
    await expect(panel.locator('.change-row', { hasText: 'a.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    await newSession(win, 'Beta');
    await expect(panel.locator('.change-row', { hasText: 'b.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });

    // This session: Beta is in front, only its file; the strip's count follows.
    await show(panel, 'This session');
    await expect.poll(() => rowNames(panel)).toEqual(['b.ts']);
    await expect(win.locator('.changes-toggle')).toHaveText('1');
    await expect(funnel).toHaveClass(/is-lit/);
    await look(panel, 'test-results/changes-scope-session.png');
    // Alfa to the front: Changes follows, its rows shown without the flash of a file that just changed (watched from
    // before the click, so a flash however short is seen).
    await panel.evaluate((el) => {
      const w = window as unknown as { flashed: boolean };
      w.flashed = false;
      new MutationObserver(() => { if (el.querySelector('.change-row.is-new')) w.flashed = true; })
        .observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    await win.locator('.session-row', { hasText: 'Alfa' }).click();
    await expect.poll(() => rowNames(panel)).toEqual(['a.ts']);
    expect(await win.evaluate(() => (window as unknown as { flashed: boolean }).flashed)).toBe(false);
    // A plain terminal in front keeps the last session's.
    await win.locator('.btn-new').click();
    // The plain terminal, not "Terminal with Profile" or "Terminal in Folder…" (an item's name ends with its shortcut).
    await win.getByRole('menuitem', { name: /^Terminal(?!\s*(with|in)\b)/ }).click();
    await expect(win.locator('.tab-strip .tab')).toHaveCount(3, { timeout: 10000 });
    await expect.poll(() => rowNames(panel)).toEqual(['a.ts']);

    // The option names what it follows; at the narrowest panel each option keeps one line, the name cut.
    await funnel.click();
    const opt = (name: string) => pop.getByRole('radio', { name, exact: true });
    await expect(opt('This session')).toContainText(LONG);
    await look(pop, 'test-results/changes-scope-pop.png', { settle: 300 });
    await win.keyboard.press('Escape');
    await panel.evaluate((el) => el.style.setProperty('--changes-w', '240px'));
    await funnel.click();
    const fit = await pop.evaluate((p) => {
      const panelBox = p.closest('aside')!.getBoundingClientRect(), box = p.getBoundingClientRect();
      const opts = [...p.querySelectorAll('.cf-opt')].map((o) => {
        const label = o.querySelector('.cf-opt-label')!, name = o.querySelector('.cf-opt-name');
        const line = parseFloat(getComputedStyle(label).lineHeight);
        return { oneLine: label.getBoundingClientRect().height <= line * 1.5, cut: name ? name.scrollWidth > name.clientWidth : null, inside: o.getBoundingClientRect().right <= box.right };
      });
      return { inside: box.left >= panelBox.left && box.right <= panelBox.right, opts };
    });
    expect(fit.inside).toBe(true);
    expect(fit.opts.every((o) => o.oneLine && o.inside)).toBe(true);
    expect(fit.opts.at(-1)!.cut).toBe(true);
    await look(pop, 'test-results/changes-scope-pop-narrow.png', { settle: 300 });
    // The arrows move the choice, Up and Down too.
    await opt('This session').focus();
    await win.keyboard.press('ArrowUp');
    await expect(opt('All')).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('ArrowDown');
    await expect(opt('This session')).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Escape');
    await panel.evaluate((el) => el.style.removeProperty('--changes-w'));

    // Workspaces and activities on: four choices, widest first.
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(win.locator('.ws-group.is-active')).toContainText('Workspace 1');
    await menu(app, 'Activities Inside Workspaces');
    const ws1 = win.locator('.ws-group', { has: win.locator('.ws-name', { hasText: /^Workspace 1$/ }) });
    await ws1.locator('.ws-head').hover();
    await ws1.locator('.ws-plus').click();
    await win.getByRole('menuitem', { name: 'New Activity…' }).click();
    const input = win.locator('.wsa-head .rename-input');
    await input.fill('SSO');
    await input.press('Enter');
    await newSession(win, 'Gamma');
    await expect(panel.locator('.change-row', { hasText: 'c.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    await funnel.click();
    await expect(pop.getByRole('radiogroup', { name: 'Show' }).getByRole('radio')).toHaveText([/^All/, /^This workspace/, /^This activity/, /^This session/]);
    await expect(opt('This activity')).toContainText('SSO');
    await look(pop, 'test-results/changes-scope-pop-activities.png', { settle: 300 });
    await win.keyboard.press('Escape');
    // All four at the narrowest panel: each label whole on one line, inside its row and the popover.
    await panel.evaluate((el) => el.style.setProperty('--changes-w', '240px'));
    await funnel.click();
    const four = await pop.evaluate((p) => {
      const box = p.getBoundingClientRect();
      return [...p.querySelectorAll('.cf-opt')].map((o) => {
        const l = o.querySelector('.cf-opt-label')!.getBoundingClientRect(), r = o.getBoundingClientRect();
        return l.right <= r.right && r.right <= box.right && l.height < 24;
      });
    });
    expect(four).toEqual([true, true, true, true]);
    await look(pop, 'test-results/changes-scope-pop-activities-narrow.png', { settle: 300 });
    await win.keyboard.press('Escape');
    await panel.evaluate((el) => el.style.removeProperty('--changes-w'));
    await show(panel, 'This activity');
    await expect.poll(() => rowNames(panel)).toEqual(['c.ts']);
    await expect(funnel).toHaveAttribute('aria-label', 'Filters · this activity');
    await look(panel, 'test-results/changes-scope-activity.png');

    // Activities off: This activity is no longer offered, every change shows again, the funnel goes dark.
    await menu(app, 'Activities Inside Workspaces');
    await expect(panel.locator('.change-row')).toHaveCount(4);
    await expect(funnel).toHaveAttribute('aria-label', 'Filters');
    await funnel.click();
    await expect(pop.getByRole('radiogroup', { name: 'Show' }).getByRole('radio')).toHaveText([/^All/, /^This workspace/, /^This session/]);
    await win.keyboard.press('Escape');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
