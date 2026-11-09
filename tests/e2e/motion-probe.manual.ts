import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

// Idle motion probe: CPU of each Electron process in a few UI states, on an isolated
// hidden instance. Hidden windows skip CoreAnimation, so the figures are relative; the real ones come from a packaged
// app.
// Run: npm run build && npx playwright test --config playwright.manual.config.ts tests/e2e/motion-probe.manual.ts

const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
}
async function measure(app: ElectronApplication, win: Page, label: string) {
  await app.evaluate(({ app }) => app.getAppMetrics());
  await win.waitForTimeout(10000);
  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu.percentCPUUsage })));
  const sum = (t: string) => m.filter((p) => p.type === t).reduce((s, p) => s + p.cpu, 0).toFixed(1);
  console.log(`${label.padEnd(36)} GPU ${sum('GPU').padStart(5)}%  renderer ${sum('Tab').padStart(5)}%  main ${sum('Browser').padStart(5)}%`);
}

test('idle motion probe', async () => {
  test.setTimeout(600000);
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  try {
    await win.waitForTimeout(4000);
    await measure(app, win, 'empty project');
    for (const n of ['A', 'B', 'C', 'D']) await newSession(win, n);
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    await win.waitForTimeout(20000); // cues end
    await measure(app, win, '4 waiting, at rest, window active');
    // Where the renderer's residual goes at rest: a 10 s CPU profile, top self time.
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    await win.waitForTimeout(10000);
    const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[] } };
    const count = new Map<number, number>();
    for (const s of profile.samples) count.set(s, (count.get(s) ?? 0) + 1);
    const top = profile.nodes.map((n) => ({ n: count.get(n.id) ?? 0, f: `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}` }))
      .filter((x) => x.n > 0 && !/^\((idle|program|garbage collector)\)/.test(x.f)).sort((a, b) => b.n - a.n).slice(0, 15);
    console.log(`profile: ${profile.samples.length} samples\n${top.map((x) => `${String(x.n).padStart(5)}  ${x.f}`).join('\n')}`);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* stopped */ }
  }
});
