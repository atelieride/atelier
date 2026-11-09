import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// resume: lists Claude Code's own conversations of the project (from a fake history folder, never
// ~/.claude), and Enter starts the (fake) claude with --resume <id> in the conversation's folder.

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const API_ID = '22222222-2222-4222-8222-222222222222';
const SIDECHAIN_ID = '33333333-3333-4333-8333-333333333333';
const EMPTY_ID = '44444444-4444-4444-8444-444444444444';
const OUTSIDE_ID = '55555555-5555-4555-8555-555555555555';
const LIVE_ID = '66666666-6666-4666-8666-666666666666';
const AI_ID = '77777777-7777-4777-8777-777777777777';

const LONG = 'Add rate limiting to the public API endpoints and return a Retry-After header when a client exceeds its quota';
const encode =(p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const line = (o: object) => JSON.stringify(o) + '\n';

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'api'));
  writeFileSync(join(project, 'README.md'), '# x\n');
  // Claude records real paths (/private/var/… for a temporary folder).
  const real = realpathSync(project);
  const sibling = `${real}-other`;
  mkdirSync(sibling);
  const claude = mkdtempSync(join(tmpdir(), 'atl-claude-projects-'));
  const write = (cwd: string, id: string, body: string, at: string) => {
    const dir = join(claude, encode(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), body);
    utimesSync(join(dir, `${id}.jsonl`), new Date(at), new Date(at));
  };
  const user = (cwd: string, content: unknown, ts: string, extra: object = {}) =>
    line({ type: 'user', sessionId: 'x', cwd, gitBranch: 'main', timestamp: ts, message: { role: 'user', content }, ...extra });
  const reply = (cwd: string, ts: string, branch: string, uuid = 'r') => line({ type: 'assistant', uuid, cwd, gitBranch: branch, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  // Claude's summary of this conversation (its leaf is the last reply).
  write(real, ROOT_ID, line({ type: 'summary', summary: 'Login redirect fix', leafUuid: 'leaf-root' })
    + user(real, '<command-name>/clear</command-name>', hoursAgo(30))
    + user(real, [{ type: 'text', text: 'Fix the login redirect after sign-in' }], hoursAgo(30))
    + reply(real, hoursAgo(26), 'fix/login', 'leaf-root'), hoursAgo(26));
  // A long first prompt over several lines: one line, truncated in the row (time and chips stay visible). The summary
  // at its top is of another conversation (unknown leaf): not this one's title.
  write(join(real, 'api'), API_ID, line({ type: 'summary', summary: 'Some other conversation', leafUuid: 'leaf-elsewhere' })
    + user(join(real, 'api'), `${LONG.slice(0, 35)}\n${LONG.slice(36)}`, hoursAgo(3)) + reply(join(real, 'api'), hoursAgo(2), 'main'), hoursAgo(2));
  write(real, SIDECHAIN_ID, user(real, 'Agent task', hoursAgo(1), { isSidechain: true }), hoursAgo(1));
  write(real, EMPTY_ID, '', hoursAgo(1));
  write(sibling, OUTSIDE_ID, user(sibling, 'Work in the sibling project', hoursAgo(1)), hoursAgo(1));
  write(real, LIVE_ID, user(real, 'Already running in Atelier', hoursAgo(1)), hoursAgo(1));
  // Titled as Claude's /resume shows it: its AI title, not its first prompt.
  write(real, AI_ID, line({ type: 'user', sessionId: AI_ID, cwd: real, gitBranch: 'main', timestamp: hoursAgo(40), message: { role: 'user', content: 'can you look at why the login page loops' } })
    + line({ type: 'ai-title', aiTitle: 'Login page redirect loop', sessionId: AI_ID })
    + reply(real, hoursAgo(40), 'main'), hoursAgo(40));
  return { project, real, claude };
}

type Api = {
  terminals: { list(): Promise<{ title: string; cwd: string; name: string | null; nameSync?: string; session: { sessionId: string } | null }[]>; createSession(o: object): Promise<unknown> };
  settings: { set(p: object): Promise<unknown> };
};
const sessions = (win: Page) => win.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).map((t) => ({ title: t.title, cwd: t.cwd, sid: t.session?.sessionId ?? null, name: t.name, nameSync: t.nameSync ?? null })));
const titles = (win: Page) => win.locator('.palette-item .palette-label').allTextContents();

test('resume: lists the project conversations from Claude history (titled as Claude\'s /resume shows them), searches them, resumes one in its folder', async () => {
  const { project, real, claude } = fixture();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CLAUDE_PROJECTS: claude, ATELIER_FAKE_SESSION_ID: LIVE_ID });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();

    // A session already running here (its Claude reports LIVE_ID) is never offered.
    await win.evaluate(() => (window as unknown as { atelier: Api }).atelier.terminals.createSession({ cols: 100, rows: 30, name: 'Live' }));
    await expect.poll(async () => (await sessions(win)).some((s) => s.sid === '66666666-6666-4666-8666-666666666666'), { timeout: 15000 }).toBe(true);
    // Today's session settings apply to a resumed conversation too, launch flags included.
    await win.evaluate(() => (window as unknown as { atelier: Api }).atelier.settings.set({ claudeModel: 'sonnet', claudeFlags: { all: [['--verbose']], accounts: {} } }));

    // New › Resume Session… is enabled by the history alone (no Atelier session to resume) and opens resume:.
    await win.locator('.btn-new').click();
    const resumeItem = win.getByRole('menuitem', { name: 'Resume Session…' });
    await expect(resumeItem).toBeEnabled();
    await resumeItem.click();
    const palette = win.getByRole('dialog', { name: 'Search' });
    await expect(win.locator('.palette-input')).toHaveValue('resume:');
    await expect(win.locator('.palette-section')).toHaveText(['Claude conversations']);
    // Newest first; summary and AI title preferred to the first prompt; nothing from agents, empty files, other folders
    // or live sessions.
    await expect.poll(() => titles(win)).toEqual([LONG, 'Login redirect fix', 'Login page redirect loop']);
    const apiRow = win.locator('.palette-item', { hasText: 'Add rate limiting' });
    await expect(apiRow.locator('.cwd-chip')).toHaveText('api/');
    await expect(apiRow.locator('.branch-chip')).toHaveText('main');
    await expect(apiRow.locator('.palette-hint')).toHaveText('2h ago');
    // The long title is the one that gives way: the time and the chips keep their room.
    expect((await apiRow.locator('.palette-hint').boundingBox())!.width).toBeGreaterThan(30);
    expect((await apiRow.locator('.branch-chip').boundingBox())!.width).toBeGreaterThan(40);
    const label = apiRow.locator('.palette-label');
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const rootRow = win.locator('.palette-item', { hasText: 'Login redirect fix' });
    await expect(rootRow.locator('.cwd-chip')).toHaveCount(0);
    await expect(rootRow.locator('.branch-chip')).toHaveText('fix/login');
    await expect(rootRow.locator('.palette-hint')).toHaveText('1d ago');
    await look(palette, 'test-results/resume-history.png');

    // Fuzzy search over title, first prompt, branch and folder.
    await win.locator('.palette-input').fill('resume: sign-in');
    await expect.poll(() => titles(win)).toEqual(['Login redirect fix']);
    await win.locator('.palette-input').fill('resume: fix/login');
    await expect.poll(() => titles(win)).toEqual(['Login redirect fix']);
    await win.locator('.palette-input').fill('resume: api/');
    await expect.poll(() => titles(win)).toEqual([LONG]);
    await win.locator('.palette-input').fill('resume: zzzz');
    await expect(win.locator('.palette-list .empty')).toHaveText('Nothing found');

    // Enter: a new session running `claude --resume <id>` (with the settings flags) in the conversation's folder.
    await win.locator('.palette-input').fill('resume: rate limiting');
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    const row = win.locator('.session-row', { hasText: 'Add rate limiting' });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('.cwd-chip')).toHaveText('api/');
    const term = win.locator('.xterm-rows', { hasText: `FAKE-CLAUDE args=--resume ${API_ID}` });
    await expect(term).toContainText(`FAKE-CLAUDE args=--resume ${API_ID} --model sonnet --verbose`, { timeout: 15000 });
    await expect(term).toContainText(`FAKE-CLAUDE cwd=${join(real, 'api')}`);
    expect((await sessions(win)).find((s) => s.title.startsWith('Add rate limiting'))?.cwd).toBe(join(real, 'api'));

    // Resumed: no longer offered. The last ones resumed too → the empty state, and the menu item is disabled.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('resume:');
    await expect.poll(() => titles(win)).toEqual(['Login redirect fix', 'Login page redirect loop']);
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Login redirect fix' })).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.xterm-rows', { hasText: `FAKE-CLAUDE args=--resume ${ROOT_ID}` })).toContainText(`FAKE-CLAUDE cwd=${real}FAKE-CLAUDE waiting`, { timeout: 15000 });
    // The AI-titled one keeps that title once resumed, without being renamed: a label only, no name for Atelier to hand
    // to Claude.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('resume:');
    await expect.poll(() => titles(win)).toEqual(['Login page redirect loop']);
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Login page redirect loop' })).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.xterm-rows', { hasText: `FAKE-CLAUDE args=--resume ${AI_ID}` })).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await sessions(win)).filter((t) => t.title === 'Login page redirect loop').map((t) => ({ name: t.name, nameSync: t.nameSync }))).toEqual([{ name: null, nameSync: null }]);
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('resume:');
    await expect(win.locator('.palette-list .empty')).toHaveText('No conversations to resume in this project');
    await win.keyboard.press('Escape');
    await win.locator('.btn-new').click();
    await expect(win.getByRole('menuitem', { name: 'Resume Session…' })).toBeDisabled();
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
