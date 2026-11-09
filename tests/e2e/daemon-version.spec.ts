import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { daemonFingerprint } from '../../src/main/daemon-fingerprint';
import { ensureDaemon } from '../../src/main/daemon-launcher';
import { e2eEnv } from './env';
import { look } from './shots';

// The footer said "atelierd 1.6.0-beta.8 · restart it to update" after every app update: atelierd echoes the version
// of the app that started it and the app compared versions. It now compares the code atelierd runs (fingerprint), and
// the footer shows the app's own version.

const electronBin = require('electron') as unknown as string;
const electronVersion = (JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')) as { version: string }).version;
const daemonScript = resolve('out/main/daemon.js');

/** An atelierd started by "an older app" (0.0.1) running the given code: the app then attaches to it. */
async function olderDaemon(home: string, fingerprint: string): Promise<void> {
  await ensureDaemon({ execPath: electronBin, script: daemonScript, version: `0.0.1+${fingerprint}`, home });
}

async function launch(sameCode: boolean) {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const { env, home } = e2eEnv();
  await olderDaemon(home, sameCode ? daemonFingerprint(daemonScript, electronVersion) : '0000000000000000');
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  // Unpackaged, Electron reports its own version: the footer must show whatever the app reports.
  const appVersion = await app.evaluate(({ app }) => app.getVersion());
  return { app, appVersion, win: await app.firstWindow(), stop };
}

test('an atelierd started by an older app with the same code: no restart asked, the footer shows the app version', async () => {
  const { win, appVersion, stop } = await launch(true);
  try {
    const footer = win.locator('footer.footer');
    await expect(footer.locator('.foot-dim', { hasText: `v${appVersion}` })).toBeVisible({ timeout: 15000 });
    await expect(footer).not.toContainText('0.0.1');
    await expect(footer).not.toContainText('restart it to update');
    await expect(footer.getByRole('button', { name: 'Restart atelierd' })).toHaveCount(0);
    await look(win, 'test-results/daemon-version-same-code.png');
  } finally {
    await stop();
  }
});

test('an atelierd running other code asks for a restart, naming the app version that started it', async () => {
  const { win, appVersion, stop } = await launch(false);
  try {
    const footer = win.locator('footer.footer');
    await expect(footer).toContainText('atelierd from 0.0.1 is out of date: restart it to update.', { timeout: 15000 });
    await expect(footer.locator('.foot-dim', { hasText: `v${appVersion}` })).toBeVisible();
    await expect(footer).not.toContainText('0000000000000000');
    await look(win, 'test-results/daemon-version-other-code.png');
  } finally {
    await stop();
  }
});
