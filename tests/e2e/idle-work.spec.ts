import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

// Idle work: what changes nothing on screen sends nothing to the window.

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

function gitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('/usr/bin/git', ['init', '-q', dir]);
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  execFileSync('/usr/bin/git', ['-C', dir, 'add', '.']);
  execFileSync('/usr/bin/git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'out', 'seed.js'), 'seed\n');
  return dir;
}
async function launch(project: string): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow() };
}
async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}
const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
/** Counts what main sends to the window, per channel, from now on. */
async function countSends(app: ElectronApplication): Promise<() => Promise<Record<string, number>>> {
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    const g = globalThis as unknown as { __sent: Record<string, number>; __wrapped?: boolean };
    g.__sent = {};
    if (g.__wrapped) return;
    g.__wrapped = true;
    const orig = wc.send.bind(wc);
    wc.send = (ch: string, ...args: unknown[]) => { g.__sent[ch] = (g.__sent[ch] ?? 0) + 1; orig(ch, ...args); };
  });
  return () => app.evaluate(() => ({ ...(globalThis as unknown as { __sent: Record<string, number> }).__sent }));
}
/** Long enough for a status read asked for to reach the window: twice the scheduler's 1 s between reads of a repo. */
const STATUS_WINDOW_MS = 2000;
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

test('a write under a gitignored folder sends no git status but still tells the window the file changed; a tracked file does; the same content again sends nothing; a status line that changes nothing sends no list, one that changes the context does', async () => {
  test.setTimeout(120000);
  const project = gitProject();
  const { app, home, win } = await launch(project);
  try {
    // The first status may reach the window before the count starts (it does on a fast start), so a
    // file is added first: a status reaching the window says main read the repository, and listed what git
    // ignores (started with it, when the repository was found). Once that read's interval is over, the count restarts.
    let sent = await countSends(app);
    writeFileSync(join(project, 'b.ts'), 'export const b = 1;\n');
    await expect.poll(async () => (await sent())['ev:git'] ?? 0, { timeout: 10000 }).toBeGreaterThan(0);
    await win.waitForTimeout(1000);
    sent = await countSends(app);
    for (let i = 0; i < 5; i++) writeFileSync(join(project, 'out', `b${i}.js`), `x${i}\n`);
    // The batch reached the window; a status it asked for would start within the scheduler's minimum interval
    // (1 s between two reads of a repo, git/service.ts) and reach the window soon after: watched for twice that.
    await expect.poll(async () => (await sent())['ev:fs-changed'] ?? 0, { timeout: 8000 }).toBeGreaterThan(0);
    await win.waitForTimeout(STATUS_WINDOW_MS);
    expect((await sent())['ev:git'] ?? 0).toBe(0);
    writeFileSync(join(project, 'a.ts'), 'export const a = 2;\n');
    await expect.poll(async () => (await sent())['ev:git'] ?? 0, { timeout: 8000 }).toBeGreaterThan(0);
    // Saved again with the same content: a new status read, the same snapshot, nothing sent (checkedAt aside). Once
    // the last read's interval is over, so this write's read is not merged into it.
    await win.waitForTimeout(1000);
    sent = await countSends(app);
    writeFileSync(join(project, 'a.ts'), 'export const a = 2;\n');
    await expect.poll(async () => (await sent())['ev:fs-changed'] ?? 0, { timeout: 8000 }).toBeGreaterThan(0);
    await win.waitForTimeout(STATUS_WINDOW_MS);
    expect((await sent())['ev:git'] ?? 0).toBe(0);

    // A status line that changes nothing sends no list; one that changes the context does.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('S');
    await win.keyboard.press('Enter');
    await expect(row(win, 'S')).toHaveClass(/state-waiting/, { timeout: 20000 });
    // The fake starts on a permission request, which takes the first line typed: answer it, let the turn end.
    await typeInto(win, 'S', '\r');
    await expect(row(win, 'S')).toHaveClass(/state-done/, { timeout: 10000 });
    sent = await countSends(app);
    await typeInto(win, 'S', 'ev:ctx:61\r');
    // Its lists arrive, and so may the turn's finish (held for attention's finish window): wait for a quiet second,
    // then the same line again.
    await expect.poll(async () => (await sent())['ev:terminals'] ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    for (let last = -1, now = (await sent())['ev:terminals'] ?? 0; now !== last; ) {
      await win.waitForTimeout(1000);
      [last, now] = [now, (await sent())['ev:terminals'] ?? 0];
    }
    sent = await countSends(app);
    await typeInto(win, 'S', 'ev:ctx:61\r');
    await win.waitForTimeout(1000);
    expect((await sent())['ev:terminals'] ?? 0).toBe(0);
    await typeInto(win, 'S', 'ev:ctx:62\r');
    await expect.poll(async () => (await sent())['ev:terminals'] ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
  } finally {
    await stop(app, home);
  }
});
