import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// A new Claude session is a session from the first frame: while Claude starts (the fake one waits before its
// SessionStart) its row is under Sessions with "Starting…", never a terminal under Terminals that jumps a moment later;
// its tab and bar carry its avatar. When the session arrives the same row (same element) carries on. The fake starts
// once the test has looked (ATELIER_FAKE_START_GATE): each session waits for the gate file, then removes it.

const SHOTS = 'test-results';

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

test('a new session shows as a starting session (never under Terminals) and becomes the session in place', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const gate = join(mkdtempSync(join(tmpdir(), 'atl-gate-')), 'start');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_START_GATE: gate });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    // A plain terminal first: the Terminals section is there, and the new session must never show up in it.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    // Anything that ever shows "Delta" as a terminal (sidebar row, tab or bar glyph) is recorded.
    await win.evaluate(() => {
      const w = window as unknown as { asTerminal: string[] };
      w.asTerminal = [];
      const check = () => {
        for (const el of document.querySelectorAll('.term-row')) if (el.textContent?.includes('Delta')) w.asTerminal.push('term-row');
        for (const el of document.querySelectorAll('.tab')) if (el.textContent?.includes('Delta') && el.querySelector('.tab-term')) w.asTerminal.push('tab glyph');
        for (const el of document.querySelectorAll('.pane-head')) if (el.textContent?.includes('Delta') && el.querySelector('.ph-icon')) w.asTerminal.push('pane glyph');
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Delta');
    await win.keyboard.press('Enter');

    // Starting: under Sessions, "Starting…" (plain text), the avatar in its tab and in the session bar.
    const row = win.locator('.session-row', { hasText: 'Delta' });
    await expect(row).toHaveClass(/is-starting/, { timeout: 2500 });
    await expect(row.locator('.session-activity')).toHaveText('Starting…');
    await expect(row.locator('.session-activity')).not.toHaveClass(/shimmer/);
    await expect(row.locator('.avatar')).toHaveCount(1);
    await expect(win.getByRole('list', { name: 'Terminals' }).locator('.term-row', { hasText: 'Delta' })).toHaveCount(0);
    await expect(win.locator('.sidebar-head', { hasText: 'Sessions' }).locator('.count')).toHaveText('1');
    const tab = win.locator('.tab', { hasText: 'Delta' });
    await expect(tab.locator('.avatar')).toHaveCount(1);
    await expect(tab.locator('.tab-term')).toHaveCount(0);
    const bar = win.locator('.workspace > .session-bar');
    await expect(bar).toHaveClass(/is-starting/);
    // No state chip: "Starting…" takes the activity's place, as plain text, until the session arrives.
    await expect(bar.locator('.state-chip')).toHaveCount(0);
    await expect(bar.locator('.sb-activity')).toHaveText('Starting…');
    await expect(bar.locator('.sb-activity')).not.toHaveClass(/shimmer/);
    // Above a single terminal no avatar or name (the tab right above has them).
    await expect(bar.locator('.avatar, .sb-title')).toHaveCount(0);
    // Not "waiting": the footer counts nothing and the workspace has no waiting glow.
    await expect(win.locator('.workspace-body.is-waiting')).toHaveCount(0);
    await row.evaluate((el) => { el.setAttribute('data-e2e-mark', 'starting'); });
    await look(win.locator('.sidebar'), `${SHOTS}/starting-sidebar.png`, { settle: 250 });
    await look(row, `${SHOTS}/starting-row.png`);
    await look(bar, `${SHOTS}/starting-bar.png`);
    await look(win, `${SHOTS}/starting-window.png`);

    // The session arrives (the fake asks for a permission): the same row element carries on, now a normal session.
    writeFileSync(gate, '');
    await expect(row).toHaveClass(/state-waiting/, { timeout: 15000 });
    await expect(row).not.toHaveClass(/is-starting/);
    await expect(row).toHaveAttribute('data-e2e-mark', 'starting');
    await expect(row.locator('.session-activity')).not.toHaveText('Starting…');
    await expect(bar).not.toHaveClass(/is-starting/);
    await expect(bar.locator('.sb-activity')).not.toHaveText('Starting…');
    expect(await win.evaluate(() => (window as unknown as { asTerminal: string[] }).asTerminal)).toEqual([]);
    await look(win.locator('.sidebar'), `${SHOTS}/starting-sidebar-after.png`, { settle: 250 });

    // In a split pane: under its strip (its tab says who, with the avatar), the new session's (starting) session bar.
    await menu(app, 'Split Right');
    await win.locator('.pane-picker').getByRole('button', { name: /New session/ }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Echo');
    await win.keyboard.press('Enter');
    const head = win.locator('.workspace-body > .session-bar.is-focused');
    await expect(head).toHaveClass(/is-starting/, { timeout: 2500 });
    await expect(win.locator('.pane-strip.is-focused .tab.is-active')).toContainText('Echo');
    await expect(win.locator('.pane-strip.is-focused .tab.is-active .avatar')).toHaveCount(1);
    await expect(head.locator('.sb-activity')).toHaveText('Starting…');
    // A narrow pane hides the activity, but never "Starting…": it is the only sign the session is on its way.
    expect(await head.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(560);
    await expect(head.locator('.sb-activity')).toBeVisible();
    await look(win.locator('.workspace'), `${SHOTS}/starting-split.png`, { settle: 250 });
    writeFileSync(gate, '');
    await expect(win.locator('.session-row', { hasText: 'Echo' })).toHaveClass(/state-waiting/, { timeout: 15000 });
    await expect(head).not.toHaveClass(/is-starting/);
  } finally {
    await stop(app, home);
  }
});
