import { _electron as electron, expect, test } from '@playwright/test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Regression (2026-10-11): `base64 -i ~/Desktop/missing.p12 | gh secret set …` pasted into an Atelier terminal blanked
// the whole window. base64 (the pipeline's process group leader) exits at once while gh still runs: node-pty's
// `process` is then undefined on macOS, atelierd's list had no `foreground`, and the sidebar row threw on render.
// Never the real gh: a fake one, first on PATH (checked before the command runs), reads stdin and prints gh's lines.
// HOME is a temporary folder: `~/Desktop/…` never reaches the user's Desktop.

test('a pipeline whose first command exits at once keeps the window alive (no foreground name)', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const fakeHome = mkdtempSync(join(tmpdir(), 'atl-home-'));
  mkdirSync(join(fakeHome, 'Desktop'));
  const bin = mkdtempSync(join(tmpdir(), 'atl-bin-'));
  // It outlives base64 by more than one foreground poll (1 s) before printing.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
cat > /dev/null
sleep 2
printf '\\033[0;32m✓\\033[0m Set Actions secret MAC_CERT_P12 for acme/shop\\n'
printf '\\n\\n\\033[0;33mA new release of gh is available:\\033[0m \\033[0;36m2.88.1\\033[0m → \\033[0;36m2.102.0\\033[0m\\n\\033[0;33mTo upgrade, run: brew upgrade gh\\033[0m\\n\\033[0;33mhttps://github.com/cli/cli/releases/tag/v2.102.0\\033[0m\\n\\n' >&2
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const { env, home } = e2eEnv({ HOME: fakeHome });
  // In front of /etc/zprofile's path_helper too.
  appendFileSync(join(env.ZDOTDIR!, '.zprofile'), `path=('${bin}' $path)\n`);
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const screen = win.locator('.xterm-rows:visible');
    await expect(screen).toContainText(/main ›/, { timeout: 10000 });

    await win.keyboard.type(`[ "$(command -v gh)" = '${bin}/gh' ] && echo FAKE-GH-$((40+2))`);
    await win.keyboard.press('Enter');
    // Never go on with the real gh: the shell must say the fake one is in front.
    await expect(screen).toContainText('FAKE-GH-42', { timeout: 5000 });

    // Pasted through the terminal's own paste handler (a synthetic event: the real clipboard is never read).
    const cmd = 'base64 -i ~/Desktop/shop-signing.p12 | gh secret set MAC_CERT_P12 -R acme/shop';
    await win.locator('.terminal-slot:visible .xterm-helper-textarea').evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, cmd);
    await expect(screen).toContainText('acme/shop', { timeout: 5000 });
    await win.keyboard.press('Enter');

    // While gh runs alone the foreground has no name: the test really went through that state.
    await expect.poll(() => win.evaluate(async () => {
      const [t] = await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list();
      return t?.foreground;
    }), { timeout: 3000, intervals: [100] }).toBe('');
    await expect(screen).toContainText('releases/tag/v2.102.0', { timeout: 10000 });
    await expect(win.locator('.terminal-slot')).toHaveCount(1);
    await expect(win.locator('.term-row')).toHaveCount(1);
    expect(errors).toEqual([]);
    await look(win, 'test-results/foreground-pipeline.png');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
