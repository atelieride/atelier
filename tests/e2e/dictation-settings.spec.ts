import { _electron as electron, expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

test('Settings › Dictation: enabling, steps with their state, model download and removal, try it', async () => {
  // Fake model served locally (300 KB, real hash): the download, verification and removal are the real ones.
  const body = randomBytes(300_000);
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Length': String(body.length) }); res.end(body); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m.bin`;
  const spec = { file: 'm.bin', url, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'),
    ATELIER_TEST_FAKE_MIC: resolve('tests/fixtures/dictation-it.wav'),
    ATELIER_TEST_WHISPER_BIN: resolve('tests/fixtures/fake-whisper.mjs'),
    ATELIER_TEST_MODEL_SPEC: JSON.stringify(spec),
    ATELIER_TEST_POLISH: 'upper',
    FAKE_WHISPER_TEXT: 'prova di dettatura'
  });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Dictation' }).click();
    const enable = dialog.getByRole('switch', { name: 'Enable dictation' });
    await expect(enable).toHaveAttribute('aria-checked', 'false');
    await enable.click();
    await expect(enable).toHaveAttribute('aria-checked', 'true');

    const step = (name: string) => dialog.locator('.dict-step', { hasText: name });
    await expect(step('Microphone')).toContainText('Granted');
    await expect(step('Speech model')).toContainText('Not downloaded');
    await expect(step('Polish with Claude')).toContainText('Available');
    await step('Speech model').getByRole('button', { name: /Download/ }).click();
    await expect(step('Speech model')).toContainText('Ready', { timeout: 15000 });
    await expect(step('Engine')).toContainText(/Ready|Loading/, { timeout: 10000 });
    await look(win, 'test-results/dictation-settings.png');

    // Try it: dictate (test WAV) and see the polished text, without sessions.
    await dialog.getByRole('button', { name: 'Try it' }).click();
    await expect(dialog.locator('.dict-try')).toContainText('Listening');
    await win.waitForTimeout(800);
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await expect(dialog.locator('.dict-try-result')).toContainText('PROVA DI DETTATURA', { timeout: 10000 });

    await step('Speech model').getByRole('button', { name: 'Remove' }).click();
    await expect(step('Speech model')).toContainText('Not downloaded');
    expect(JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')).dictationEnabled).toBe(true);
  } finally {
    await app.close();
    server.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
