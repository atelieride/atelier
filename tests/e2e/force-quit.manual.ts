import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDaemon } from '../../src/main/daemon-launcher';
import { Launchd, jobLabel } from '../../src/daemon/launchd';
import { connectControl } from '../integration/helpers';
import type { ServerMessage, TerminalInfo } from '../../src/shared/protocol';

// Manual check for session coalitions, with a person at the Dock:
//   FORCE_QUIT_DIR=<folder> npx playwright test --config playwright.manual.config.ts tests/e2e/force-quit.manual.ts
// A dev atelierd (temporary ATELIER_HOME, its own launchd job, no window) opens two terminals; terminal A starts
// "ForceQuitMe" (a renamed copy of Electron's default app, ad-hoc signed: Apple's own apps refuse to be launched from
// a third-party terminal, "Launch Constraint Violation"). When <folder>/FORCE_QUIT_READY appears, the person force-quits
// ForceQuitMe from the Dock. Expected: terminal B and atelierd live on. Terminal A lives on too when the app was alive
// (2026-10-15: Dock force quit of a live app ends that app only); a force quit of a ghost tile (main process gone,
// coalition alive) ends terminal A's coalition, never B's.
//
// Safety: this runner sits in the coalition of whatever started it, possibly the user's real Atelier and its
// sessions. No window of the dev app is shown (nothing else to click by mistake), and ForceQuitMe is announced only once
// it is proven to be in terminal A's coalition, which differs from the runner's and the dev atelierd's.

const HOST = resolve('vendor/bin/atelier-pty-host');
const coalition = (pid: number) => execFileSync(HOST, ['--coalition', String(pid)], { encoding: 'utf8' }).split(' ')[0]!;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a Dock force quit of an app started in one session ends that session only', async () => {
  test.setTimeout(12 * 60_000);
  const dir = mkdtempSync(join(tmpdir(), 'atl-fq-'));
  // Directly under the run's temp root: its global teardown boots out this home's jobs too.
  const home = mkdtempSync(join(tmpdir(), 'atl-fq-home-'));
  const zdot = mkdtempSync(join(tmpdir(), 'atl-zdot-'));
  const app = join(dir, 'ForceQuitMe.app');
  execFileSync('/bin/cp', ['-cR', resolve('node_modules/electron/dist/Electron.app'), app]);
  for (const [k, v] of [['CFBundleName', 'ForceQuitMe'], ['CFBundleDisplayName', 'ForceQuitMe'], ['CFBundleIdentifier', 'dev.useatelier.forcequitme']]) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${k}`, join(app, 'Contents/Info.plist')], { stdio: 'ignore' });
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${k} string ${v}`, join(app, 'Contents/Info.plist')]);
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'ignore' });
  const exe = join(app, 'Contents/MacOS/Electron');

  // The dev atelierd, as the app starts it: a launchd job of its own. Its shells read no user config (empty ZDOTDIR).
  process.env.ZDOTDIR = zdot;
  process.env.ATELIER_USER_CLAUDE_SETTINGS = '/nonexistent/atelier-fq-settings.json';
  const info = await ensureDaemon({ execPath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), script: resolve('out/main/daemon.js'), version: '0.0.0-fq', home });
  const c = await connectControl(info.sock, info.token);
  try {
    await c.next((m) => m.t === 'welcome');
    const create = async (rid: number): Promise<TerminalInfo> => {
      c.send({ t: 'create', rid, projectRoot: dir, cwd: dir, cols: 80, rows: 24 });
      return (await c.next((m) => m.t === 'reply' && m.rid === rid, 10000) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
    };
    const a = await create(1);
    const b = await create(2);
    const shells = () => [...readFileSync(join(home, 'logs', 'atelierd.log'), 'utf8').matchAll(/terminal (\S+): shell (\d+) started in launchd job, coalition (\d+)/g)].map((m) => ({ id: m[1]!, pid: Number(m[2]), coalition: m[3]! }));
    await expect.poll(() => shells().length, { timeout: 20000 }).toBe(2);
    const sa = shells().find((s) => s.id === a.id)!;
    const sb = shells().find((s) => s.id === b.id)!;
    const mine = coalition(process.pid);
    expect(new Set([mine, coalition(info.pid), sa.coalition, sb.coalition]).size).toBe(4);

    c.send({ t: 'input', id: a.id, data: `'${exe}' >/dev/null 2>&1 &!\r` });
    let appPid = 0;
    for (let t = 0; t < 150 && !appPid; t++) {
      try { appPid = Number(execFileSync('/usr/bin/pgrep', ['-n', '-f', `^${exe}`], { encoding: 'utf8' }).trim()); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    expect(appPid).toBeGreaterThan(0);
    // ForceQuitMe in terminal A's coalition, nobody else's: only then is the person asked to act.
    if (coalition(appPid) !== sa.coalition || coalition(appPid) === mine) {
      process.kill(appPid, 'SIGTERM');
      throw new Error('ForceQuitMe is not isolated in terminal A: stopped, nothing to force quit');
    }
    writeFileSync(join(process.env.FORCE_QUIT_DIR ?? dir, 'FORCE_QUIT_READY'), `ForceQuitMe ${appPid} coalition ${sa.coalition}\n`);

    await expect.poll(() => alive(appPid), { timeout: 10 * 60_000, intervals: [500] }).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    const after = { a: alive(sa.pid), b: alive(sb.pid), atelierd: alive(info.pid) };
    writeFileSync(join(process.env.FORCE_QUIT_DIR ?? dir, 'FORCE_QUIT_RESULT'), JSON.stringify(after) + '\n');
    expect(after).toMatchObject({ b: true, atelierd: true });
  } finally {
    c.close();
    try { process.kill(info.pid, 'SIGTERM'); } catch { /* already stopped */ }
    const ld = new Launchd({ runDir: join(home, 'run') });
    for (const kind of ['atelierd', 'session'] as const) for (const l of await ld.ownLabels(jobLabel(kind, home))) await ld.bootout(l);
  }
});
