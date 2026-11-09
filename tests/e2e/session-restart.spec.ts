import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isShell } from '../../src/shared/shells';
import { e2eEnv } from './env';
import { look } from './shots';

// Restart Session and new MCP servers: `/exit` at the fake Claude's prompt, `claude --resume <id>`
// typed into the same shell; servers added to the fixture Claude home (ATELIER_TEST_CLAUDE_HOME, never ~/.claude).

const SID = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

type Api = { terminals: { list(): Promise<{ id: string; title: string; foreground: string; session: { sessionId: string } | null }[]>; input(id: string, data: string): void } };

const put = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };

async function launch(): Promise<{ app: ElectronApplication; home: string; claudeHome: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'atl-claude-home-'));
  put(join(claudeHome, '.claude.json'), { mcpServers: { github: { command: 'npx' } } });
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CLAUDE_HOME: claudeHome,
    ATELIER_FAKE_SESSION_ID: SID, ATELIER_TEST_MCP_POLL_MS: '200'
  });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  return { app, home, claudeHome, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const row = (win: Page, name: string) => win.locator('.session-row', { hasText: name });
const list = (win: Page) => win.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).map((x) => ({ id: x.id, title: x.title, sid: x.session?.sessionId ?? null })));

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    api.terminals.input((await api.terminals.list()).find((x) => x.title === title)!.id, text);
  }, { title, text });
}

/**
 * A session asking its first permission (the fake Claude's start): `answer` lets its turn end. It returns once atelierd
 * has seen Claude in front (its foreground poll is 1 s): until then the shell is, the session counts as busy and its
 * menus offer Restart When Done instead of Restart Session.
 */
async function newSession(win: Page, name: string, answer = true) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
  await expect.poll(async () => {
    const fg = await win.evaluate(async (title) => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).find((x) => x.title === title)?.foreground ?? '', name);
    return fg !== '' && !isShell(fg);
  }, { timeout: 10000 }).toBe(true);
  if (!answer) return;
  await typeInto(win, name, '\r');
  await expect(row(win, name)).toHaveClass(/state-done/, { timeout: 10000 });
}

test('Restart from the Session panel: Claude quits and the conversation resumes in the same terminal, the row stays', async () => {
  const { app, home, win } = await launch();
  try {
    await newSession(win, 'Alpha');
    const before = await list(win);
    expect(before).toHaveLength(1);

    // Whether the sidebar ever shows it as a plain terminal (or the row "Restarting…"), however briefly.
    await win.evaluate(() => {
      const w = window as unknown as { sawTermRow: boolean; sawRestarting: boolean };
      w.sawTermRow = false; w.sawRestarting = false;
      new MutationObserver(() => {
        if (document.querySelector('.term-row')) w.sawTermRow = true;
        if (document.querySelector('.session-row')?.textContent?.includes('Restarting…')) w.sawRestarting = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await win.locator('.session-bar .sb-model').click();
    const panel = win.getByRole('dialog', { name: /^Session: / });
    await panel.getByRole('button', { name: 'Restart', exact: true }).click();

    // The fake Claude answers `/exit` with its SessionEnd and quits; the shell gets the resume, with no model or mode.
    await expect(win.locator('.xterm-rows:visible')).toContainText(`FAKE-CLAUDE args=--resume ${SID}`, { timeout: 15000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('FAKE-CLAUDE bye');
    await expect.poll(async () => (await list(win)).map((x) => [x.id, x.sid])).toEqual([[before[0]!.id, SID]]);
    // Never a plain terminal meanwhile: one session row, back in its state.
    await expect(row(win, 'Alpha')).toHaveClass(/state-waiting/, { timeout: 10000 });
    await expect(win.locator('.term-row')).toHaveCount(0);
    expect(await win.evaluate(() => (window as unknown as { sawTermRow: boolean }).sawTermRow)).toBe(false);
    expect(await win.evaluate(() => (window as unknown as { sawRestarting: boolean }).sawRestarting)).toBe(true);
    await look(win, 'test-results/session-restart-done.png', { settle: 400 });
  } finally {
    await stop(app, home);
  }
});

test('Restart while Claude asks: armed ("after this turn"), it runs once the turn is over; Don\'t Restart cancels', async () => {
  const { app, home, win } = await launch();
  try {
    await newSession(win, 'Beta', false);
    await row(win, 'Beta').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Restart When Done' }).click();
    const chip = row(win, 'Beta').locator('.rs-chip.is-armed');
    await expect(chip).toContainText('after this turn');
    await look(win, 'test-results/session-restart-armed.png', { settle: 400 });

    // Don't Restart from the menu, then armed again from the File menu's command (the selected session).
    await row(win, 'Beta').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: "Don't Restart" }).click();
    await expect(chip).toHaveCount(0);
    await row(win, 'Beta').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Restart When Done' }).click();
    await expect(chip).toBeVisible();

    // The permission answered: the turn ends, the restart goes.
    await typeInto(win, 'Beta', '\r');
    await expect(win.locator('.xterm-rows:visible')).toContainText(`FAKE-CLAUDE args=--resume ${SID}`, { timeout: 15000 });
    await expect(chip).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('background agents running: Restart asks in the row; Restart When Done arms it, Esc cancels', async () => {
  const { app, home, win } = await launch();
  try {
    await newSession(win, 'Delta');
    await typeInto(win, 'Delta', 'ev:agents:2\r');
    await expect(row(win, 'Delta')).toContainText('2 agents', { timeout: 10000 });
    await row(win, 'Delta').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Restart Session' }).click();
    const ask = win.locator('.session-row.is-restart-ask');
    await expect(ask).toContainText('Restart now?');
    await expect(ask).toContainText('2 agents stop. The conversation continues after the restart.');
    await expect(ask.getByRole('button', { name: 'Restart When Done' })).toBeFocused();
    await look(win, 'test-results/session-restart-ask.png', { settle: 400 });
    await win.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);

    await row(win, 'Delta').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Restart Session' }).click();
    await ask.getByRole('button', { name: 'Restart When Done' }).click();
    await expect(row(win, 'Delta').locator('.rs-chip.is-armed')).toBeVisible();
    await expect(win.locator('.xterm-rows:visible')).not.toContainText('FAKE-CLAUDE got=/exit');
  } finally {
    await stop(app, home);
  }
});

test('a server added after the session started: New MCP on the row and in the panel; a click restarts and clears it', async () => {
  const { app, home, claudeHome, win } = await launch();
  try {
    await newSession(win, 'Gamma');
    await expect(row(win, 'Gamma').locator('.rs-chip')).toHaveCount(0);
    put(join(claudeHome, '.claude.json'), { mcpServers: { github: { command: 'npx' }, posthog: { type: 'http', url: 'https://mcp.posthog.com/mcp' } } });
    const chip = row(win, 'Gamma').locator('.rs-chip.is-new');
    await expect(chip).toHaveText('New MCP', { timeout: 10000 });

    await win.locator('.session-bar .sb-model').click();
    const panel = win.getByRole('dialog', { name: /^Session: / });
    await expect(panel.locator('.spanel-mcp')).toContainText('New since this session started: posthog');
    await expect(panel.locator('.spanel-chip.is-new')).toContainText('posthog');
    await expect(panel.locator('.spanel-chip.is-new')).toContainText('not loaded');
    await look(win, 'test-results/session-restart-new-mcp.png', { settle: 400 });
    await win.keyboard.press('Escape');

    await chip.click();
    await expect(win.locator('.xterm-rows:visible')).toContainText(`FAKE-CLAUDE args=--resume ${SID}`, { timeout: 15000 });
    // Its new baseline has posthog: nothing is new any more.
    await expect(row(win, 'Gamma').locator('.rs-chip')).toHaveCount(0, { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});
