import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { homeHash } from '../../src/daemon/launchd';

// Session coalitions: in the real app, atelierd and each terminal run in launchd
// jobs of their own, so a Dock force quit of an app started in one terminal ends that terminal only. Coalitions are
// read with the native host's --coalition (proc_pidinfo); the shells' pids and coalitions come from atelierd's log.

const HOST = resolve('vendor/bin/atelier-pty-host');
const coalition = (pid: number) => execFileSync(HOST, ['--coalition', String(pid)], { encoding: 'utf8' }).split(' ')[0]!;
const labels = () => execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' }).split('\n').map((l) => l.split('\t')[2]?.trim() ?? '');

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

test('atelierd and every terminal run in launchd jobs of their own, at normal priority; closed terminals leave no job', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const hash = homeHash(home);
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await menu(app, 'New Terminal');
    const log = () => { try { return readFileSync(join(home, 'logs', 'atelierd.log'), 'utf8'); } catch { return ''; } };
    const shells = () => [...log().matchAll(/terminal (\S+): shell (\d+) started in launchd job, coalition (\d+)/g)].map((m) => ({ id: m[1]!, pid: Number(m[2]), coalition: m[3]! }));
    await expect.poll(() => shells().length, { timeout: 15000 }).toBe(2);
    const [a, b] = shells();
    const daemonPid = (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;

    // Three coalitions: atelierd's, A's, B's; none of them the app window's.
    const own = new Set([coalition(daemonPid), a!.coalition, b!.coalition]);
    expect(own.size).toBe(3);
    expect(own.has(coalition(app.process().pid!))).toBe(false);
    expect(coalition(a!.pid)).toBe(a!.coalition);
    // Interactive priority, as before (launchd's default for jobs would throttle a build or a test suite: 20). ps reads
    // the current priority, which a shell still starting under a loaded suite can hold boosted for a moment (46 seen):
    // it settles at 31.
    await expect.poll(() => execFileSync('/bin/ps', ['-o', 'pri=', '-p', String(a!.pid)], { encoding: 'utf8' }).trim(), { timeout: 10000 }).toBe('31');
    expect(labels()).toEqual(expect.arrayContaining([`dev.useatelier.atelierd.${hash}`, `dev.useatelier.session.${hash}.${a!.id}`, `dev.useatelier.session.${hash}.${b!.id}`]));

    // The terminals work as before: input reaches the shell, its output comes back.
    await win.keyboard.type('echo CO""ALITION-$((6*7))\n');
    await expect.poll(() => win.locator('.xterm-rows').last().innerText(), { timeout: 10000 }).toContain('COALITION-42');

    // Closing a terminal ends its job.
    await win.keyboard.type('exit\n');
    await expect.poll(() => labels().filter((l) => l.startsWith(`dev.useatelier.session.${hash}.`)).length, { timeout: 10000 }).toBe(1);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
