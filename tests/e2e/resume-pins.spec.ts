import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Pins survive "To resume": after an atelierd restart the pinned sessions wait first in
// To resume with their badge; resuming another one first drops no pin; a resumed pinned session comes back pinned.
// Resume starts claude --resume in a new terminal, and that terminal's screen shows Claude: the view attaches as soon as
// the resume reply arrives, so main must already know the terminal then (it once refused the attach until atelierd's
// next list, and the screen stayed blank for good).

/** Looked at by hand (git-ignored). */
const SHOTS = resolve('e2e-shots/small-asks');
const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;

test('pinned sessions stay pinned through an atelierd restart and a resume; the resumed session shows its screen', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  // Resumables need a real session id (a UUID): the three fake sessions share one, their terminals tell them apart.
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: '77777777-7777-4777-8777-777777777777' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  try {
    await expect(win.locator('.header')).toBeVisible();
    for (const name of ['Alfa', 'Beta', 'Gamma']) {
      await win.evaluate((n) => (window as unknown as { atelier: AtelierApi }).atelier.terminals.createSession({ cols: 100, rows: 30, name: n }), name);
      await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
    }
    // Pin Gamma, then Alfa.
    for (const name of ['Gamma', 'Alfa']) {
      await win.locator('.session-row', { hasText: name }).click({ button: 'right' });
      await win.getByRole('menuitem', { name: 'Pin' }).click();
    }

    const first = daemonPid(home);
    process.kill(first, 'SIGTERM');
    const rows = win.locator('.resume-row');
    await expect(rows).toHaveCount(3, { timeout: 30000 });
    await expect.poll(() => { try { return daemonPid(home); } catch { return first; } }, { timeout: 30000 }).not.toBe(first);
    // Pinned first, in pin order, with the badge; the other one after them.
    await expect(rows.locator('.resume-title')).toHaveText(['Gamma', 'Alfa', 'Beta']);
    await expect(rows.nth(0).locator('.av-pin')).toBeVisible();
    await expect(rows.nth(1).locator('.av-pin')).toBeVisible();
    await expect(rows.nth(2).locator('.av-pin')).toHaveCount(0);
    await win.mouse.move(0, 0);
    await look(win.locator('.sidebar'), join(SHOTS, 'resume-pinned.png'), { settle: 500 });

    // Its name (cut by an ellipsis when long) shows in full in its tooltip, as on a live session's row.
    await rows.filter({ hasText: 'Beta' }).locator('.resume-title').hover();
    await expect(win.locator('.tooltip .tooltip-text')).toHaveText('Beta');
    await win.mouse.move(0, 0);

    // An unpinned one resumed first: before, its terminal pruned every other pin.
    await rows.filter({ hasText: 'Beta' }).getByRole('button', { name: 'Resume' }).click();
    await expect(win.locator('.session-row', { hasText: 'Beta' })).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('FAKE-CLAUDE args=--resume 77777777-7777-4777-8777-777777777777', { timeout: 15000 });
    await look(win, 'test-results/resume-after-restart.png');
    await expect(rows.locator('.resume-title')).toHaveText(['Gamma', 'Alfa']);
    await expect(rows.locator('.av-pin')).toHaveCount(2);

    // A pinned one comes back pinned, at the top of the sessions.
    await rows.filter({ hasText: 'Gamma' }).getByRole('button', { name: 'Resume' }).click();
    const gamma = win.locator('.session-row', { hasText: 'Gamma' });
    await expect(gamma).toBeVisible({ timeout: 15000 });
    await expect(gamma.locator('.av-pin')).toBeVisible();
    await expect(win.locator('.session-row .session-title').first()).toHaveText('Gamma');
    await expect(win.locator('.session-row', { hasText: 'Beta' }).locator('.av-pin')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});
