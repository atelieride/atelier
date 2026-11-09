import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';
import { commit, git } from '../support/git-fixture';

// Ask: a read-only companion inside each session's pane. The session is a fake Claude that edits
// src/app.ts and keeps working (fake-claude-edit.pl); Ask's own `claude -p` is the scripted fake-claude-ask.mjs, which
// logs every run's argv and input to ATELIER_TEST_COMPANION_LOG. Nothing reads the user's ~/.claude: the session's
// transcript is seeded under ATELIER_TEST_CLAUDE_PROJECTS.

const SID = '3f6c2a9e-1b7d-4e2f-9a51-6c0d8e7b4a12';
const SHOTS = 'test-results';
type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };
type Run = { argv: string[]; cwd: string; entrypoint: string | null; input: string };

interface Launched { app: ElectronApplication; win: Page; home: string; log: string; project: string; env: Record<string, string> }

// Every run of Ask's claude is read-only by its argv (Tests): each launch registers its log
// here, and stop() holds every run in it to that, so the whole suite covers every run, not a sample.
const logs = new Map<string, string>();

async function launch(extra: Record<string, string> = {}, again?: Launched): Promise<Launched> {
  if (again) return open(again.env, again.project, again.log, again.home);
  const tmp = mkdtempSync(join(tmpdir(), 'atl-ask-'));
  const project = join(tmp, 'acme-store');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  commit(project, 'first', { 'src/app.ts': 'export const SKEW_MS = 30_000;\nexport const expired = (at: number, now: number) => at < now - SKEW_MS;\n' });
  // A change for the session to own (its Edit hook attributes it): the live strip counts it.
  writeFileSync(join(project, 'src/app.ts'), 'export const SKEW_MS = 30_000;\nexport const expired = (at: number, now: number) => at <= now - SKEW_MS;\n');
  // The session's transcript, where Ask reads its chat (the cwd encoded as Claude Code does, both spellings of it).
  const projects = join(tmp, 'claude-projects');
  const line = (o: object) => JSON.stringify(o) + '\n';
  for (const cwd of new Set([project, realpathSync(project)])) {
    const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}.jsonl`),
      line({ type: 'user', sessionId: SID, cwd, timestamp: '2026-10-31T11:20:00.000Z', message: { role: 'user', content: 'Move sessions to the token store:\n1. keep refresh tokens in TokenStore\n2. refresh on expiry, tolerate clock skew\n3. update the auth tests\n4. remove the old cookie path' } })
      + line({ type: 'assistant', sessionId: SID, cwd, timestamp: '2026-10-31T11:21:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }));
  }
  const log = join(tmp, 'companion.log');
  writeFileSync(log, '');
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: 'src/app.ts', ATELIER_FAKE_NO_STOP: '1', ATELIER_FAKE_SESSION_ID: SID,
    ATELIER_TEST_CLAUDE_PROJECTS: projects,
    ATELIER_TEST_COMPANION_CLAUDE: resolve('tests/e2e/fake-claude-ask.mjs'), ATELIER_TEST_COMPANION_LOG: log, ...extra
  });
  logs.set(home, log);
  return open(env, project, log, home);
}

async function open(env: Record<string, string>, project: string, log: string, home: string): Promise<Launched> {
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  // The boards' size.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  return { app, win, home, log, project, env };
}

/** What every Ask run must have been: the read-only argv, the isolated entrypoint, a folder of its own under the home. */
function assertReadOnly(run: Run, home: string) {
  const { argv } = run;
  const at = (flag: string) => argv.slice(argv.indexOf(flag) + 1);
  expect(argv).toContain('--restricted');
  expect(flag(argv, '--tools')).toBe('Read,Grep,Glob');
  expect(flag(argv, '--allowedTools')).toBe('Read,Grep,Glob');
  expect(flag(argv, '--permission-mode')).toBe('dontAsk');
  expect(at('--disallowedTools').slice(0, 11)).toEqual(['.env*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '*.p12', '*.pfx', 'credentials*', '.netrc', '.npmrc'].map((p) => `Read(//**/${p})`));
  expect(argv.indexOf('--setting-sources')).toBeGreaterThan(-1);
  expect(flag(argv, '--setting-sources')).toBe('');
  expect(argv).toContain('--strict-mcp-config');
  for (const bad of ['--settings', '--mcp-config', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) expect(argv).not.toContain(bad);
  // No write tool or Bash anywhere in the argv, as a tool name or as a rule.
  const schemaAt = argv.indexOf('--json-schema') + 1; // the catch-up schema's own prose is not an argv tool
  for (const [i, a] of argv.entries()) if (i !== schemaAt || schemaAt === 0) expect(a).not.toMatch(/\b(Bash|Edit|Write|MultiEdit|NotebookEdit)\b/);
  expect(run.entrypoint).toBe('atelier-ask');
  expect(argv.includes('--session-id') !== argv.includes('--resume')).toBe(true);
  // Its own folder under the home's companion/, never the project.
  const cwd = realpathSync(run.cwd);
  expect(cwd.startsWith(`${realpathSync(join(home, 'companion'))}/`)).toBe(true);
  expect(cwd).toMatch(/\/companion\/[0-9a-f-]{36}$/);
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

// After each test's body, never inside its cleanup (a failing body is reported as itself): every Ask run the test
// caused is held to the read-only argv.
let checkedRuns = 0;
const testsRun = new Set<string>();
test.afterEach(() => {
  testsRun.add(test.info().testId);
  for (const [home, log] of logs) {
    for (const run of runs(log)) { assertReadOnly(run, home); checkedRuns++; }
    logs.delete(home);
  }
});
// The per-run check passes vacuously when nothing is logged (a broken log, a fake that never ran): the file's tests
// together must have checked some runs. A single filtered test checks its own runs only.
test.afterAll(() => {
  if (testsRun.size > 1) expect(checkedRuns, 'Ask runs held to the read-only argv').toBeGreaterThan(0);
});

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);
type SettingsApi = { atelier: { settings: { get(): Promise<Record<string, unknown>>; set(p: object): Promise<unknown> } } };
/** Settings › Ask › Catch me up when opened (off by default): the tests of the automatic run turn it on. */
const catchUpOnOpen = (win: Page, on: boolean) => win.evaluate((v) => (window as unknown as SettingsApi).atelier.settings.set({ askCatchUpOnOpen: v }), on);
const catchUpOnOpenNow = (win: Page) => win.evaluate(() => (window as unknown as SettingsApi).atelier.settings.get().then((s) => s.askCatchUpOnOpen));
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const runs = (log: string): Run[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Run);
const widthOf = async (win: Page, selector: string) => (await win.locator(selector).boundingBox())?.width ?? 0;
/** The entrance animations playing now in an Ask panel's host (the panel, its dim, its items), by name. */
const entrances = (panel: ReturnType<Page['locator']>) => panel.evaluate((el) => (el.closest('.ask-host') ?? el).getAnimations({ subtree: true })
  .filter((a) => a.playState === 'running' && ['ask-slide', 'atl-pop', 'atl-fade', 'atl-enter', 'atl-drop'].includes((a as CSSAnimation).animationName)).map((a) => (a as CSSAnimation).animationName));

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-bar .sb-ask')).toBeVisible({ timeout: 20000 });
  await expect(win.locator('.tab.is-active .tab-name')).toHaveText(name);
}

test('Ask: ⌘I docks the panel beside a narrower terminal and closes it again; Esc gives the terminal the keyboard; a narrow split pane gets a sheet that docks once there is room; the panel stays, Ended, when Claude exits', async () => {
  const { app, win, home, log } = await launch();
  try {
    // As on the boards: no Changes panel (with it, a 1440 px window leaves the terminal too little room: a sheet).
    await expect(win.locator('.changes')).toBeVisible({ timeout: 10000 });
    await command(app, 'toggle-changes');
    await expect(win.locator('.changes')).toHaveCount(0);
    await catchUpOnOpen(win, true);
    await newSession(win, 'auth-refactor');
    const pill = win.locator('.session-bar .sb-ask');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });
    const slot = '.terminal-slot:visible';
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
    const full = await widthOf(win, slot);
    const xterm = await win.locator(`${slot} .xterm`).elementHandle();

    // Closed, hovered: the pill and its tip.
    await pill.hover();
    await expect(win.locator('.tooltip')).toContainText('Ask about this session');
    await expect(win.locator('.tooltip')).toContainText('Read-only. It never interrupts auth-refactor.');
    await look(win, `${SHOTS}/ask-closed-hover.png`, { settle: 300 });
    await win.mouse.move(10, 400);

    // ⌘I (the ask-session command): docked at the pane's right, the terminal narrower by its width, the same xterm.
    await command(app, 'ask-session');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-dock/);
    await expect(pill).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => widthOf(win, slot)).toBeLessThan(full - 380);
    expect(await xterm!.evaluate((el) => el.isConnected)).toBe(true);
    // At the pane's right edge once it slid in, 404 px wide.
    const rightGap = async () => {
      const box = (await panel.boundingBox())!;
      const body = (await win.locator('.workspace-body').boundingBox())!;
      return Math.abs(box.x + box.width - (body.x + body.width));
    };
    await expect.poll(rightGap).toBeLessThan(1);
    expect(Math.round((await panel.boundingBox())!.width)).toBe(404);
    // Header and composer focused for a question; no strip of the session's state, work and files under the header
    // (2026-11-02: the session bar, the row and Changes say them).
    await expect(panel.locator('.ask-hd')).toContainText('Ask');
    await expect(panel.locator('.ask-ro')).toHaveText('Read-only');
    await expect(panel.locator('.ask-live')).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveAttribute('placeholder', 'Ask about auth-refactor…');
    // Catch me up on open (turned on above): one run of Ask's own claude, read-only and on the schema; its item lands.
    await expect.poll(() => runs(log).length, { timeout: 10000 }).toBe(1);
    const first = runs(log)[0]!;
    expect(first.argv).toContain('--json-schema');
    expect(first.argv).toContain('--restricted');
    expect(first.entrypoint).toBe('atelier-ask');
    await expect(panel.locator('.ask-thread .ask-item[data-kind="catchup"]')).toHaveCount(1, { timeout: 10000 });
    await look(win, `${SHOTS}/ask-docked.png`, { settle: 400 });

    // Esc in the panel closes it and the terminal has the keyboard, at its full width again; a half-typed question
    // waits for the next open.
    await composer.fill('Why 30 s of');
    await composer.press('Escape');
    await expect(panel).toBeHidden();
    await expect(win.locator(`${slot} .xterm-helper-textarea`)).toBeFocused();
    await expect.poll(() => widthOf(win, slot)).toBeGreaterThan(full - 2);
    // The pill opens it, ⌘I closes it: the thread is the same (no second Catch me up within 10 minutes).
    await pill.click();
    await expect(panel).toBeVisible();
    await expect(composer).toHaveValue('Why 30 s of');
    await composer.fill('');
    await command(app, 'ask-session');
    await expect(panel).toBeHidden();
    expect(runs(log)).toHaveLength(1);

    // Split Right, back to the session's pane (now about half as wide): Ask opens as a sheet over the terminal, which
    // keeps its width, dimmed under it; the header names the session.
    await command(app, 'split-right');
    await expect(win.locator('.workspace-body.is-split')).toBeVisible();
    await command(app, 'focus-prev-pane');
    await expect(win.locator('.session-bar.is-pane.is-focused')).toBeVisible();
    const half = await widthOf(win, slot);
    await command(app, 'ask-session');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-sheet/);
    await expect(panel.locator('.ask-hd')).toContainText('auth-refactor');
    await expect(win.locator('.ask-host.is-sheet .ask-dim')).toBeVisible();
    expect(Math.abs(await widthOf(win, slot) - half)).toBeLessThan(2);
    const dock = panel.getByRole('button', { name: 'Show beside the terminal' });
    await expect(dock).toHaveCount(0);
    // In the keyboard's order the panel follows its own pane's bar, before the next pane (its picker: it is empty).
    expect(await win.evaluate(() => {
      const [h0, h1] = [...document.querySelectorAll('.workspace-body > .session-bar, .workspace-body > .pane-picker')];
      const host = document.querySelector('.workspace-body > .ask-host')!;
      return !!(h0!.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(host.compareDocumentPosition(h1!) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await look(win, `${SHOTS}/ask-sheet.png`, { settle: 400 });

    // Back to one pane: room again, the sheet stays until its dock button docks it; the composer keeps the keyboard. A
    // half-typed question moves with it (saved as typed: the new host's composer mounts before the old one goes).
    await composer.fill('Half a question');
    await command(app, 'close-other-panes');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await expect(panel).toHaveClass(/is-sheet/);
    await expect(composer).toHaveValue('Half a question');
    await composer.fill('');
    await dock.click();
    await expect(panel).toHaveClass(/is-dock/);
    await expect(composer).toBeFocused();
    await expect.poll(() => widthOf(win, slot)).toBeLessThan(full - 380);

    // New Thread asks first; Esc keeps the thread and the keyboard comes back to the composer; Start empties it.
    const more = panel.getByRole('button', { name: 'More' });
    const confirm = panel.getByRole('group', { name: 'Start a new thread?' });
    await more.click();
    await win.getByRole('menuitem', { name: 'New Thread' }).click();
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: /Cancel/ })).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(panel.locator('.ask-item[data-kind="catchup"]')).toHaveCount(1);
    await more.click();
    await win.getByRole('menuitem', { name: 'New Thread' }).click();
    await confirm.getByRole('button', { name: 'Start new thread' }).click();
    await expect(confirm).toBeHidden();
    await expect(panel.locator('.ask-item')).toHaveCount(0);
    await expect(panel.locator('.ask-empty')).toBeVisible();
    await expect(panel.locator('.ask-fine')).toHaveText("Reads the code and this session's chat. Never edits or types into it.");
    await expect(composer).toBeFocused();

    // Claude exits with Ask open: the bar goes (a plain terminal), the panel stays bound to the conversation, Ended.
    await win.evaluate(async () => {
      const api = (window as unknown as { atelier: Api }).atelier;
      api.terminals.input((await api.terminals.list())[0]!.id, '\x03');
    });
    await expect(win.locator('.session-bar')).toHaveCount(0, { timeout: 15000 });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.ask-endbar')).toBeVisible();
    // Catch me up for an ended session is final (fourth panel): Left open instead of Where it is, what isn't
    // done says so, no refresh.
    await panel.locator('.ask-empty').getByRole('button', { name: 'Catch me up' }).click();
    const final = panel.getByRole('region', { name: 'Catch me up' });
    await expect(final).toHaveClass(/is-final/, { timeout: 10000 });
    expect(runs(log).at(-1)!.input).toMatch(/the session has ended/);
    await expect(final.locator('.ask-card-when')).toHaveText(/^final · \d\d:\d\d$/);
    await expect(final.getByRole('heading', { name: 'Left open' })).toBeVisible();
    await expect(final.getByRole('heading', { name: 'Where it is' })).toHaveCount(0);
    await expect(final).toContainText('The old cookie path is still there and the boundary test is still red.');
    await expect(final.locator('.ask-pt-tm')).toHaveText(['12:22', '12:33', 'not done', 'not done', 'not done']);
    await expect(final.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
    // The note under the strip: the thread stays with the session, and Ask still answers.
    await expect(panel.locator('.ask-endbar')).toHaveText('Ask still answers from its chat and code. The thread stays with the session under Resume.');
    await look(win, `${SHOTS}/ask-ended.png`, { settle: 300 });
    await composer.fill('What did it leave open?');
    await composer.press('Enter');
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(1, { timeout: 15000 });
    expect(runs(log).at(-1)!.input).toBe('What did it leave open?');
    // ⌘I still closes it; then a plain terminal has no Ask.
    await command(app, 'ask-session');
    await expect(panel).toBeHidden();
    await expect.poll(() => widthOf(win, slot)).toBeGreaterThan(full - 2);
  } finally {
    await stop(app, home);
  }
});

type Resize = { id: string; cols: number; rows: number };

test('Ask keeps its dock across tabs and splits (the terminal gets one size each time, never a passing one) and moves with its tab to a new window and back', async () => {
  const { app, win, home } = await launch();
  try {
    // Every size the windows ask atelierd for, as main receives them.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { askResizes: Resize[] };
      g.askResizes = [];
      ipcMain.on('term:resize', (_e, a: Resize) => { g.askResizes.push(a); });
    });
    const sizes = async (id: string) => (await app.evaluate(() => (globalThis as unknown as { askResizes: Resize[] }).askResizes)).filter((r) => r.id === id).map((r) => r.cols);
    const forget = () => app.evaluate(() => { (globalThis as unknown as { askResizes: Resize[] }).askResizes = []; });
    await expect(win.locator('.changes')).toBeVisible({ timeout: 10000 });
    await command(app, 'toggle-changes');
    await expect(win.locator('.changes')).toHaveCount(0);
    await catchUpOnOpen(win, true);
    await newSession(win, 'auth-refactor');
    const id = await win.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list())[0]!.id);
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const slot = '.terminal-slot:visible';
    const full = await widthOf(win, slot);
    await command(app, 'ask-session');
    await expect(panel).toHaveClass(/is-dock/);
    await expect.poll(() => widthOf(win, slot)).toBeLessThan(full - 380);
    await expect.poll(async () => (await sizes(id)).at(-1) ?? 0).toBeGreaterThan(0);
    const docked = (await sizes(id)).at(-1)!;
    // The on-open Catch me up has landed and every entrance has ended: whatever runs after the tab comes back replays.
    await expect(panel.locator('.ask-item[data-kind="catchup"]')).toHaveCount(1, { timeout: 10000 });
    await expect.poll(() => entrances(panel)).toEqual([]);

    // Another tab, then back: the terminal comes back at its docked size at once (never its full width first).
    await command(app, 'new-terminal');
    await expect(win.locator('.tab')).toHaveCount(2, { timeout: 10000 });
    await expect(panel).toBeHidden();
    await forget();
    await win.locator('.tab', { hasText: 'auth-refactor' }).click();
    // Shown again, not opened: no entrance replays (the panel, its dim and its items are at rest at once).
    expect(await entrances(panel)).toEqual([]);
    await expect(panel).toHaveClass(/is-dock/);
    await expect.poll(async () => (await sizes(id)).length).toBeGreaterThan(0);
    expect(new Set(await sizes(id))).toEqual(new Set([docked]));

    // Changes opening while docked leaves the pane too narrow to dock: a sheet, and the terminal goes straight to the
    // pane's width (never the narrower width minus the panel on the way). Closing Changes keeps the sheet; Dock again.
    await forget();
    await command(app, 'toggle-changes');
    await expect(panel).toHaveClass(/is-sheet/);
    await expect.poll(async () => (await sizes(id)).at(-1) ?? 0).toBeGreaterThan(docked * 0.8);
    const narrowed = await sizes(id);
    expect(Math.min(...narrowed)).toBe(narrowed.at(-1));
    await command(app, 'toggle-changes');
    await expect(win.locator('.changes')).toHaveCount(0);
    await expect(panel).toHaveClass(/is-sheet/);
    await panel.getByRole('button', { name: 'Show beside the terminal' }).click();
    await expect(panel).toHaveClass(/is-dock/);
    await expect.poll(async () => (await sizes(id)).at(-1)).toBe(docked);

    // Split Right while docked: the pane halves and Ask turns into a sheet; the terminal goes straight to the half
    // (never the half minus the panel on the way).
    await forget();
    await command(app, 'split-right');
    await expect(panel).toHaveClass(/is-sheet/);
    await expect.poll(async () => (await sizes(id)).at(-1) ?? 0).toBeGreaterThan(docked * 0.6);
    const split = await sizes(id);
    expect(Math.min(...split)).toBe(split.at(-1));

    // One pane again, docked; Move Tab to New Window: Ask opens there for its session and leaves this window.
    await command(app, 'focus-prev-pane');
    await command(app, 'close-other-panes');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Show beside the terminal' }).click();
    await expect(panel).toHaveClass(/is-dock/);
    const [pop] = await Promise.all([app.waitForEvent('window'), command(app, 'move-tab-window')]);
    await expect(pop.locator('.popout-bar')).toBeVisible({ timeout: 15000 });
    await expect(pop.getByRole('complementary', { name: 'Ask about auth-refactor' })).toBeVisible({ timeout: 10000 });
    await expect(pop.locator('.popout-bar .sb-ask')).toHaveAttribute('aria-expanded', 'true');
    await expect(win.locator('.ask')).toHaveCount(0);
    await look(pop, `${SHOTS}/ask-popout.png`, { settle: 400 });

    // Move Back: it comes back open in this window.
    await Promise.all([pop.waitForEvent('close', { timeout: 15000 }), pop.locator('.popout-back').click()]);
    await expect(panel).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.session-bar .sb-ask')).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await stop(app, home);
  }
});

test("Catch me up: off on open by default, the empty state and its button; the card from the fake (requests with status and time, Where it is, Choices it made, its source) on the thread's model; refresh turns violet once the session changes files; the chips and Why? ask", async () => {
  // A line typed into the fake session makes it edit src/app.ts again: the session moved on after the card. A Catch me
  // up takes a moment after reading the chat, long enough to see it on its way.
  const { app, win, home, log } = await launch({ ATELIER_FAKE_EDIT_ON_INPUT: '1', ATELIER_TEST_COMPANION_CATCHUP_MS: '1500' });
  try {
    await expect(win.locator('.changes')).toBeVisible({ timeout: 10000 });
    await command(app, 'toggle-changes');
    await expect(win.locator('.changes')).toHaveCount(0);
    // Nothing set: Settings › Ask › Catch me up when opened is off by default.
    expect(await catchUpOnOpenNow(win)).toBe(false);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });

    // Off on open (first panel): the mark, what Ask does, Catch me up and three starters; nothing runs.
    await command(app, 'ask-session');
    const empty = panel.locator('.ask-empty');
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('heading', { name: 'Ask about auth-refactor' })).toBeVisible();
    await expect(empty).toContainText('Questions about this session, without interrupting it. Ask reads the code and the chat, and never changes either.');
    await expect(empty.getByRole('group', { name: 'Suggested questions' }).getByRole('button')).toHaveText(['What is it doing?', 'How far along is it?', 'Explain its plan']);
    await expect(panel.locator('.ask-fine')).toBeVisible();
    await look(win, `${SHOTS}/ask-empty.png`, { settle: 400 });
    expect(runs(log)).toHaveLength(0);

    // The thread's model picker goes with Catch me up (Opus); the card lands and the composer has the keyboard.
    await panel.getByRole('button', { name: 'Model: Sonnet' }).click();
    await win.getByRole('menuitem', { name: 'Opus' }).click();
    await empty.getByRole('button', { name: 'Catch me up' }).click();
    // On its way: one compact row in place of the empty state.
    const catching = panel.getByRole('status').filter({ hasText: 'Catching up…' });
    await expect(catching).toBeVisible();
    // Announced once: a stable label; the sweeping copy (remounted at each step) is for the eyes.
    await expect(catching.locator('.sr-only')).toHaveText('Catching up…');
    await expect(catching.locator('.ask-catching-t')).toHaveAttribute('aria-hidden', 'true');
    await expect(empty).toHaveCount(0);
    await expect(composer).toBeFocused();
    // The thread is still empty: the composer's own Catch me up comes with its first item.
    const composerCatchUp = panel.locator('.ask-comp').getByRole('button', { name: 'Catch me up' });
    await expect(composerCatchUp).toHaveCount(0);
    await look(win, `${SHOTS}/ask-catching.png`, { settle: 200 });
    const cards = panel.getByRole('region', { name: 'Catch me up' });
    const card = cards.last();
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(catching).toHaveCount(0);
    await expect(composerCatchUp).toBeVisible();
    expect(runs(log)).toHaveLength(1);
    expect(flag(runs(log)[0]!.argv, '--model')).toBe('opus');
    await expect(card.locator('.ask-card-when')).toHaveText(/^\d\d:\d\d · just now$/);
    // Your requests: five points, their glyphs (named for screen readers), the time column and the in-progress note.
    await expect(card.getByRole('heading', { name: 'Your requests' })).toBeVisible();
    await expect(card.locator('.ask-pt')).toHaveCount(5);
    expect(await card.locator('.ask-gl').evaluateAll((els) => els.map((e) => `${e.getAttribute('role')}:${e.getAttribute('aria-label')}`)))
      .toEqual(['img:done', 'img:done', 'img:in progress', 'img:not started', 'img:not started']);
    await expect(card.locator('.ask-pt-tm')).toHaveText(['12:22', '12:33', 'now', 'next', 'asked 12:38']);
    await expect(card.locator('.ask-pt').nth(2)).toContainText('Re-running them · 1 of 3 failures left');
    // Where it is, with its code; Choices it made, each with Why?; the source line and the model.
    await expect(card.getByRole('heading', { name: 'Where it is' })).toBeVisible();
    await expect(card.locator('.ask-sum code')).toHaveText(['TokenStore', '<=']);
    await expect(card.getByRole('heading', { name: 'Choices it made' })).toBeVisible();
    await expect(card.locator('.ask-dec-tx')).toHaveText(['Skew window fixed at 30 s, not configurable', 'Plans to keep reading the old cookie for one release']);
    await expect(card.getByRole('button', { name: 'Why?' })).toHaveCount(2);
    await expect(card.locator('.ask-src')).toHaveText(/From the chat\s*Opus/);
    // The chips under it: what's left, why its first choice, how the code its summary names works.
    const chips = panel.locator('.ask-sugg .ask-sg');
    await expect(chips).toHaveText(["What's left?", 'Why skew window fixed at 30 s, not configurable?', 'How does TokenStore work?']);
    const refresh = card.getByRole('button', { name: 'Refresh' });
    await expect(refresh).not.toHaveClass(/is-stale/);
    await look(win, `${SHOTS}/ask-catchup.png`, { settle: 400 });

    // The session edits a file after the card: its refresh turns violet and says so; it runs a new Catch me up (on the
    // thread's model), and only the newest card keeps a refresh.
    await win.evaluate(async () => {
      const api = (window as unknown as { atelier: Api }).atelier;
      api.terminals.input((await api.terminals.list())[0]!.id, 'go\r');
    });
    const stale = card.getByRole('button', { name: '1 file changed since · Refresh' });
    await expect(stale).toHaveClass(/is-stale/, { timeout: 10000 });
    await look(win, `${SHOTS}/ask-catchup-stale.png`, { settle: 300 });
    await stale.click();
    // While it runs, the refresh waits (one Catch me up at a time) and the chips go.
    await expect(catching).toBeVisible();
    await expect(stale).toHaveAttribute('aria-disabled', 'true');
    await expect(chips).toHaveCount(0);
    await expect(cards).toHaveCount(2, { timeout: 10000 });
    expect(flag(runs(log)[1]!.argv, '--model')).toBe('opus');
    await expect(cards.first().getByRole('button', { name: /Refresh/ })).toHaveCount(0);
    await expect(cards.last().getByRole('button', { name: 'Refresh' })).not.toHaveClass(/is-stale/);

    // A chip asks its question; the chips go once the thread moved past the card.
    await chips.first().click();
    await expect(panel.locator('.ask-q .ask-q-t').last()).toHaveText("What's left?");
    await expect(chips).toHaveCount(0);
    await expect.poll(() => runs(log).length).toBe(3);
    expect(runs(log)[2]!.input).toBe("What's left?");
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(1, { timeout: 10000 });
    // One question at a time: Why? waits (disabled) until the answer's run is over.
    await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();

    // Why? on a choice asks "Why <choice>?".
    await cards.last().getByRole('button', { name: 'Why?' }).first().click();
    await expect(panel.locator('.ask-q .ask-q-t').last()).toHaveText('Why skew window fixed at 30 s, not configurable?');
    await expect.poll(() => runs(log).length).toBe(4);
    expect(runs(log)[3]!.input).toBe('Why skew window fixed at 30 s, not configurable?');
  } finally {
    await stop(app, home);
  }
});

// The fake's answer (fake-claude-ask.mjs), as Claude's result carries it.
const ANSWER = 'Verdict: in-progress — Not yet · 2/3 tests fixed\n\nTwo of the three failing auth tests pass now; the boundary one is still red.\n\n'
  + '1. `TokenStore` keeps the refresh token.\n2. `refresh()` allows 30 s of clock skew.\n3. The boundary test compares expiry with `<=`.\n\n'
  + ':::detail Why the boundary test failed\nThe expiry check used `<` instead of `<=`, see `src/app.ts:2`.\n:::\n';

/** ANSWER as Ask copies it for documents: tags only, the folded Detail included. */
const ANSWER_HTML = '<p><strong>In progress:</strong> Not yet · 2/3 tests fixed</p><p>Two of the three failing auth tests pass now; the boundary one is still red.</p>'
  + '<ol><li><code>TokenStore</code> keeps the refresh token.</li><li><code>refresh()</code> allows 30 s of clock skew.</li><li>The boundary test compares expiry with <code>&lt;=</code>.</li></ol>'
  + '<p><strong>Why the boundary test failed</strong></p><p>The expiry check used <code>&lt;</code> instead of <code>&lt;=</code>, see <code>src/app.ts:2</code>.</p>';

const knownSaved = (win: Page) => win.evaluate(() => (window as unknown as { atelier: { settings: { get(): Promise<{ askKnown: string }> } } }).atelier.settings.get().then((s) => s.askKnown));

async function askOff(app: ElectronApplication, win: Page) {
  await expect(win.locator('.changes')).toBeVisible({ timeout: 10000 });
  await command(app, 'toggle-changes');
  await expect(win.locator('.changes')).toHaveCount(0);
  await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ askCatchUpOnOpen: false }));
}

test('Ask answers: a question streams with its trace into a verdict chip, steps, a folded Detail and a file chip that opens the file at its line; Copy; Use as prompt pastes into the session without Enter; Ask again', async () => {
  // A session at its prompt (bracketed paste on, as Claude Code's) that logs every byte typed into it.
  const keys = join(mkdtempSync(join(tmpdir(), 'atl-ask-keys-')), 'keys.log');
  writeFileSync(keys, '');
  const { app, win, home, log } = await launch({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-keys.pl'), ATELIER_FAKE_BRACKETED: '1', ATELIER_FAKE_KEYS_LOG: keys, ATELIER_TEST_COMPANION_DELAY: '450'
  });
  try {
    await askOff(app, win);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });
    await command(app, 'ask-session');
    await expect(composer).toBeFocused();
    await expect(panel.getByRole('log', { name: 'Thread' })).toHaveCount(0);

    // Asked: the bubble on the right with its time; the answer starts reading (second panel).
    await composer.fill('Has it finished point 3?');
    await composer.press('Enter');
    const thread = panel.getByRole('log', { name: 'Thread' });
    const q = thread.locator('.ask-q');
    await expect(q.locator('.ask-q-t')).toHaveText('Has it finished point 3?');
    await expect(q.locator('.ask-q-meta')).toHaveText(/^\d\d:\d\d$/);
    const live = thread.locator('.ask-ans.is-live');
    await expect(live.locator('.ask-ans-hd')).toHaveText('Ask · Sonnet · Reading…');
    // Each step it reads; the chat by its real path (Claude Code reports its cwd so), the current one still going.
    const rows = live.locator('.ask-trace-row');
    await expect(rows).toHaveText(['Read the chat', "Searched the code for 'expired'", 'Reading src/app.ts']);
    await expect(rows.last()).toHaveClass(/is-now/);
    await expect(live.locator('.ask-trace')).toHaveAttribute('aria-hidden', 'true');
    await look(win, `${SHOTS}/ask-reading.png`, { settle: 150 });
    // The text streams in with a caret: the reading is done, the verdict a chip already.
    await expect(live.locator('.ask-verdict')).toBeVisible();
    await expect(rows.last()).toHaveText('Read src/app.ts');
    await expect(live.locator('.ask-caret')).toBeVisible();
    await expect(live.locator('.ask-ans-hd')).toHaveText('Ask · Sonnet');
    await look(win, `${SHOTS}/ask-streaming.png`);

    // Landed: the trace folds into "read 1 file"; verdict chip with its meter, the steps, a folded Detail.
    const answer = thread.locator('.ask-item[data-kind="answer"]');
    await expect(answer).toHaveCount(1, { timeout: 15000 });
    await expect(live).toHaveCount(0);
    await expect(answer.locator('.ask-ans-hd')).toHaveText('Ask · Sonnet · read 1 file');
    const verdict = answer.locator('.ask-verdict');
    await expect(verdict).toHaveClass(/is-in-progress/);
    await expect(verdict).toHaveText('In progress: Not yet · 2/3 tests fixed');
    await expect(verdict.locator('.ask-meter i')).toHaveCount(3);
    await expect(verdict.locator('.ask-meter i.on')).toHaveCount(2);
    await expect(answer.locator('.ask-p').first()).toHaveText('Two of the three failing auth tests pass now; the boundary one is still red.');
    await expect(answer.locator('.ask-step')).toHaveText(['1TokenStore keeps the refresh token.', '2refresh() allows 30 s of clock skew.', '3The boundary test compares expiry with <=.']);
    const detail = answer.getByRole('button', { name: 'Detail Why the boundary test failed' });
    await expect(detail).toHaveAttribute('aria-expanded', 'false');
    await expect(answer.locator('.ask-detail-bd')).toHaveCount(0);
    // Its actions show for the last answer without hovering.
    await expect(answer.locator('.ask-acts')).toBeVisible();
    await expect(answer.getByRole('button', { name: 'Use as prompt' })).not.toHaveAttribute('aria-disabled', 'true');
    await look(win, `${SHOTS}/ask-answer.png`, { settle: 300 });
    await detail.click();
    await expect(detail).toHaveAttribute('aria-expanded', 'true');
    await expect(answer.locator('.ask-detail-bd')).toContainText('The expiry check used < instead of <=, see app.ts:2.');
    // A path the project has is a chip (the file's name, its line; the path for screen readers).
    const chip = answer.getByRole('button', { name: 'src/app.ts:2' });
    await expect(chip).toHaveText('app.ts:2');
    await look(win, `${SHOTS}/ask-answer-detail.png`, { settle: 300 });

    // Copy: the answer's Markdown as text, and as clean HTML (to the test log, never the clipboard).
    const copies = () => readFileSync(join(home, 'test-clipboard.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; html: string });
    await answer.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(copies).toEqual([{ text: ANSWER, html: ANSWER_HTML }]);
    await expect(answer.getByRole('button', { name: 'Copied' })).toBeVisible();

    // Use as prompt: one bracketed paste into the session's prompt, without the verdict line and never an Enter; the
    // terminal has the keyboard to edit it.
    const before = readFileSync(keys, 'latin1').length;
    await answer.getByRole('button', { name: 'Use as prompt' }).click();
    const pasted = ANSWER.split('\n').slice(2).join('\n').trim().replace(/\n/g, '\r');
    await expect.poll(() => readFileSync(keys, 'latin1').slice(before)).toBe(`\x1b[200~${pasted}\x1b[201~`);
    await expect(win.locator('.terminal-slot:visible .xterm-helper-textarea')).toBeFocused();
    await expect(win.locator('.toast')).toContainText("In auth-refactor's prompt: edit it, then press Enter to send");
    // Still nothing after the paste: no Enter ever followed it.
    expect(readFileSync(keys, 'latin1').slice(before)).toBe(`\x1b[200~${pasted}\x1b[201~`);

    // The file chip opens the file in the editor at its line.
    await chip.click();
    await expect(win.locator('.file-view:visible .cm-activeLine')).toContainText('export const expired', { timeout: 10000 });
    await win.locator('.tab', { hasText: 'auth-refactor' }).click();
    await expect(panel).toBeVisible();

    // Ask again: the same question once more; the first answer stays, the new one comes below it.
    await answer.first().getByRole('button', { name: 'Ask again' }).click();
    await expect(thread.locator('.ask-q .ask-q-t')).toHaveText(['Has it finished point 3?', 'Has it finished point 3?']);
    await expect(answer).toHaveCount(2, { timeout: 15000 });
    expect(runs(log).map((r) => r.input)).toEqual(['Has it finished point 3?', 'Has it finished point 3?']);
  } finally {
    await stop(app, home);
  }
});

test("Ask's thread is selectable and copies formatted: a mouse selection and ⌘C, a selection across blocks, a file chip, a card's points, Copy Thread (clean HTML for documents, text too); Catch me up any time: the composer's button after a question, the ⋯ menu, the palette", async () => {
  const { app, win, home, log } = await launch({ ATELIER_TEST_COMPANION_DELAY: '450', ATELIER_TEST_COMPANION_CATCHUP_MS: '1200' });
  try {
    await askOff(app, win);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });
    await command(app, 'ask-session');
    await expect(composer).toBeFocused();
    // The empty state has its own Catch me up: none in the composer yet.
    const catchUp = panel.locator('.ask-comp').getByRole('button', { name: 'Catch me up' });
    await expect(catchUp).toHaveCount(0);

    // A question first: the thread has no Catch me up, and the composer's button offers one; it waits while Ask answers.
    await composer.fill('Has it finished point 3?');
    await composer.press('Enter');
    const thread = panel.getByRole('log', { name: 'Thread' });
    await expect(catchUp).toHaveAttribute('aria-disabled', 'true');
    const answer = thread.locator('.ask-item[data-kind="answer"]');
    await expect(answer).toHaveCount(1, { timeout: 15000 });
    await expect(catchUp).not.toHaveAttribute('aria-disabled', 'true');
    await look(win, `${SHOTS}/ask-composer-catchup.png`, { settle: 300 });

    // The words select; the chrome around them doesn't.
    const userSelect = (sel: string) => thread.locator(sel).first().evaluate((el) => getComputedStyle(el).userSelect);
    expect(await userSelect('.ask-p')).toBe('text');
    expect(await userSelect('.ask-q-t')).toBe('text');
    for (const chrome of ['.ask-ans-hd', '.ask-acts', '.ask-q-meta', '.ask-step-n']) expect(await userSelect(chrome), chrome).toBe('none');

    // A mouse selection (a triple click picks the paragraph), then ⌘C (Edit › Copy): Ask writes it, tags only.
    const clipLog = join(home, 'test-clipboard.log');
    const copies = () => (existsSync(clipLog) ? readFileSync(clipLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; html: string }) : []);
    // A guard at the window, after every other listener: Chromium's own copy never runs (a test never reaches the real
    // clipboard); it counts the copy events and the ones Ask took.
    type Guard = { copyEvents: { seen: number; ask: number } };
    await win.evaluate(() => {
      const w = window as unknown as Guard;
      w.copyEvents = { seen: 0, ask: 0 };
      window.addEventListener('copy', (e) => { w.copyEvents.seen++; if (e.defaultPrevented) w.copyEvents.ask++; else e.preventDefault(); });
    });
    const guard = () => win.evaluate(() => (window as unknown as Guard).copyEvents);
    // ⌘C as Edit › Copy runs it (webContents.copy()): one copy event, and Ask took it.
    const copy = async () => {
      const before = await guard();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy());
      await expect.poll(guard).toEqual({ seen: before.seen + 1, ask: before.ask + 1 });
    };
    const para = 'Two of the three failing auth tests pass now; the boundary one is still red.';
    await answer.locator('.ask-p').first().click({ clickCount: 3 });
    expect(await win.evaluate(() => window.getSelection()?.toString().trim())).toBe(para);
    await look(win, `${SHOTS}/ask-selected.png`, { settle: 200 });
    await copy();
    await expect.poll(() => copies().at(-1)).toEqual({ text: para, html: `<p>${para}</p>` });

    // Across blocks, ending inside a step: the verdict's state in bold, the paragraph, the steps as a list, code kept.
    await win.evaluate(() => {
      const ans = document.querySelector('.ask-item[data-kind="answer"]')!;
      const step2 = ans.querySelectorAll('.ask-step-t')[1]!;
      window.getSelection()!.setBaseAndExtent(ans.querySelector('.ask-verdict')!, 0, step2.lastChild!, ' allows'.length);
    });
    await copy();
    await expect.poll(() => copies().at(-1)).toEqual({
      text: `In progress: Not yet · 2/3 tests fixed\n\n${para}\n\n1. TokenStore keeps the refresh token.\n2. refresh() allows`,
      html: `<p><strong>In progress:</strong> Not yet · 2/3 tests fixed</p><p>${para}</p><ol><li value="1"><code>TokenStore</code> keeps the refresh token.</li><li value="2"><code>refresh()</code> allows</li></ol>`
    });

    // Steps 2–3 alone paste as 2 and 3, as the panel numbers them.
    await win.evaluate(() => {
      const steps = document.querySelectorAll('.ask-item[data-kind="answer"] .ask-step-t');
      window.getSelection()!.setBaseAndExtent(steps[1]!.lastChild!, 1, steps[2]!.firstChild!, 'The boundary'.length);
    });
    await copy();
    await expect.poll(() => copies().at(-1)).toEqual({
      text: '2. allows 30 s of clock skew.\n3. The boundary',
      html: '<ol><li value="2">allows 30 s of clock skew.</li><li value="3">The boundary</li></ol>'
    });

    // A selection running past the thread (into the composer) is cut at the thread's edge.
    await win.evaluate(() => {
      const p = document.querySelector('.ask-item[data-kind="answer"] .ask-p')!;
      window.getSelection()!.setBaseAndExtent(p.firstChild!, 0, document.querySelector('.ask-comp-row')!, 1);
    });
    await copy();
    await expect.poll(() => copies().at(-1)).toEqual({
      text: `${para}\n\n1. TokenStore keeps the refresh token.\n2. refresh() allows 30 s of clock skew.\n3. The boundary test compares expiry with <=.\n\nWhy the boundary test failed`,
      html: `<p>${para}</p><ol><li value="1"><code>TokenStore</code> keeps the refresh token.</li><li value="2"><code>refresh()</code> allows 30 s of clock skew.</li>`
        + '<li value="3">The boundary test compares expiry with <code>&lt;=</code>.</li></ol><p><strong>Why the boundary test failed</strong></p>'
    });
    // An empty selection is left alone: Ask doesn't take the copy event (a synthetic one: no copy of Chromium's runs).
    const copiesBefore = copies().length;
    const before = await guard();
    await win.evaluate(() => {
      const p = document.querySelector('.ask-item[data-kind="answer"] .ask-p')!;
      window.getSelection()!.collapse(p.firstChild!, 3);
      p.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }));
    });
    expect(await guard()).toEqual({ seen: before.seen + 1, ask: before.ask });
    expect(copies()).toHaveLength(copiesBefore);

    // An open Detail with its file chip: the title in bold, the chip as the reference the answer wrote.
    await answer.getByRole('button', { name: 'Detail Why the boundary test failed' }).click();
    await expect(answer.getByRole('button', { name: 'src/app.ts:2' })).toBeVisible();
    await win.evaluate(() => {
      const box = document.querySelector('.ask-item[data-kind="answer"] .ask-detail')!;
      window.getSelection()!.setBaseAndExtent(box, 0, box, box.childNodes.length);
    });
    await copy();
    await expect.poll(() => copies().at(-1)).toEqual({
      text: 'Why the boundary test failed\n\nThe expiry check used < instead of <=, see src/app.ts:2.',
      html: '<p><strong>Why the boundary test failed</strong></p><p>The expiry check used <code>&lt;</code> instead of <code>&lt;=</code>, see <code>src/app.ts:2</code>.</p>'
    });

    // The composer's Catch me up after the question: the composer keeps the keyboard; the card lands below the answer.
    // While it runs, the ⋯ item waits.
    await catchUp.click();
    await expect(composer).toBeFocused();
    await panel.getByRole('button', { name: 'More' }).click();
    await expect(win.getByRole('menuitem', { name: 'Catch Me Up' })).toBeDisabled();
    await win.locator('.menu-layer').click({ position: { x: 4, y: 4 } });
    await expect(win.getByRole('menuitem', { name: 'Catch Me Up' })).toHaveCount(0);
    const cards = panel.getByRole('region', { name: 'Catch me up' });
    await expect(cards).toHaveCount(1, { timeout: 15000 });
    await expect.poll(() => runs(log).map((r) => r.argv.includes('--json-schema'))).toEqual([false, true]);

    // The card's points: glyph, text, time, note, each in its place.
    await win.evaluate(() => {
      const pts = document.querySelector('.ask-card .ask-pts')!;
      window.getSelection()!.setBaseAndExtent(pts, 0, pts, pts.childNodes.length);
    });
    await copy();
    await expect.poll(() => copies().at(-1)).toEqual({
      text: '1. ✓ Refresh tokens in the token store · 12:22\n2. ✓ Refresh on expiry, with clock skew · 12:33\n3. ◐ Update the auth tests · now — Re-running them · 1 of 3 failures left\n'
        + '4. ○ Remove the old cookie path · next\n5. ○ Log out every device on password change · asked 12:38',
      html: '<ol><li value="1">✓ Refresh tokens in the token store · 12:22</li><li value="2">✓ Refresh on expiry, with clock skew · 12:33</li>'
        + '<li value="3">◐ Update the auth tests · now — Re-running them · 1 of 3 failures left</li><li value="4">○ Remove the old cookie path · next</li>'
        + '<li value="5">○ Log out every device on password change · asked 12:38</li></ol>'
    });

    // A mouse drag from point 2's first word into point 3: point 2 keeps its glyph, as point 3 does.
    // Where a point's words start or end on screen (its number before them can't be selected: a drag starts on a word).
    const wordsAt = (n: number, end: boolean) => win.evaluate(([n, end]) => {
      const tx = document.querySelectorAll('.ask-card .ask-pt')[n as number]!.querySelector('.ask-pt-tx')!;
      const r = document.createRange();
      r.selectNodeContents([...tx.childNodes].find((k) => k.nodeType === Node.TEXT_NODE)!);
      const b = r.getBoundingClientRect();
      return { x: end ? b.right - 2 : b.left + 1, y: b.top + b.height / 2 };
    }, [n, end] as const);
    const from = await wordsAt(1, false), to = await wordsAt(2, true);
    // Nothing selected first: a press inside a selection would drag its text instead.
    await win.evaluate(() => window.getSelection()?.removeAllRanges());
    await win.mouse.move(from.x, from.y);
    await win.mouse.down();
    await win.mouse.move(to.x, to.y, { steps: 5 });
    await win.mouse.up();
    await copy();
    await expect.poll(() => copies().at(-1)?.html.startsWith('<ol><li value="2">✓ Refresh on expiry, with clock skew · 12:33</li><li value="3">◐ ')).toBe(true);
    expect(copies().at(-1)!.text.startsWith('2. ✓ Refresh on expiry, with clock skew · 12:33\n3. ◐ ')).toBe(true);

    // A question while there is a card: its refresh waits for the answer (one at a time), then works again.
    await composer.fill('What is left?');
    await composer.press('Enter');
    const refresh = cards.last().locator('.ask-refresh');
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await expect(refresh).toHaveAttribute('data-tip', 'One question at a time: available when this one ends');
    await expect(answer).toHaveCount(2, { timeout: 15000 });
    await expect(refresh).not.toHaveAttribute('aria-disabled', 'true');

    // The ⋯ menu catches up too.
    await panel.getByRole('button', { name: 'More' }).click();
    await win.getByRole('menuitem', { name: 'Catch Me Up' }).click();
    await expect(cards).toHaveCount(2, { timeout: 15000 });

    // And the palette: Catch Me Up on This Session.
    await command(app, 'open-palette');
    await win.locator('.palette-input').fill('catch me up');
    const entry = win.locator('.palette .palette-item', { hasText: 'Catch Me Up on This Session' });
    await expect(entry.locator('.palette-hint')).toHaveText('auth-refactor');
    await entry.click();
    await expect(cards).toHaveCount(3, { timeout: 15000 });
    expect(runs(log).filter((r) => r.argv.includes('--json-schema'))).toHaveLength(3);

    // Copy Thread: its Markdown as text, the whole thread as HTML, never a class or a style.
    await panel.getByRole('button', { name: 'More' }).click();
    await win.getByRole('menuitem', { name: 'Copy Thread' }).click();
    await expect(win.locator('.toast')).toContainText('Thread copied');
    await expect(win.locator('.toast')).toHaveClass(/is-info/);
    const all = copies().at(-1)!;
    expect(all.text.startsWith('# Ask about auth-refactor\n\n## You · ')).toBe(true);
    expect(all.html.startsWith('<p><strong>Ask about auth-refactor</strong></p><p><strong>You · ')).toBe(true);
    expect(all.html).toContain(ANSWER_HTML);
    for (const c of copies()) expect(c.html).not.toMatch(/class=|style=|<span|<div|<button/);

    // Docked with one account, the button says what it does; in a sheet (a split pane) beside two pickers, one with a
    // long account name, only its icon shows, and the row never runs past the composer.
    await expect(catchUp.locator('.ask-cu-t')).toBeVisible();
    await win.evaluate(() => (window as unknown as SettingsApi & { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({
      claudeAccounts: { list: [{ id: 'default', name: 'Personal', dir: '', color: 1 }, { id: 'work', name: 'Work at a much longer company name', dir: '/tmp/x/.claude-work', color: 2 }], newSession: 'default', dismissed: [] }
    }));
    await panel.getByRole('button', { name: /^Account: / }).click();
    await win.getByRole('menuitem', { name: 'Work at a much longer company name' }).click();
    await command(app, 'split-right');
    await expect(win.locator('.workspace-body.is-split')).toBeVisible();
    // Split Right while docked: the pane halves and Ask turns into a sheet.
    await expect(panel).toHaveClass(/is-sheet/);
    await expect(catchUp).toBeVisible();
    await expect(catchUp.locator('.ask-cu-t')).toBeHidden();
    const row = panel.locator('.ask-comp-row');
    const spill = (el: Element) => el.scrollWidth - el.clientWidth;
    expect(await row.evaluate(spill)).toBeLessThanOrEqual(0);
    // The model's pill keeps its width; the account's name gives way, its end cut.
    expect(await row.locator('.ask-pick').first().evaluate(spill)).toBeLessThanOrEqual(0);
    expect(await row.locator('.ask-pick-t').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    await look(win, `${SHOTS}/ask-composer-narrow.png`, { settle: 400 });
  } finally {
    await stop(app, home);
  }
});

test('Ask answers go stale when the session changes files after them (Refresh asks again); Stop keeps what arrived, Stopped; a stop before any text and a failed run are items with Try again', async () => {
  // A line typed into the fake session makes it edit src/app.ts again.
  const { app, win, home, log } = await launch({ ATELIER_FAKE_EDIT_ON_INPUT: '1' });
  try {
    await askOff(app, win);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });
    const send = async (text: string) => { await composer.fill(text); await composer.press('Enter'); };
    await command(app, 'ask-session');
    const answers = panel.locator('.ask-item[data-kind="answer"]');
    await send('What changed in src/app.ts?');
    await expect(answers).toHaveCount(1, { timeout: 15000 });
    await expect(panel.locator('.ask-stale')).toHaveCount(0);

    // The session edits the file after the answer: a slim bar under it; Refresh asks again.
    await win.evaluate(async () => {
      const api = (window as unknown as { atelier: Api }).atelier;
      api.terminals.input((await api.terminals.list())[0]!.id, 'go\r');
    });
    const stale = answers.first().locator('.ask-stale');
    await expect(stale).toContainText('1 file changed after this answer', { timeout: 10000 });
    await look(win, `${SHOTS}/ask-stale.png`, { settle: 300 });
    await stale.getByRole('button', { name: 'Refresh' }).click();
    await expect(answers).toHaveCount(2, { timeout: 15000 });
    expect(runs(log).at(-1)!.input).toBe('What changed in src/app.ts?');
    // Only the latest answer is checked, and nothing changed after it.
    await expect(panel.locator('.ask-stale')).toHaveCount(0);

    // Stop midway: what arrived stays as the answer, marked Stopped.
    await send('Explain the skew SLOW');
    const live = panel.locator('.ask-ans.is-live');
    await expect(live.locator('.ask-p').first()).toContainText('Two of the three', { timeout: 10000 });
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect(answers).toHaveCount(3, { timeout: 10000 });
    await expect(live).toHaveCount(0);
    const stopped = answers.last();
    await expect(stopped.locator('.ask-ans-hd')).toContainText('Stopped');
    await expect(stopped).toContainText('Two of the three');
    await expect(stopped.locator('.ask-detail')).toHaveCount(0);

    // Stopped before any text: an item, not an answer, quiet (nothing failed), with Try again.
    await send('Hold on HANG');
    await expect(panel.locator('.ask-ans.is-live .ask-ans-hd')).toContainText('Reading…');
    await panel.getByRole('button', { name: 'Stop' }).click();
    const item = panel.locator('.ask-item[data-kind="error"]').last();
    await expect(item).toHaveText(/Stopped\s*Try again/, { timeout: 10000 });
    await expect(item).toHaveClass(/is-soft/);

    // A failed run: red-tinted, the first line of what Claude said, Try again asks the same question again.
    await send('Break it FAIL');
    const failed = panel.locator('.ask-item[data-kind="error"]').last();
    await expect(failed).toContainText('Error: the fake broke on purpose', { timeout: 10000 });
    await expect(failed).not.toHaveClass(/is-soft/);
    await look(win, `${SHOTS}/ask-errors.png`, { settle: 300 });
    const asked = runs(log).length;
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => runs(log).length).toBe(asked + 1);
    expect(runs(log).at(-1)!.input).toBe('Break it FAIL');
    await expect(panel.locator('.ask-item[data-kind="error"]')).toHaveCount(3, { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

/** A line typed into the fake session (fake-claude-edit.pl with ATELIER_FAKE_EDIT_ON_INPUT: "ev:…" sends a hook event). */
const typeIn = (win: Page, line: string) => win.evaluate(async (s) => {
  const api = (window as unknown as { atelier: Api }).atelier;
  api.terminals.input((await api.terminals.list())[0]!.id, s);
}, line);

/** Clicks a native menu item by its label (as the menu bar would) and gives its accelerator. */
const clickMenu = (app: ElectronApplication, label: string) => app.evaluate(({ Menu, BrowserWindow }, l) => {
  const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
    for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
    return undefined;
  };
  const found = walk(Menu.getApplicationMenu()!.items)!;
  found.click(undefined, BrowserWindow.getAllWindows()[0]);
  return found.accelerator ?? null;
}, label);

test('Ask while the session needs you: View › Ask About This Session (⌘I) opens it; an amber card says what it asks; Help me decide asks Ask; Answer in session gives the terminal the keyboard; the card goes when the wait ends', async () => {
  const { app, win, home, log } = await launch({ ATELIER_FAKE_EDIT_ON_INPUT: '1' });
  try {
    await askOff(app, win);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    // The menu bar's item, on ⌘I.
    expect(await clickMenu(app, 'Ask About This Session')).toBe('CmdOrCtrl+I');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.ask-needs')).toHaveCount(0);

    // The session asks a question: the card says it.
    await typeIn(win, 'ev:question\r');
    const card = panel.getByRole('region', { name: 'auth-refactor is asking you' });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByRole('button')).toHaveText(['Answer in session', 'Help me decide']);
    await look(win, `${SHOTS}/ask-needs.png`, { settle: 400 });

    // Help me decide: Ask is asked how to answer it (the run finds the question in the chat); the card stays while the
    // session still waits.
    await card.getByRole('button', { name: 'Help me decide' }).click();
    await expect(panel.locator('.ask-q .ask-q-t').last()).toHaveText('Help me decide how to answer what auth-refactor is asking now.');
    await expect.poll(() => runs(log).length).toBe(1);
    expect(runs(log)[0]!.input).toBe('Help me decide how to answer what auth-refactor is asking now.');
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(1, { timeout: 15000 });
    await expect(card).toBeVisible();
    await look(win, `${SHOTS}/ask-needs-answered.png`, { settle: 300 });

    // Answer in session: the terminal has the keyboard.
    await card.getByRole('button', { name: 'Answer in session' }).click();
    await expect(win.locator('.terminal-slot:visible .xterm-helper-textarea')).toBeFocused();
    // Answered there: the card goes.
    await typeIn(win, 'ev:answered\r');
    await expect(card).toHaveCount(0, { timeout: 10000 });

    // A permission: what for, as the session bar says it.
    await typeIn(win, 'ev:permission\r');
    const perm = panel.getByRole('region', { name: 'auth-refactor needs permission' });
    await expect(perm.locator('.ask-needs-d')).toHaveText('Bash npm test', { timeout: 10000 });
    await typeIn(win, 'ev:answered\r');
    await expect(perm).toHaveCount(0, { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('a usage limit: the item names the account and its 5-hour limit and when it resets; the picker shows it at 100%; Ask with Work asks again now on Work; Ask at HH:MM waits (Cancel) and asks again by itself at the reset', async () => {
  const { app, win, home, log } = await launch();
  try {
    await askOff(app, win);
    const work = join(home, 'cfg', '.claude-work');
    await win.evaluate((dir) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({
      claudeAccounts: { list: [{ id: 'default', name: 'Personal', dir: '', color: 1 }, { id: 'work', name: 'Work', dir, color: 2 }], newSession: 'default', dismissed: [] }
    }), work);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });
    const send = async (text: string) => { await composer.fill(text); await composer.press('Enter'); };
    await command(app, 'ask-session');
    await send("What's left? LIMIT");

    const item = panel.locator('.ask-item[data-reason="limit"]');
    await expect(item).toBeVisible({ timeout: 15000 });
    await expect(item.locator('.ask-lim-t')).toHaveText('Personal hit its 5-hour limit');
    // In two hours: the clock, and the weekday when that is tomorrow (a run late in the evening).
    await expect(item.locator('.ask-lim-d')).toHaveText(/^It resets at (?:[A-Z][a-z]{2} )?\d\d:\d\d\. auth-refactor keeps working; only Ask is paused\.$/);
    const clock = /(?:[A-Z][a-z]{2} )?\d\d:\d\d/.exec((await item.locator('.ask-lim-d').textContent())!)![0];
    const other = item.getByRole('button', { name: 'Ask with Work' });
    const at = item.getByRole('button', { name: `Ask at ${clock}` });
    await expect(other).toBeVisible();
    await expect(at).toBeVisible();
    // The composer's account picker: Personal, at its limit (rose).
    await expect(panel.locator('.ask-pick.is-limit')).toHaveText('Personal · 100%');
    await look(win, `${SHOTS}/ask-limit.png`, { settle: 300 });

    // Ask at: it says it will, until Cancel.
    await at.click();
    await expect(item.locator('.ask-lim-wait')).toContainText(`Will ask at ${clock}`);
    await expect(at).toHaveCount(0);
    // The keyboard follows to the button that took its place, and back.
    const cancel = item.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused();
    await look(win, `${SHOTS}/ask-limit-wait.png`, { settle: 200 });
    await cancel.click();
    await expect(at).toBeVisible();
    await expect(at).toBeFocused();

    // Ask with Work: the same question now, on Work's config dir; it answers, and the thread's picker is on Work.
    await other.click();
    await expect.poll(() => runs(log).length).toBe(2);
    expect(runs(log)[1]).toMatchObject({ input: "What's left? LIMIT", configDir: work });
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(1, { timeout: 15000 });
    await expect(panel.getByRole('button', { name: 'Account: Work' })).toBeVisible();
    await expect(panel.locator('.ask-pick.is-limit')).toHaveCount(0);
    // An older limit offers nothing any more, and still names the account that hit it (not the thread's Work now).
    await expect(item.locator('.ask-btn')).toHaveCount(0);
    await expect(item.locator('.ask-lim-t')).toHaveText('Personal hit its 5-hour limit');

    // Back on the session's account, a limit that resets in seconds: Ask at asks again by itself at the reset.
    await panel.getByRole('button', { name: 'Account: Work' }).click();
    await win.getByRole('menuitem', { name: "The session's (Personal)" }).click();
    await send('And now? LIMIT SOON');
    const soon = panel.locator('.ask-item[data-reason="limit"]').last();
    await expect(panel.locator('.ask-item[data-reason="limit"]')).toHaveCount(2, { timeout: 15000 });
    await soon.getByRole('button', { name: /^Ask at (?:[A-Z][a-z]{2} )?\d\d:\d\d$/ }).click();
    await expect(soon.locator('.ask-lim-wait')).toBeVisible();
    await expect.poll(() => runs(log).length, { timeout: 20000 }).toBe(4);
    expect(runs(log)[3]).toMatchObject({ input: 'And now? LIMIT SOON', configDir: null });
    await expect(soon.locator('.ask-lim-wait')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('Ask answered while you were away: the row\'s violet mark and the pill\'s dot until Ask is opened; the row menu and the palette ("Ask about", its hints) open Ask', async () => {
  const { app, win, home } = await launch({ ATELIER_TEST_COMPANION_DELAY: '500' });
  try {
    await askOff(app, win);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });
    const row = win.locator('.session-row', { hasText: 'auth-refactor' });

    // The row's menu: Ask About This Session (⌘I) after Session Panel opens it, the composer ready.
    await row.click({ button: 'right' });
    const entry = win.getByRole('menuitem', { name: /^Ask About This Session/ });
    await expect(entry).toContainText('⌘I');
    await look(win, `${SHOTS}/ask-row-menu.png`, { settle: 200 });
    await entry.click();
    await expect(panel).toBeVisible();
    await expect(composer).toBeFocused();

    // A question, then Ask closed before it answers: no mark while it works.
    await composer.fill('What is it doing?');
    await composer.press('Enter');
    await expect(panel.locator('.ask-ans.is-live')).toBeVisible({ timeout: 10000 });
    await composer.press('Escape');
    await expect(panel).toBeHidden();
    const mark = row.getByRole('button', { name: 'Ask answered while you were away: open Ask about auth-refactor' });
    await expect(mark).toHaveCount(0);
    // It lands: the row's mark and the pill's dot.
    await expect(mark).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.session-bar .sb-ask .sb-ask-dot')).toBeVisible();

    // The palette: Ask About This Session (the selected one) and Ask about each session, with its hint.
    await command(app, 'open-palette');
    await win.locator('.palette-input').fill('ask');
    const pal = win.locator('.palette');
    await expect(pal.locator('.palette-item', { hasText: 'Ask About This Session' }).locator('.palette-hint')).toHaveText('auth-refactor  ⌘I');
    await expect(pal.locator('.palette-section', { hasText: 'Ask about' })).toBeVisible();
    const about = pal.locator('.palette-item', { hasText: 'auth-refactor' }).filter({ has: win.locator('.palette-hint.is-ask') });
    await expect(about.locator('.palette-hint')).toHaveText('New answer');
    await look(win, `${SHOTS}/ask-palette.png`, { settle: 200 });
    await win.keyboard.press('Escape');
    await expect(pal).toHaveCount(0);

    // The mark's tooltip, then a click opens Ask and clears it (and the dot).
    await mark.hover();
    await expect(win.locator('.tooltip')).toContainText('Ask answered while you were away');
    await expect(win.locator('.tooltip')).toContainText('auth-refactor · click to open it');
    await look(win, `${SHOTS}/ask-mark.png`, { settle: 300 });
    await mark.click();
    await expect(panel).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(mark).toHaveCount(0, { timeout: 10000 });
    await expect(win.locator('.session-bar .sb-ask .sb-ask-dot')).toHaveCount(0);
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(1);

    // Closed again, the palette's Ask About This Session opens it; the "Ask about" row says it is working.
    await command(app, 'ask-session');
    await expect(panel).toBeHidden();
    await command(app, 'open-palette');
    await win.locator('.palette-input').fill('ask');
    await expect(pal.locator('.palette-item', { hasText: 'auth-refactor' }).locator('.palette-hint', { hasText: 'working' })).toHaveCount(1);
    await pal.locator('.palette-item', { hasText: 'Ask About This Session' }).click();
    await expect(panel).toBeVisible();
    await expect(composer).toBeFocused();
  } finally {
    await stop(app, home);
  }
});

test('Settings › Ask: edits persist across a reopen; the Account row shows only with two accounts; What I already know stops at 2000, saves on blur; Ask ⋯ › Ask Settings… opens the section after Connectors', async () => {
  const { app, win, home } = await launch();
  try {
    await askOff(app, win);
    await newSession(win, 'auth-refactor');
    const panel = win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    await command(app, 'ask-session');
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'More' }).click();
    await win.getByRole('menuitem', { name: 'Ask Settings…' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('heading', { name: 'Ask' })).toBeVisible();
    const nav = await dialog.locator('.set-nav-item').allTextContents();
    expect(nav.indexOf('Ask')).toBe(nav.indexOf('Connectors') + 1);
    expect(nav.indexOf('Connectors')).toBe(nav.indexOf('Claude') + 1);

    // One account: no Account row.
    await expect(dialog.getByRole('radiogroup', { name: 'Account' })).toHaveCount(0);
    await dialog.getByRole('radio', { name: 'Opus' }).click();
    await dialog.getByRole('radio', { name: 'Detailed' }).click();
    // askOff() turned it off: the click turns it back on.
    await expect(dialog.getByRole('switch', { name: 'Catch me up when opened' })).toHaveAttribute('aria-checked', 'false');
    await dialog.getByRole('switch', { name: 'Catch me up when opened' }).click();
    const known = dialog.getByRole('textbox', { name: 'What I already know' });
    await known.fill('x'.repeat(2100));
    await expect(known).toHaveValue('x'.repeat(2000));
    await expect(dialog.locator('.ask-known-count')).toHaveText('2000 / 2000');
    // A clipped insertion puts the caret back a frame later; a selection made before that frame stays (it used to
    // collapse a select-all, so the next fill went in after the 2000 x's and was clipped away: a red under load).
    const selection = await known.evaluate(async (el: HTMLTextAreaElement) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, `${el.value}yy`);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.select();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return [el.selectionStart, el.selectionEnd];
    });
    expect(selection).toEqual([0, 2000]);
    // Untouched, the caret goes back where the insertion left it, not to the end.
    const caret = await known.evaluate(async (el: HTMLTextAreaElement) => {
      el.setRangeText('ab', 10, 10, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return [el.selectionStart, el.selectionEnd];
    });
    expect(caret).toEqual([10, 10]);
    await known.fill('TypeScript and Postgres: skip the basics.');
    await expect(dialog.locator('.ask-known-count')).toHaveText('41 / 2000');
    // Not saved while typing; saved on blur.
    expect(await knownSaved(win)).toBe('');
    await dialog.getByRole('radio', { name: 'Haiku' }).click();
    await expect.poll(() => knownSaved(win)).toBe('TypeScript and Postgres: skip the basics.');
    // A real click focuses the field and text can be typed and selected (the sheet swallows mousedown elsewhere).
    await known.fill('');
    await dialog.getByRole('radio', { name: 'Opus' }).click();
    await expect(known).not.toBeFocused();
    await known.click();
    await expect(known).toBeFocused();
    await win.keyboard.type('Mouse path');
    await dialog.getByRole('radio', { name: 'Sonnet' }).click();
    await expect.poll(() => knownSaved(win)).toBe('Mouse path');
    // A change from outside shows while the field is unfocused; focused but unedited, it shows on blur.
    const setKnown = (v: string) => win.evaluate((x) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ askKnown: x }), v);
    await setKnown('From outside');
    await expect(known).toHaveValue('From outside');
    await dialog.getByRole('radio', { name: 'Opus' }).click();
    await known.click();
    await setKnown('Again outside');
    await dialog.getByRole('radio', { name: 'Haiku' }).click();
    await expect(known).toHaveValue('Again outside');
    await known.fill('TypeScript and Postgres: skip the basics.');
    await dialog.getByRole('radio', { name: 'Haiku' }).click();
    await expect.poll(() => knownSaved(win)).toBe('TypeScript and Postgres: skip the basics.');
    // Esc in a field with text leaves the sheet open; the next Esc (field empty-handed) closes it.
    await known.focus();
    await win.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({
      claudeAccounts: { list: [{ id: 'default', name: 'Personal', dir: '', color: 1 }, { id: 'work', name: 'Work', dir: '/tmp/x/.claude-work', color: 2 }], newSession: 'default', dismissed: [] }
    }));
    await panel.getByRole('button', { name: 'More' }).click();
    await win.getByRole('menuitem', { name: 'Ask Settings…' }).click();
    await expect(dialog.getByRole('radio', { name: 'Haiku' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('radio', { name: 'Detailed' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('switch', { name: 'Catch me up when opened' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('textbox', { name: 'What I already know' })).toHaveValue('TypeScript and Postgres: skip the basics.');
    const account = dialog.getByRole('radiogroup', { name: 'Account' });
    await expect(account.getByRole('radio')).toHaveText(["The session's", 'Personal', 'Work']);
    await account.getByRole('radio', { name: 'Work' }).click();
    await expect(account.getByRole('radio', { name: 'Work' })).toHaveAttribute('aria-checked', 'true');
    await look(win, `${SHOTS}/ask-settings.png`, { settle: 300 });
  } finally {
    await stop(app, home);
  }
});

test('Ask: the thread survives an app restart (the session lives on in atelierd): the question and its answer are there, and the next question resumes the same Claude conversation', async () => {
  let run = await launch();
  try {
    await askOff(run.app, run.win);
    await newSession(run.win, 'auth-refactor');
    let panel = run.win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    await command(run.app, 'ask-session');
    await panel.getByRole('textbox', { name: 'Ask about auth-refactor' }).fill('Has it finished point 3?');
    await panel.getByRole('textbox', { name: 'Ask about auth-refactor' }).press('Enter');
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(1, { timeout: 15000 });
    expect(runs(run.log)).toHaveLength(1);
    expect(runs(run.log)[0]!.argv).toContain('--session-id');
    const uuid = flag(runs(run.log)[0]!.argv, '--session-id')!;
    // Quit the app (its sessions stay in atelierd: ATELIER_TEST_CLOSE_SESSIONS=keep) and open it again on the same home.
    await run.app.close();
    run = await launch({}, run);
    await expect(run.win.locator('.footer')).toBeVisible({ timeout: 15000 });
    await run.win.locator('.session-row', { hasText: 'auth-refactor' }).click();
    await expect(run.win.locator('.session-bar .sb-ask')).toBeVisible({ timeout: 20000 });
    panel = run.win.getByRole('complementary', { name: 'Ask about auth-refactor' });
    await command(run.app, 'ask-session');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.ask-q .ask-q-t')).toHaveText(['Has it finished point 3?']);
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(1);
    await expect(panel.locator('.ask-item[data-kind="answer"] .ask-verdict')).toHaveText('In progress: Not yet · 2/3 tests fixed');
    await look(run.win, `${SHOTS}/ask-restart.png`, { settle: 300 });
    // The next question resumes the same conversation.
    const composer = panel.getByRole('textbox', { name: 'Ask about auth-refactor' });
    await composer.fill('And point 4?');
    await composer.press('Enter');
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toHaveCount(2, { timeout: 15000 });
    const all = runs(run.log);
    expect(all).toHaveLength(2);
    expect(all[1]!.input).toBe('And point 4?');
    expect(flag(all[1]!.argv, '--resume')).toBe(uuid);
    expect(all[1]!.argv).not.toContain('--session-id');
  } finally {
    await stop(run.app, run.home);
  }
});
