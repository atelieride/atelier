import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// A session's Artifacts, end to end: the fake Claude publishes pages the way Claude Code does (ev:artifact…, see
// fake-claude.pl: the tool's hooks and its lines in the session's transcript, under the test's own Claude roots); main
// reads them from the transcript, the session bar's chip counts them and its popover lists them, opening one in the
// browser (recorded in ATELIER_TEST_URL_LOG instead). Screenshots go to e2e-shots/ (git-ignored) and are looked at.

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

const SHOTS = resolve('e2e-shots/artifacts');
// Claude Code's session ids are UUIDs: main computes no transcript path for anything else.
const SID = '6c2f1e0a-7b3d-4e5f-8a9b-0c1d2e3f4a5b';
const URL_1 = 'https://claude.ai/artifact/e2eArtifacta1';
const URL_2 = 'https://claude.ai/artifact/e2eArtifacta2';

const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });
const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });

/** Types into a session's prompt without selecting it. */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const a = (window as unknown as { atelier: Api }).atelier;
    const id = (await a.terminals.list()).find((x) => x.title === title)!.id;
    a.terminals.input(id, text);
  }, { title, text });
}

/** Fake Claude events, one line each, a little apart (atelierd coalesces terminal lists for 100 ms). */
async function events(win: Page, title: string, list: string[]) {
  for (const e of list) {
    await typeInto(win, title, `ev:${e}\r`);
    await win.waitForTimeout(150);
  }
}

interface Launched { app: ElectronApplication; home: string; win: Page; urls: string }

async function launch(): Promise<Launched> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  // Claude Code's temp root and projects folder, the test's own (never /tmp/claude-<uid> or ~/.claude/projects).
  const base = mkdtempSync(join(tmpdir(), 'atl-claude-'));
  const claudeTmp = join(base, 'tmp');
  const projects = join(base, 'projects');
  mkdirSync(claudeTmp);
  mkdirSync(projects);
  const urls = join(base, 'urls.log');
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: SID,
    ATELIER_TEST_CLAUDE_TMP: claudeTmp, ATELIER_TEST_CLAUDE_PROJECTS: projects, ATELIER_TEST_URL_LOG: urls
  });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  // Anything failing past the launch stops the app (and its atelierd): the caller's finally never sees it.
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1500, 950));
    mkdirSync(SHOTS, { recursive: true });
    return { app, home, win, urls };
  } catch (e) {
    await stop({ app, home });
    throw e;
  }
}

async function stop({ app, home }: Pick<Launched, 'app' | 'home'>) {
  try { await app.close(); } finally {
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
}

/** A Claude session through its first turn (waiting on a permission, then done); its cwd reported. */
async function session(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
  await typeInto(win, name, '\r');
  await expect(row(win, name)).toHaveClass(/state-done/, { timeout: 20000 });
  await typeInto(win, name, 'ev:bg-cwd\r');
}

const opened = (urls: string) => (existsSync(urls) ? readFileSync(urls, 'utf8').trim().split('\n') : []);

test('a session\'s artifacts: counted on its chip (never as work), listed first in its popover, opened in the browser', async () => {
  test.setTimeout(90000);
  const l = await launch();
  const { win } = l;
  try {
    await session(win, 'Pari');
    await row(win, 'Pari').locator('.row-main').click();
    const chip = win.locator('.session-bar .work-chip');
    await expect(chip).toHaveCount(0);

    // A page published, the turn over: the bar's chip counts it, without the working dot; the session stays done and
    // the sidebar row gets no chip for it.
    await events(win, 'Pari', ['artifact:a1:Concept board', 'stop']);
    await expect(chip.locator('.work-full')).toHaveText('1 artifact', { timeout: 10000 });
    await expect(chip.locator('.work-dot')).toHaveCount(0);
    await expect(chip).toHaveAttribute('data-tip', /^1 artifact\nartifact · Concept board\n/);
    await expect(row(win, 'Pari')).toHaveClass(/state-done/);
    await expect(row(win, 'Pari').locator('.work-chip')).toHaveCount(0);

    // A second one, and a watch on its comments (background work that never counts): both on the chip.
    await events(win, 'Pari', ['artifact:a2:Pari · giro UX 1', 'bg-watch:w1:Artifact comments']);
    await expect(chip.locator('.work-full')).toHaveText('1 monitor · 2 artifacts', { timeout: 10000 });

    // The popover: Artifacts first, newest first, with their links; the focus on the first one.
    await chip.click();
    const pop = win.getByRole('dialog', { name: 'Background' });
    await expect(pop).toBeVisible();
    await expect(pop.locator('.bgp-summary')).toHaveText('1 running · 2 artifacts');
    const arts = pop.locator('[data-section="artifacts"] .bgp-row');
    await expect(arts).toHaveCount(2);
    await expect(arts.nth(0).locator('.bgp-name')).toHaveText('Pari · giro UX 1');
    await expect(arts.nth(0).locator('.bgp-sub')).toHaveText('claude.ai/artifact/e2eArtifacta2');
    await expect(arts.nth(1).locator('.bgp-name')).toHaveText('Concept board');
    await expect(arts.nth(0)).toBeFocused();
    await expect(pop.locator('.bgp-section').nth(1).locator('.bgp-label')).toHaveText('Monitors');
    await still(win);
    await look(win, join(SHOTS, 'popover.png'));

    // Its context menu: Open in Browser and Copy Link (not clicked: tests never touch the clipboard).
    await arts.nth(1).click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Open in Browser' })).toBeVisible();
    await expect(win.getByRole('menuitem', { name: 'Copy Link' })).toBeVisible();
    await win.getByRole('menuitem', { name: 'Open in Browser' }).click();
    await expect.poll(() => opened(l.urls)).toEqual([URL_1]);
    await expect(pop).toBeHidden();

    // Enter on a row opens it too, and closes the popover.
    await chip.click();
    await expect(arts.nth(0)).toBeFocused();
    await win.keyboard.press('Enter');
    await expect.poll(() => opened(l.urls)).toEqual([URL_1, URL_2]);
    await expect(pop).toBeHidden();

    // Deleted by the session: gone from the chip and the popover.
    await events(win, 'Pari', ['artifact-delete:a2']);
    await expect(chip.locator('.work-full')).toHaveText('1 monitor · 1 artifact', { timeout: 10000 });
    await chip.click();
    await expect(arts).toHaveCount(1);
    await expect(arts.nth(0).locator('.bgp-name')).toHaveText('Concept board');
  } finally {
    await stop(l);
  }
});

test('only artifacts: the popover offers no inspector, and the chip goes once the session ends', async () => {
  test.setTimeout(90000);
  const l = await launch();
  const { win } = l;
  try {
    await session(win, 'Solo');
    await row(win, 'Solo').locator('.row-main').click();
    await events(win, 'Solo', ['artifact:a1:Concept board', 'stop']);
    const chip = win.locator('.session-bar .work-chip');
    await expect(chip.locator('.work-full')).toHaveText('1 artifact', { timeout: 10000 });
    await chip.click();
    const pop = win.getByRole('dialog', { name: 'Background' });
    await expect(pop.locator('.bgp-summary')).toHaveText('1 artifact');
    await expect(pop.locator('.bgp-open')).toHaveCount(0);
    await expect(pop.locator('.bgp-empty')).toHaveCount(0);
    await still(win);
    await look(win, join(SHOTS, 'only-artifacts.png'));
    await win.keyboard.press('Escape');
    await events(win, 'Solo', ['session-end']);
    await expect(chip).toHaveCount(0, { timeout: 10000 });
  } finally {
    await stop(l);
  }
});
