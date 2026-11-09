import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Session name sync: the e2e atelierd is this build's (capability 'names'); the fake Claude reads
// the hook bridge's output like Claude Code does and takes a sessionTitle from it ("ev:prompt"), and simulates a
// /rename typed in Claude ("ev:rename:<name>") and an AI title arriving ("ev:ai:<title>").

type Api = { terminals: { list(): Promise<{ id: string; title: string; name: string | null; nameSync?: string }[]>; input(id: string, data: string): void } };

async function launch(project: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.header')).toBeVisible();
  return { app, home, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  if (name) await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
}

/** Types into a session's prompt without selecting it. */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

const terms = (win: Page) => win.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).map((t) => ({ title: t.title, name: t.name, nameSync: t.nameSync ?? null })));
const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

test('a rename in Atelier shows at once, reaches Claude with the next message; a /rename in Claude and an AI title show in Atelier', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { app, home, win } = await launch(project);
  try {
    // Named at creation: claude --name=…, Claude already has it (nothing pending).
    await newSession(win, 'Alpha');
    await expect(row(win, 'Alpha')).toHaveClass(/state-waiting/, { timeout: 20000 });
    await typeInto(win, 'Alpha', '\r');
    await expect(row(win, 'Alpha')).toHaveClass(/state-done/, { timeout: 10000 });
    await row(win, 'Alpha').click();
    // The tab carries the name: the session bar above a single terminal has neither name nor avatar (2026-11-01).
    const title = win.locator('.tab.is-active .tab-name');
    await expect(title).toHaveText('Alpha');
    await expect(title).not.toHaveClass(/name-pending/);
    await expect(win.locator('.session-bar')).toBeVisible();
    await expect(win.locator('.session-bar .sb-title, .session-bar .avatar')).toHaveCount(0);

    // Rename from the Session panel: in the tab, shown at once everywhere, pending until the next message.
    await win.locator('.session-bar .sb-model').click();
    await win.locator('.spanel-action', { hasText: 'Rename' }).click();
    const inTab = win.locator('.tab .tab-rename');
    await expect(inTab).toBeFocused();
    await inTab.fill('Login bug');
    await win.keyboard.press('Enter');
    await expect(row(win, 'Login bug')).toBeVisible();
    await expect(title).toHaveText('Login bug');
    await expect(title).toHaveClass(/name-pending/);
    // The full name heads the tab's tip, then its folder, then where Claude stands on the name.
    const tab = win.locator('.tab.is-active');
    await expect(tab).toHaveAttribute('data-tip', /^Login bug\n.+\nClaude gets this name with your next message$/);
    await still(win);
    await title.hover();
    await expect(win.locator('.tooltip .tooltip-line').last()).toHaveText('Claude gets this name with your next message');
    await look(win, 'test-results/session-names-pending.png');

    // The next message: the hook hands the name to Claude, which shows it in its status line → synced.
    await typeInto(win, 'Login bug', 'ev:prompt\r');
    await expect(title).not.toHaveClass(/name-pending/, { timeout: 10000 });
    await expect(tab).toHaveAttribute('data-tip', /^Login bug\n[^\n]+$/);
    await expect.poll(() => terms(win)).toEqual([{ title: 'Login bug', name: 'Login bug', nameSync: null }]);

    // A /rename typed inside Claude: Atelier follows (title at once, the terminal's name with the next message).
    await typeInto(win, 'Login bug', 'ev:rename:Auth flow\r');
    await expect(row(win, 'Auth flow')).toBeVisible({ timeout: 10000 });
    await expect(title).toHaveText('Auth flow');
    await typeInto(win, 'Auth flow', 'ev:prompt\r');
    await expect.poll(() => terms(win)).toEqual([{ title: 'Auth flow', name: 'Auth flow', nameSync: null }]);

    // An unnamed session: the first prompt, then Claude's AI title once it arrives.
    await newSession(win, '');
    await expect(row(win, 'x')).toHaveClass(/state-waiting/, { timeout: 20000 });
    await typeInto(win, 'x', '\r');
    await expect(row(win, 'x')).toHaveClass(/state-done/, { timeout: 10000 });
    await typeInto(win, 'x', 'ev:ai:Fix the login flow\r');
    await expect(row(win, 'Fix the login flow')).toBeVisible({ timeout: 10000 });
    expect((await terms(win)).find((t) => t.title === 'Fix the login flow')?.name).toBeNull();
    // Opening the rename field and leaving it as it was does nothing: Claude's title never becomes a name to send.
    await row(win, 'Fix the login flow').click();
    await expect(title).toHaveText('Fix the login flow');
    await tab.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Rename…' }).click();
    await win.locator('.tab .tab-rename').blur();
    await expect(win.locator('.tab .tab-rename')).toHaveCount(0);
    await expect(title).toHaveText('Fix the login flow');
    // Sync point: another rename through the same channel, awaited; a rename sent on blur would have landed before it.
    await win.evaluate(async () => {
      const api = (window as unknown as { atelier: Api & { terminals: { rename(id: string, name: string | null): Promise<unknown> } } }).atelier;
      await api.terminals.rename((await api.terminals.list()).find((x) => x.title === 'Auth flow')!.id, 'Auth flow 2');
    });
    await expect(row(win, 'Auth flow 2')).toBeVisible();
    await expect(title).not.toHaveClass(/name-pending/);
    expect((await terms(win)).find((t) => t.title === 'Fix the login flow')).toEqual({ title: 'Fix the login flow', name: null, nameSync: null });
  } finally {
    await stop(app, home);
  }
});
