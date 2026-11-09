// Settings › Terminal and Editor keep their preview docked at the top of the pane while the rows scroll under it.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

async function launch(prefs?: Record<string, unknown>): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  if (prefs) writeFileSync(join(home, 'preferences.json'), JSON.stringify(prefs));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow() };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function openSection(win: Page, name: string): Promise<Locator> {
  await win.getByRole('button', { name: 'Settings' }).click();
  const dialog = win.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name, exact: true }).click();
  await expect(dialog.locator('.set-content .set-preview')).toBeVisible();
  return dialog;
}

type Box = { top: number; bottom: number };
type Geometry = { scrollTop: number; scrollMax: number; paneHeight: number; pane: Box; preview: Box; dock: Box | null; docked: boolean; frost: string | null; last: Box };

/** Where the pane, the preview (and its band) and the last row are, in window coordinates. */
const geometry = (win: Page): Promise<Geometry> => win.evaluate(() => {
  const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
  const pane = document.querySelector('.set-content')!;
  const dock = pane.querySelector('.set-preview-dock');
  const rows = pane.querySelectorAll('.set-row');
  return {
    scrollTop: pane.scrollTop, scrollMax: pane.scrollHeight - pane.clientHeight, paneHeight: pane.clientHeight,
    pane: box(pane), preview: box(pane.querySelector('.set-preview')!), dock: dock ? box(dock) : null,
    docked: !!dock?.classList.contains('is-docked'), frost: dock ? getComputedStyle(dock, '::before').opacity : null,
    last: box(rows[rows.length - 1]!)
  };
});

const scrollPane = (win: Page, to: 'top' | 'bottom') => win.evaluate((where) => {
  const pane = document.querySelector('.set-content')!;
  pane.scrollTop = where === 'top' ? 0 : pane.scrollHeight;
}, to);

/** Scrolled to the bottom, the preview's band is still flush with the top of the pane and the last row is in view. */
async function expectDockedAtBottom(win: Page) {
  await scrollPane(win, 'bottom');
  const g = await geometry(win);
  expect(g.scrollMax, 'the section scrolls').toBeGreaterThan(40);
  expect(g.scrollTop).toBeGreaterThan(0);
  expect(g.preview.top, 'the preview stays in view').toBeGreaterThanOrEqual(g.pane.top);
  expect(g.preview.bottom).toBeLessThan(g.pane.top + (g.pane.bottom - g.pane.top) / 2);
  expect(g.docked).toBe(true);
  expect(Math.abs(g.dock!.top - g.pane.top), 'no row peeks above the band').toBeLessThanOrEqual(1);
  expect(g.last.bottom).toBeLessThanOrEqual(g.pane.bottom + 1);
  expect(g.last.top).toBeGreaterThanOrEqual(g.dock!.bottom - 1);
}

test('Settings › Editor: the preview stays docked at the top while the rows scroll under it', async () => {
  const { app, home, win } = await launch();
  try {
    const dialog = await openSection(win, 'Editor');
    // At rest the band is transparent: the sheet looks as it always did.
    await expect.poll(async () => (await geometry(win)).frost).toBe('0');
    await expectDockedAtBottom(win);
    // Rows passing under it: the band turns frosted.
    await expect.poll(async () => (await geometry(win)).frost).toBe('1');
    await look(win, 'test-results/settings-dock-editor-scrolled.png', { settle: 400 });

    // A control the keyboard reaches while it sits under the band scrolls out from under it, its focus ring too: hidden
    // behind the band (Chromium centers it) and half under its edge (Chromium aligns it to the nearest edge).
    const wrap = dialog.getByRole('switch', { name: 'Word wrap' });
    for (const where of ['behind', 'straddling'] as const) {
      await scrollPane(win, 'top');
      await win.evaluate((at) => {
        const pane = document.querySelector('.set-content')!;
        const dock = pane.querySelector('.set-preview-dock')!.getBoundingClientRect();
        const sw = pane.querySelector('[role="switch"][aria-label="Word wrap"]')!.getBoundingClientRect();
        pane.scrollTop += sw.top - (at === 'behind' ? dock.top + dock.height / 2 : dock.bottom - sw.height / 2);
      }, where);
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await wrap.evaluate((el) => (el as HTMLElement).focus());
      await expect(wrap).toBeFocused();
      await expect.poll(async () => {
        const g = await geometry(win);
        const sw = await wrap.boundingBox();
        return sw!.y - g.dock!.bottom;
      }, { message: `${where}: the focused switch and its 3.5 px focus ring are below the band` }).toBeGreaterThanOrEqual(4);
    }
  } finally {
    await stop(app, home);
  }
});

test('Settings › Terminal: the preview stays docked at the top while the rows scroll under it', async () => {
  // In a light theme: the frosted band is the sheet's own color, whatever the theme.
  const { app, home, win } = await launch({ theme: 'daylight' });
  try {
    await openSection(win, 'Terminal');
    await expectDockedAtBottom(win);
    await expect.poll(async () => (await geometry(win)).frost).toBe('1');
    await look(win, 'test-results/settings-dock-terminal-scrolled.png', { settle: 400 });
  } finally {
    await stop(app, home);
  }
});

test('Edit output triggers… scrolls the triggers into view below the docked preview, not under it', async () => {
  // Enough rules for the section to be taller than the pane: the scroll can bring its start right under the band.
  const triggers = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, pattern: `pattern ${i}`, action: 'notify', scope: 'all', enabled: false }));
  const { app, home, win } = await launch({ triggers });
  try {
    // atelierd connected first, as in real use: its rows (shell environment, aliases…) appear above the triggers once it
    // answers, and would move them after the scroll.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toBeVisible({ timeout: 10000 });
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Edit output triggers');
    await win.keyboard.press('Enter');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('heading', { name: 'Terminal' })).toBeVisible();
    const section = dialog.getByRole('region', { name: 'Triggers' });
    await expect(section.getByRole('switch', { name: 'Trigger pattern 5 enabled' })).toBeAttached();
    const gap = async () => (await section.boundingBox())!.y - (await geometry(win)).dock!.bottom;
    // Scrolled to its start, not clamped at the end of the pane: right below the band, with the FOCUS_ROOM (6 px) and
    // the section's own 8 px scroll margin in between.
    await expect.poll(gap, { message: 'the Triggers section starts below the band' }).toBeGreaterThanOrEqual(0);
    await expect.poll(gap, { message: 'the Triggers section starts right below the band' }).toBeLessThanOrEqual(16);
    await look(win, 'test-results/settings-dock-triggers.png', { settle: 400 });
  } finally {
    await stop(app, home);
  }
});

test('Settings › Editor: a preview taller than half the pane scrolls away, and docks again once it fits', async () => {
  const { app, home, win } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 600));
    const dialog = await openSection(win, 'Editor');
    await dialog.getByRole('switch', { name: 'Word wrap' }).click();
    const bigger = dialog.getByRole('button', { name: 'Increase Font size' });
    while (await bigger.isEnabled()) await bigger.click();
    await expect(dialog.getByRole('group', { name: 'Font size' })).toContainText('24 px');
    await expect.poll(async () => (await geometry(win)).docked).toBe(false);
    await scrollPane(win, 'bottom');
    const g = await geometry(win);
    const band = g.dock!.bottom - g.dock!.top;
    // Not a coin toss on the threshold: the band is well over half the pane (diagnosable if fonts or sizes move).
    expect(band, `band ${band} px, pane ${g.paneHeight} px`).toBeGreaterThan(g.paneHeight / 2 + 20);
    expect(g.scrollTop).toBeGreaterThan(0);
    expect(g.preview.bottom, 'the preview scrolled away with the rows').toBeLessThan(g.pane.top);
    await look(win, 'test-results/settings-dock-too-tall.png');

    // Back to a size that leaves the controls most of the pane: it docks again, live.
    const smaller = dialog.getByRole('button', { name: 'Decrease Font size' });
    for (let i = 0; i < 11; i++) await smaller.click();
    await expect(dialog.getByRole('group', { name: 'Font size' })).toContainText('13 px');
    await expectDockedAtBottom(win);
  } finally {
    await stop(app, home);
  }
});
