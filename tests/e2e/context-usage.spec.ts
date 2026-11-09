import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Context usage: a fake session (fake-claude-keys.pl, logs every byte typed into it), its
// transcript under ATELIER_TEST_CLAUDE_PROJECTS, and a fake `claude -p` for the private copy (fake-claude-context.mjs)
// answering the control protocol with tests/fixtures/context/usage.json. Never the real claude.

const SID = '7c1d2e3f-0000-4000-8000-00000000c0de';
type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };
const line = (o: object) => JSON.stringify(o) + '\n';
const reply = (cwd: string, input: number) => line({ type: 'assistant', sessionId: SID, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 2, cache_creation_input_tokens: 2_501, cache_read_input_tokens: input, output_tokens: 10 } } });

interface Launched { app: ElectronApplication; win: Page; home: string; log: string; modeFile: string; keys: string; project: string; transcripts: string[] }

async function launch(mode = 'ok'): Promise<Launched> {
  const tmp = mkdtempSync(join(tmpdir(), 'atl-ctx-'));
  const project = join(tmp, 'shop');
  mkdirSync(project);
  writeFileSync(join(project, 'CLAUDE.md'), '# Shop\n\nRun the tests before committing.\n');
  // The session's transcript, the cwd encoded as Claude Code does (both spellings); its last reply's input is the one
  // the fixture's analysis saw (2 + 2501 + 99351), so nothing came since.
  const projects = join(tmp, 'claude-projects');
  const transcripts: string[] = [];
  for (const cwd of new Set([project, realpathSync(project)])) {
    const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SID}.jsonl`);
    writeFileSync(file, line({ type: 'user', sessionId: SID, cwd, message: { role: 'user', content: 'Tidy the sales sheet' } }) + reply(cwd, 99_351));
    transcripts.push(file);
  }
  const log = join(tmp, 'context.log');
  const modeFile = join(tmp, 'mode');
  const keys = join(tmp, 'keys.log');
  writeFileSync(log, '');
  writeFileSync(modeFile, mode);
  writeFileSync(keys, '');
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-keys.pl'), ATELIER_FAKE_SESSION_ID: SID, ATELIER_FAKE_KEYS_LOG: keys,
    ATELIER_TEST_CLAUDE_PROJECTS: projects,
    ATELIER_TEST_CONTEXT_CLAUDE: resolve('tests/e2e/fake-claude-context.mjs'), CTX_FAKE_LOG: log, CTX_FAKE_MODE_FILE: modeFile
  });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  return { app, win, home, log, modeFile, keys, project, transcripts };
}

async function stop(l: Launched) {
  await l.app.close();
  try { process.kill((JSON.parse(readFileSync(join(l.home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toHaveClass(/state-done/, { timeout: 20000 });
  await expect(win.locator('.session-bar .sb-model')).toContainText('Opus 5.5', { timeout: 10000 });
}

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    api.terminals.input((await api.terminals.list()).find((x) => x.title === title)!.id, text);
  }, { title, text });
}

const runs = (log: string) => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string; entrypoint: string | null; configDir: string | null });

test('Context usage: from the Session panel\'s tile, a private copy is asked; the donut, the groups, a server\'s tools, a memory file opens; live, Refresh, the palette', async () => {
  const l = await launch();
  const { win } = l;
  try {
    await newSession(win, 'Sales');
    await win.locator('.session-bar .sb-model').click();
    const panel = win.getByRole('dialog', { name: /^Session: / });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /Context/ }).click();

    // The sheet replaces the panel and analyses: the private copy's steps, then the report.
    const sheet = win.getByRole('dialog', { name: 'Context: Sales' });
    await expect(sheet).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(sheet.locator('.cxu-steps')).toBeVisible();
    await look(win, 'test-results/context-analyzing.png', { settle: 0 });
    await expect(sheet.locator('.cxu-when')).toHaveText('Analyzed just now', { timeout: 15000 });

    // One run: a forked, unsaved copy of this session, its model, the user's hooks off, as the default account.
    const [run] = runs(l.log);
    expect(run!.argv).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--resume', SID, '--fork-session', '--model', 'opus']);
    expect(realpathSync(run!.cwd)).toBe(realpathSync(l.project));
    expect(run!.entrypoint).toBe('atelier-context');
    expect(run!.configDir).toBeNull();
    // Nothing was typed into the live session.
    expect(readFileSync(l.keys, 'latin1')).toBe('');

    // The numbers, the window, the donut and the groups ranked by size.
    await expect(sheet.locator('.cxu-tile').first()).toContainText('103.3k');
    await expect(sheet.locator('.cxu-tile').nth(1)).toContainText('76.6k');
    await expect(sheet.locator('.cxu-arc')).toHaveCount(5);
    const groups = sheet.getByRole('listbox', { name: 'Groups' }).getByRole('option');
    await expect(groups).toHaveText([/^System\s*31\.4k/, /^Messages\s*26\.7k/, /^MCP servers\s*19\.4k/, /^Memory files\s*17\.8k/, /^Skills\s*8k/]);
    await expect(sheet.getByRole('option', { name: /MCP servers/ })).toHaveAttribute('aria-selected', 'true');

    // MCP servers: the largest open with its loaded tools; its config file can't open (the fixture's isn't on disk);
    // claude.ai's says where to change it; servers not connected are counted apart; no URL anywhere.
    const docs = sheet.getByRole('button', { name: /shop-docs/ });
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet.locator('.cxu-tools').first()).toContainText('get_page');
    await expect(sheet.locator('.cxu-tools').first()).toContainText('2 tools waiting outside the context');
    await sheet.getByRole('button', { name: /claude\.ai Tasks/ }).click();
    await expect(sheet.locator('.cxu-where').last()).toContainText('claude.ai › Settings › Connectors');
    await expect(sheet.locator('.cxu-offline')).toHaveText('1 server not connected · cost nothing');
    expect(await sheet.textContent()).not.toContain('e2e-secret');
    await look(win, 'test-results/context-mcp.png');

    // Arrows move through the groups; Messages has Compact.
    await sheet.getByRole('option', { name: /MCP servers/ }).focus();
    await win.keyboard.press('ArrowUp');
    await expect(sheet.getByRole('option', { name: /Messages/ })).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.locator('.cxu-dhead')).toContainText('Messages');
    await expect(sheet.getByRole('button', { name: 'Compact' })).toBeVisible();
    await expect(sheet.locator('.cxu-row', { hasText: 'Bash' })).toContainText('6.1k');
    await look(win, 'test-results/context-messages.png');

    // The conversation counts live: a new reply in the transcript, then the session's state changes.
    for (const f of l.transcripts) appendFileSync(f, reply(l.project, 99_351 + 3_400));
    await typeInto(win, 'Sales', 'work\r');
    await expect(win.locator('.session-row', { hasText: 'Sales' })).toHaveClass(/state-running/, { timeout: 10000 });
    await typeInto(win, 'Sales', 'stop\r');
    await expect(sheet.locator('.cxu-tile').nth(2)).toContainText('+3.4k since analyzed', { timeout: 10000 });
    await expect(sheet.locator('.cxu-row', { hasText: 'Since analyzed' })).toContainText('3.4k');

    // Memory files: the session folder's CLAUDE.md opens in a tab; the sheet closes.
    await sheet.getByRole('option', { name: /Memory files/ }).click();
    await look(win, 'test-results/context-memory.png');
    await sheet.getByRole('button', { name: /^Open .*CLAUDE\.md$/ }).first().click();
    await expect(sheet).toBeHidden();
    await expect(win.locator('.tab', { hasText: 'CLAUDE.md' })).toBeVisible();

    // The palette opens it again: the last report shows at once while it analyses again; then Refresh.
    // Back on the session (the file's editor has the keyboard), then the search box.
    await win.locator('.session-row', { hasText: 'Sales' }).click();
    await win.getByRole('button', { name: /^Search/ }).click();
    await win.keyboard.type('Analyze Context');
    await expect(win.locator('.palette')).toContainText('Analyze Context');
    await win.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.cxu-when')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => runs(l.log).length).toBe(2);
    await sheet.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => runs(l.log).length, { timeout: 15000 }).toBe(3);
    await expect(sheet.locator('.cxu-when')).toHaveText('Analyzed just now', { timeout: 15000 });

    // Esc closes it; the Session panel's tile now shows the split of the last report.
    await win.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await win.locator('.session-bar .sb-model').click();
    await expect(panel.locator('.spanel-split i')).toHaveCount(5);
    await look(win, 'test-results/context-panel-tile.png');
  } finally {
    await stop(l);
  }
});

test('Context usage: a Claude Code that doesn\'t report it says so, Run /context types it; Try Again; the session menu', async () => {
  const l = await launch('unsupported');
  const { win } = l;
  try {
    await newSession(win, 'Old');
    await win.locator('.session-row', { hasText: 'Old' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Context Usage…' }).click();
    const sheet = win.getByRole('dialog', { name: 'Context: Old' });
    const failed = sheet.getByRole('alert');
    await expect(failed).toContainText('Couldn’t analyze this session', { timeout: 15000 });
    await expect(failed).toContainText('This version of Claude Code doesn’t report its context to Atelier.');
    await look(win, 'test-results/context-failed.png');

    // Try Again once it answers.
    writeFileSync(l.modeFile, 'ok');
    await failed.getByRole('button', { name: 'Try Again' }).click();
    await expect(sheet.locator('.cxu-when')).toHaveText('Analyzed just now', { timeout: 15000 });
    await expect(failed).toBeHidden();

    // A run that ends early: the error card over the last report; Run /context types it into the session.
    writeFileSync(l.modeFile, 'exit');
    await sheet.getByRole('button', { name: 'Refresh' }).click();
    await expect(failed).toContainText('No conversation found with session ID: e2e', { timeout: 15000 });
    await expect(sheet.locator('.cxu-arc')).toHaveCount(5);
    await failed.getByRole('button', { name: 'Run /context in the Session' }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => readFileSync(l.keys, 'latin1')).toBe('/context\r');
  } finally {
    await stop(l);
  }
});
