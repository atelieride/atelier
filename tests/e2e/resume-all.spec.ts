import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Resume all / Resume pinned: the Resume head's pills; sessions come back one
// at a time (each once the previous one's Claude has started), with "n of N", a progress bar and Stop at the top of
// Sessions (it stays put while the sessions coming back push the list down); the queued rows say so; Stop leaves the
// rest under Resume. Every fake Claude here starts only when the test opens its gate.

const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;

test('Resume pinned, then Resume all: one at a time with its progress; Stop leaves the rest under Resume', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const gate = join(mkdtempSync(join(tmpdir(), 'atl-gate-')), 'go');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: '99999999-9999-4999-8999-999999999999', ATELIER_FAKE_START_GATE: gate });
  /** One waiting Claude starts (it takes the gate file away). */
  const release = async () => {
    writeFileSync(gate, '');
    await expect.poll(() => existsSync(gate), { timeout: 15000 }).toBe(false);
  };
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  try {
    await expect(win.locator('.header')).toBeVisible();
    for (const name of ['Alfa', 'Beta', 'Gamma', 'Delta']) {
      void win.evaluate((n) => (window as unknown as { atelier: AtelierApi }).atelier.terminals.createSession({ cols: 100, rows: 30, name: n }), name);
      await release();
      await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
    }
    await expect.poll(() => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).filter((t) => t.session).length), { timeout: 15000 }).toBe(4);
    for (const name of ['Gamma', 'Delta']) {
      await win.locator('.session-row', { hasText: name }).click({ button: 'right' });
      await win.getByRole('menuitem', { name: 'Pin' }).click();
    }
    // atelierd restarts: the four wait under Resume.
    const first = daemonPid(home);
    process.kill(first, 'SIGTERM');
    const rows = win.locator('.resume-row');
    await expect(rows).toHaveCount(4, { timeout: 30000 });
    await expect.poll(() => { try { return daemonPid(home); } catch { return first; } }, { timeout: 30000 }).not.toBe(first);
    const head = win.locator('.resume-head');
    const run = win.locator('.resume-run');
    const pinned = head.getByRole('button', { name: 'Resume pinned sessions' });
    await expect(pinned).toContainText('2');
    await expect(head.getByRole('button', { name: 'Resume all sessions' })).toBeVisible();
    await win.mouse.move(0, 0);
    await look(win.locator('.sidebar'), 'test-results/resume-all-pills.png', { settle: 400 });

    // Resume pinned: Gamma first; Delta waits for Gamma's Claude, queued meanwhile.
    await pinned.click();
    await expect(run).toContainText('1 of 2');
    await expect(win.locator('.session-row', { hasText: 'Gamma' })).toBeVisible({ timeout: 15000 });
    // Measured once its entrance (a scale) has ended.
    await run.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const stopAt = await run.getByRole('button', { name: 'Stop' }).boundingBox();
    await expect(rows.filter({ hasText: 'Delta' })).toHaveClass(/is-queued/);
    await expect(rows.filter({ hasText: 'Delta' })).toContainText('Queued');
    await look(win.locator('.sidebar'), 'test-results/resume-all-progress.png', { settle: 300 });
    await release();
    await expect(run).toContainText('2 of 2');
    // Gamma's row came in above: Stop has not moved.
    await expect(win.locator('.session-row', { hasText: 'Delta' })).toBeVisible({ timeout: 15000 });
    expect(await run.getByRole('button', { name: 'Stop' }).boundingBox()).toEqual(stopAt);
    await release();
    await expect(run).toHaveCount(0, { timeout: 15000 });
    await expect(rows).toHaveCount(2);
    expect((await rows.locator('.resume-title').allTextContents()).sort()).toEqual(['Alfa', 'Beta']);
    await expect(pinned).toHaveCount(0);

    // Resume all, stopped after the first: the one starting finishes, the other stays under Resume.
    await head.getByRole('button', { name: 'Resume all sessions' }).click();
    await expect(run).toContainText('1 of 2');
    await expect(win.locator('.resume-row.is-queued')).toHaveCount(1);
    await run.getByRole('button', { name: 'Stop' }).click();
    await release();
    await expect(run).toHaveCount(0, { timeout: 15000 });
    await expect(rows).toHaveCount(1);
    await expect(rows.locator('.resume-btn')).toBeVisible();
    await expect(win.locator('.session-row')).toHaveCount(3);

    // The last one: its row (and the Resume section) leave at once, yet "1 of 1" stays until its Claude has started.
    await head.getByRole('button', { name: 'Resume all sessions' }).click();
    await expect(rows).toHaveCount(0, { timeout: 15000 });
    await expect(win.locator('.resume-head')).toHaveCount(0);
    await expect(run).toContainText('1 of 1');
    await release();
    await expect(run).toHaveCount(0, { timeout: 15000 });
    await expect(win.locator('.session-row')).toHaveCount(4);
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});
