import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Dictation with test audio (a WAV in place of the microphone, never the real microphone), fake engine and fake polish (uppercase): no real microphone, no
// real model, no real Claude.
async function launch(o: { enabled?: boolean; extra?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; win: Page; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const spec = { file: 'm.bin', url: 'http://127.0.0.1:9/m.bin', size: 3, sha256: 'a'.repeat(64) };
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'),
    ATELIER_TEST_FAKE_MIC: resolve('tests/fixtures/dictation-it.wav'),
    ATELIER_TEST_WHISPER_BIN: resolve('tests/fixtures/fake-whisper.mjs'),
    ATELIER_TEST_MODEL_SPEC: JSON.stringify(spec),
    ATELIER_TEST_POLISH: 'upper',
    FAKE_WHISPER_TEXT: 'rinomina la funzione',
    ...o.extra
  });
  mkdirSync(join(home, 'models'));
  writeFileSync(join(home, 'models', 'm.bin'), 'abc');
  writeFileSync(join(home, 'models', 'm.bin.ok'), spec.sha256);
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ dictationEnabled: o.enabled ?? true }));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  return { app, win, home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function claudeSession(win: Page) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row').first()).toHaveClass(/state-waiting/, { timeout: 20000 });
}

async function hold(win: Page, ms: number, shift = false) {
  await win.keyboard.down('Alt');
  if (shift) await win.keyboard.down('Shift');
  await win.keyboard.down('Space');
  await win.waitForTimeout(ms);
  await win.keyboard.up('Space');
  if (shift) await win.keyboard.up('Shift');
  await win.keyboard.up('Alt');
}

// (Holds last a little over TAP_MS, 300 ms: shorter is a tap.)
test('hold ⌥Space: pill, polished text in the prompt without Enter; ⇧ raw; tap = hands-free, Enter stops it; Esc cancels; dictation off opens nothing', async () => {
  const { app, win, home } = await launch();
  try {
    await claudeSession(win);
    const rows = win.locator('.xterm-rows:visible');
    const pill = win.locator('.dictation-pill');

    await win.keyboard.down('Alt');
    await win.keyboard.down('Space');
    await expect(pill).toContainText('Listening');
    // Centred in its pane once its entrance is over (the entrance animation once ended on `transform: none`, which
    // dropped the centring: the pill hung from the middle to the right, over the next panel).
    await expect.poll(() => pill.evaluate((el) => el.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity && a.playState !== 'finished').length)).toBe(0);
    const centres = await pill.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const p = ((el as HTMLElement).offsetParent as HTMLElement).getBoundingClientRect();
      return { pill: Math.round(r.left + r.width / 2), pane: Math.round(p.left + p.width / 2) };
    });
    expect(Math.abs(centres.pill - centres.pane)).toBeLessThanOrEqual(1);
    await look(win, 'test-results/dictation-pill.png');
    // Held past a tap (TAP_MS 300) whatever the entrance took (Reduce motion makes it instant).
    await win.waitForTimeout(350);
    await win.keyboard.up('Space');
    await win.keyboard.up('Alt');
    await expect(rows).toContainText('RINOMINA LA FUNZIONE', { timeout: 10000 });
    await expect(rows).not.toContainText('FAKE-CLAUDE done');
    await expect(pill).toHaveCount(0, { timeout: 5000 });

    await hold(win, 450, true);
    await expect(rows).toContainText('rinomina la funzione', { timeout: 10000 });

    // Short tap: hands-free until another tap.
    await hold(win, 80);
    await expect(pill).toContainText('Listening');
    await win.waitForTimeout(400);
    await expect(pill).toContainText('Listening');
    await hold(win, 80);
    await expect(pill).toHaveCount(0, { timeout: 10000 });

    // Hands-free, Enter stops and transcribes instead of sending the message.
    const polished = async () => ((await rows.textContent()) ?? '').split('RINOMINA LA FUNZIONE').length - 1;
    const already = await polished();
    await hold(win, 80);
    await expect(pill).toContainText('Listening');
    await win.waitForTimeout(400);
    await win.keyboard.press('Enter');
    await expect.poll(polished, { timeout: 10000 }).toBe(already + 1);
    await expect(pill).toHaveCount(0, { timeout: 5000 });
    // Enter did not reach Claude: the fake Claude, given an Enter, would print "done".
    await win.waitForTimeout(500);
    await expect(rows).not.toContainText('FAKE-CLAUDE done');

    // Esc cancels: no new text.
    const before = (await rows.textContent()) ?? '';
    await hold(win, 80);
    await expect(pill).toContainText('Listening');
    await win.keyboard.press('Escape');
    await expect(pill).toHaveCount(0);
    await win.waitForTimeout(800);
    expect((await rows.textContent()) ?? '').toBe(before);

    // Dictation off: ⌥Space opens nothing and the microphone is not in the bar.
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ dictationEnabled: false }));
    await expect(win.getByRole('button', { name: /Dictate/ })).toHaveCount(0);
    await hold(win, 450);
    await expect(pill).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('engine that crashes: error with Try again, which resends the same audio and inserts the text', async () => {
  const counter = join(mkdtempSync(join(tmpdir(), 'atl-crash-')), 'n');
  const { app, win, home } = await launch({ extra: { FAKE_WHISPER_CRASH_UNTIL: `${counter},2` } });
  try {
    await claudeSession(win);
    await win.getByRole('button', { name: /Dictate/ }).click();
    await expect(win.locator('.dictation-pill')).toContainText('Listening');
    await win.waitForTimeout(400);
    await win.getByRole('button', { name: /Dictate/ }).click();
    const pill = win.locator('.dictation-pill');
    await expect(pill).toContainText('Transcription failed', { timeout: 10000 });
    await pill.getByRole('button', { name: 'Try again' }).click();
    await expect(win.locator('.xterm-rows:visible')).toContainText('RINOMINA LA FUNZIONE', { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('Esc during "Transcribing…": cancels, no text, and Esc does not reach Claude', async () => {
  const { app, win, home } = await launch({ extra: { FAKE_WHISPER_DELAY_MS: '600' } });
  try {
    await claudeSession(win);
    const rows = win.locator('.xterm-rows:visible');
    const pill = win.locator('.dictation-pill');
    await hold(win, 450);
    await expect(pill).toContainText('Transcribing');
    await win.keyboard.press('Escape');
    await expect(pill).toHaveCount(0);
    // Past the engine's answer (600 ms after the hold).
    await win.waitForTimeout(1200);
    await expect(rows).not.toContainText('RINOMINA LA FUNZIONE');
    await expect(rows).not.toContainText('^[');
  } finally {
    await stop(app, home);
  }
});

