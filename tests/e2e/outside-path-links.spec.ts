import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Any path in the terminal: a path Claude prints outside the project and outside its temp folder (a plan, another
// repository's file, /tmp) is a link only while ⌘ is held over it, and a ⌘-click opens it read-only; a restart keeps it
// read-only (main saves the mode), Open File… makes it editable. No `~/` path here: e2e runs keep the real HOME.

/** Claude's prose naming a plan it wrote, the path alone on its row. */
const PROSE = String.raw`
my $p = shift; binmode STDOUT, ':utf8';
print "\x{23FA} The plan is saved in\n  $p\n\nPLAN-DONE\n";
`;

function setupFiles() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-')));
  mkdirSync(join(base, 'plans'));
  const plan = join(base, 'plans', 'fuzzy-otter.md');
  writeFileSync(plan, '# The plan\n\nStep one.\n');
  const script = join(base, 'prose.pl');
  writeFileSync(script, PROSE);
  const { env, home } = e2eEnv({ ATELIER_TEST_PICK_FILES: plan });
  const launch = () => electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { plan, script, home, launch };
}

/** The centre of the path on the row after the one starting with `head`. */
async function pathPoint(win: Page, head: string) {
  return win.evaluate((head) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    const row = rows[rows.findIndex((r) => (r.textContent ?? '').startsWith(head)) + 1]!;
    const r = row.getBoundingClientRect();
    const cell = r.width / Math.max(1, (row.textContent ?? '').length);
    return { x: r.left + cell * 12, y: r.top + r.height / 2 };
  }, head);
}

const pointer = (win: Page) => win.locator('.xterm-screen.xterm-cursor-pointer');

/** Prints the prose in a new terminal; the pointer rests on the path, ⌘ not held. */
async function printPlan(win: Page, script: string, plan: string) {
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 10000 });
  await win.locator('.xterm-helper-textarea').focus();
  await win.keyboard.type(`clear; perl ${script} ${plan}\n`);
  await expect(win.locator('.xterm-rows')).toContainText('PLAN-DONE', { timeout: 10000 });
  const p = await pathPoint(win, '⏺ The plan is saved in');
  await win.mouse.move(p.x - 3, p.y);
  await win.mouse.move(p.x, p.y);
  return p;
}

/** ⌘ held over the path shows the link; a ⌘-click opens it; the plan's tab is in front. */
async function cmdOpen(win: Page, p: { x: number; y: number }) {
  await win.keyboard.down('Meta');
  await expect.poll(() => pointer(win).count(), { timeout: 5000 }).toBeGreaterThan(0);
  await win.mouse.click(p.x, p.y);
  await win.keyboard.up('Meta');
  await expect(win.locator('.file-view:visible .crumb b')).toHaveText('fuzzy-otter.md', { timeout: 10000 });
}

function stop(home: string) {
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

test('a path outside the project: no link without ⌘, a link while ⌘ is held over it; ⌘-click opens it read-only, Outside project; Open File… makes it editable', async () => {
  const { plan, script, home, launch } = setupFiles();
  const app = await launch();
  const win = await app.firstWindow();
  try {
    const p = await printPlan(win, script, plan);
    // Without ⌘ nothing shows (main is never asked), and a plain click opens nothing.
    await win.waitForTimeout(800);
    expect(await pointer(win).count()).toBe(0);
    await win.mouse.click(p.x, p.y);
    await win.waitForTimeout(500);
    await expect(win.locator('.file-view:visible')).toHaveCount(0);

    await win.mouse.move(p.x - 3, p.y);
    await win.mouse.move(p.x, p.y);
    await cmdOpen(win, p);
    const view = win.locator('.file-view:visible');
    await expect(view.locator('.file-note.is-outside')).toHaveText('Outside project');
    await expect(view.locator('.file-note.is-outside')).toHaveAttribute('data-tip', /read-only: open it with Open File…/);
    await expect(view.locator('.cm-content')).toContainText('# The plan');
    await expect(view.locator('.file-foot')).toContainText('Read-only');
    await view.locator('.cm-content').click();
    await win.keyboard.type('XYZ');
    await expect(view.locator('.cm-content')).not.toContainText('XYZ');
    expect(readFileSync(plan, 'utf8')).toBe('# The plan\n\nStep one.\n');
    await look(win, 'test-results/outside-path-read-only.png', { settle: 400 });

    // Picked with Open File… (a gesture): the same tab becomes editable, and ⌘S writes it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-file'));
    await expect(view.locator('.file-foot')).toContainText('Saved', { timeout: 10000 });
    await view.locator('.cm-line', { hasText: 'Step one.' }).click();
    await win.keyboard.press('End');
    await win.keyboard.type(' Two.');
    await win.keyboard.press('Meta+s');
    await expect.poll(() => readFileSync(plan, 'utf8')).toBe('# The plan\n\nStep one. Two.\n');
  } finally {
    await app.close();
    stop(home);
  }
});

test('after a relaunch the tab of a path opened from a link comes back read-only (main saved the mode)', async () => {
  const { plan, script, home, launch } = setupFiles();
  let app = await launch();
  const win = await app.firstWindow();
  try {
    await cmdOpen(win, await printPlan(win, script, plan));
    const saved = () => { try { return (JSON.parse(readFileSync(join(home, 'tabs.json'), 'utf8')) as { projects: Record<string, { readOnly?: string[] }> }); } catch { return null; } };
    await expect.poll(() => Object.values(saved()?.projects ?? {}).flatMap((e) => e.readOnly ?? [])).toEqual([plan]);
    await app.close();

    app = await launch();
    const again = await app.firstWindow();
    const tab = again.locator('.tab', { hasText: 'fuzzy-otter.md' });
    await expect(tab).toHaveCount(1, { timeout: 15000 });
    await tab.click();
    const view = again.locator('.file-view:visible');
    await expect(view.locator('.cm-content')).toContainText('# The plan', { timeout: 10000 });
    await expect(view.locator('.file-foot')).toContainText('Read-only');
    await view.locator('.cm-content').click();
    await again.keyboard.type('XYZ');
    await expect(view.locator('.cm-content')).not.toContainText('XYZ');
  } finally {
    await app.close();
    stop(home);
  }
});
