import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Background inspector, end to end: the fake Claude starts background work and writes
// the files Claude Code would (ev:bg-out, ev:bg-exit, ev:bg-agent…, see fake-claude.pl) under the test's own Claude
// roots; the chip's popover opens the Background tab beside the session, which follows them live. Screenshots go to
// e2e-shots/ (git-ignored) and are looked at.

type Api = {
  terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void };
  background: { watch(terminalId: string, itemId: string): Promise<{ ok: boolean; reason?: string }> };
};

const SHOTS = resolve('e2e-shots/background-inspector');
// Claude Code's session ids are UUIDs: the inspector computes no path for anything else.
const SID = '4b1d2c3e-5f60-4718-9a2b-3c4d5e6f7a8b';

const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

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

// (Page functions run in the window: they reach the bridge themselves.)
const terminalId = (win: Page, title: string) => win.evaluate(async (t) => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).find((x) => x.title === t)!.id, title);
const watchFrom = (page: Page, terminal: string, item: string) => page.evaluate(([t, i]) => (window as unknown as { atelier: Api }).atelier.background.watch(t, i), [terminal, item] as const);
const termCount = (page: Page) => page.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).length);

interface Launched { app: ElectronApplication; home: string; win: Page }

async function launch(o: { recent?: string[]; size?: [number, number]; extra?: Record<string, string> } = {}): Promise<Launched> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  // Claude Code's temp root and projects folder, the test's own (never /tmp/claude-<uid> or ~/.claude/projects).
  const base = mkdtempSync(join(tmpdir(), 'atl-claude-'));
  const claudeTmp = join(base, 'tmp');
  const projects = join(base, 'projects');
  mkdirSync(claudeTmp);
  mkdirSync(projects);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: SID, ATELIER_TEST_CLAUDE_TMP: claudeTmp, ATELIER_TEST_CLAUDE_PROJECTS: projects, ...o.extra });
  if (o.recent) writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: o.recent, quitInfoShown: true }));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  // Anything failing past the launch stops the app (and its atelierd): the caller's finally never sees it.
  try {
    const win = await app.firstWindow();
    if (o.size) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w, h), o.size);
    mkdirSync(SHOTS, { recursive: true });
    return { app, home, win };
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

/** `inner`'s bounding box lies inside `outer`'s (half a pixel of rounding). */
async function inside(page: Page, inner: string, outer: string) {
  return page.evaluate(([i, o]) => {
    const a = document.querySelector(i)!.getBoundingClientRect();
    const b = document.querySelector(o)!.getBoundingClientRect();
    return a.width > 0 && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  }, [inner, outer] as const);
}

test('chip → popover → Background tab beside the session; output, exit code and timeline arrive live', async () => {
  test.setTimeout(90000);
  // Wide enough for the list beside the details (≥ 640 px with two panes).
  const l = await launch({ size: [2000, 1100] });
  const { win } = l;
  try {
    await session(win, 'Auth');
    await events(win, 'Auth', ['bg-shell:b1:npm test -- auth', 'bg-out:b1:✓ session.test.ts (24 tests)', 'bg-agent:a1']);
    await row(win, 'Auth').locator('.row-main').click();
    const chip = win.locator('.session-bar .work-chip');
    await expect(chip).toContainText('1 agent · 1 shell', { timeout: 10000 });

    // First open after launch: the focus is on the first row, ↓ moves it, Esc closes and gives it back to the chip.
    await chip.click();
    const pop = win.getByRole('dialog', { name: 'Background' });
    await expect(pop).toBeVisible();
    const rows = pop.locator('.bgp-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toBeFocused();
    await win.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(chip).toBeFocused();

    await chip.click();
    await expect(pop).toBeVisible();
    await expect(pop.locator('.bgp-open')).toHaveText('Open inspector ⌘⌥B');
    await still(win);
    await look(win, join(SHOTS, 'popover.png'));
    await pop.locator('.bgp-row', { hasText: 'npm test' }).click();
    // Beside the session: two panes, the Background one showing the shell's output.
    await expect(win.locator('.workspace-body.is-split')).toBeVisible();
    const view = win.locator('.bgv');
    await expect(view).toBeVisible();
    await expect(view.locator('.bgv-list')).toBeVisible();
    await expect(view.locator('.bgv-head .bgv-name')).toHaveText('npm test -- auth');
    const log = view.locator('.bgv-log');
    await expect(log).toContainText('session.test.ts (24 tests)', { timeout: 10000 });
    const state = view.locator('.bgv-head .bgv-state');
    await expect(state).toHaveText('Running');
    // A line appended to the output file shows up without touching anything.
    await typeInto(win, 'Auth', 'ev:bg-out:b1:✗ focus-listener.test.ts (1 failed)\r');
    await expect(log).toContainText('focus-listener.test.ts (1 failed)', { timeout: 5000 });
    // The exit trailer arrives live too: the state pill turns to the exit code, no reopening.
    await typeInto(win, 'Auth', 'ev:bg-exit:b1:1\r');
    await expect(state).toHaveText('Exited 1', { timeout: 5000 });
    await expect(state).toHaveClass(/tone-error/);
    await expect(log).not.toContainText('[exited with code');
    // Exited, it counts no more, before the scan sees it go: the card says No, the header counts the agent alone.
    await expect(view.locator('.bgv-card', { hasText: 'Counts as work' })).toContainText(/^Counts as workNo$/);
    await expect(view.locator('.bgv-summary')).toHaveText('1 running');
    await win.mouse.move(5, 500);
    await look(win, join(SHOTS, 'tab-shell.png'));

    // The agent's timeline (its task, its first Read), then a new step live.
    await view.locator('.bgv-list .bgv-row', { hasText: 'Explore' }).click();
    await expect(view.locator('.bgv-task')).toHaveText('Map the refresh flow', { timeout: 10000 });
    const timeline = view.locator('.bgv-timeline');
    await expect(timeline).toContainText('src/auth/session.ts');
    await typeInto(win, 'Auth', 'ev:bg-agent-step:a1:refreshToken\r');
    await expect(timeline).toContainText('refreshToken', { timeout: 5000 });
    // The agent starts its own background shell: "Watch ›" on that step selects the shell, and the focus lands on its
    // row (never dropped on the page when the link unmounts with the detail).
    await typeInto(win, 'Auth', 'ev:bg-agent-bash:a1:b2:npm run lint -- --max-warnings=0\r');
    const watch = timeline.getByRole('button', { name: 'Watch' });
    await expect(watch).toBeVisible({ timeout: 5000 });
    // Its short result ("background") is never cut while the long command beside it can give way.
    const bash = timeline.locator('.bgv-tl-row', { hasText: 'Bash' });
    await expect(bash.locator('.bgv-tl-sum')).toHaveText('background');
    expect(await bash.locator('.bgv-tl-sum').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await win.mouse.move(5, 500);
    await look(win, join(SHOTS, 'tab-agent.png'));
    await watch.click();
    const lint = view.locator('.bgv-list [data-id="b2"]');
    await expect(lint).toHaveAttribute('aria-selected', 'true');
    await expect(lint).toBeFocused();
    await expect(view.locator('.bgv-head .bgv-name')).toHaveText('npm run lint -- --max-warnings=0');

    // The session ends (SessionEnd): a banner says so, and everything it ran stays listed as recent, the selection
    // kept; a recent shell's output is still followed (a line written after the end arrives) with its exit code.
    await typeInto(win, 'Auth', 'ev:session-end\r');
    await expect(view.locator('.bgv-banner')).toContainText('Session ended', { timeout: 10000 });
    const recentGroup = view.locator('.bgv-list [role="group"][aria-label="Recent"]');
    await expect(recentGroup.locator('.bgv-row')).toHaveCount(3);
    await expect(view.locator('.bgv-empty')).toHaveCount(0);
    await expect(lint).toHaveAttribute('aria-selected', 'true');
    await view.locator('.bgv-list [data-id="b1"]').click();
    await expect(view.locator('.bgv-head .bgv-name')).toHaveText('npm test -- auth');
    await expect(state).toHaveText('Exited 1');
    await expect(log).toContainText('focus-listener.test.ts (1 failed)', { timeout: 5000 });
    await typeInto(win, 'Auth', 'ev:bg-out:b1:written after the end\r');
    await expect(log).toContainText('written after the end', { timeout: 5000 });
    await expect(view.locator('.bgv-card', { hasText: 'Counts as work' })).toContainText('No');
    await win.mouse.move(5, 500);
    await look(win, join(SHOTS, 'session-ended.png'));
  } finally {
    await stop(l);
  }
});

test('a self-paced /loop: its task, the next check, why this pace and the checks; the detail stays on it across turns', async () => {
  test.setTimeout(90000);
  const l = await launch({ size: [2000, 1100] });
  const { app, win } = l;
  try {
    await session(win, 'Deploy');
    await events(win, 'Deploy', ['loop:240:w1']);
    await row(win, 'Deploy').locator('.row-main').click();
    // The chip: the loop's icon and words in its tooltip.
    const chip = win.locator('.session-bar .sched-chip');
    await expect(chip).toHaveClass(/is-loop/, { timeout: 10000 });
    await expect(chip).toHaveAttribute('data-tip', /^Self-paced loop · next check at \d\d:\d\d · check the preview deploy\nClick for details$/);
    await chip.click();
    const pop = win.getByRole('dialog', { name: 'Background' });
    const prow = pop.locator('.bgp-row');
    await expect(prow).toHaveCount(1);
    await expect(prow).toContainText('check the preview deploy');
    await expect(prow).toContainText('Self-paced loop · in');
    await prow.click();

    const view = win.locator('.bgv');
    const card = view.locator('.bgv-cron.is-open.bgv-loop');
    await expect(card).toBeVisible();
    await expect(card.locator('.bgv-loop-why')).toHaveText('The preview build takes a few minutes; nothing pushes its status to me.');
    await expect(card.locator('.bgv-loop-head')).toContainText(/Started \d\d:\d\d · 1 check$/);
    await expect(card.locator('.bgv-cron-next')).toHaveText(/^Next check at \d\d:\d\d$/);
    await expect(card.locator('.bgv-cron-pills')).toContainText('~4 min');
    await expect(card.locator('.bgv-cron-prompt')).toHaveText('/loop check the preview deploy');

    // The next turn: a new cron id, one more wake-up in the transcript; the open detail stays on the loop.
    await events(win, 'Deploy', ['loop:300:w2']);
    await expect(card.locator('.bgv-loop-head')).toContainText(/· 2 checks$/, { timeout: 10000 });
    await expect(card.locator('.bgv-loop-checks > li')).toHaveCount(2);
    await expect(card.locator('.bgv-cron-pills')).toContainText('~5 min');

    const width = () => view.evaluate((el) => el.getBoundingClientRect().width);
    await still(win);
    await win.mouse.move(5, 500);
    await look(win, join(SHOTS, 'loop-wide.png'));
    expect(await width()).toBeGreaterThanOrEqual(640);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 980));
    await expect.poll(width).toBeLessThan(640);
    await expect(card.locator('.bgv-loop-started')).toBeVisible();
    await look(win, join(SHOTS, 'loop-pills.png'));
    await menu(app, 'Split Right');
    await expect.poll(width).toBeLessThan(360);
    await expect(card.locator('.bgv-loop-reason').first()).toBeHidden();
    await expect(card.locator('.bgv-loop-started')).toBeVisible();
    expect(await view.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    await look(win, join(SHOTS, 'loop-narrow.png'));

    // A wake-up whose minute already passed while the session sits idle (a turn that ended without the next Stop):
    // never "tomorrow", it says the wake-up passed.
    await events(win, 'Deploy', ['loop:0:w3']);
    await expect(card.locator('.bgv-cron-next')).toHaveText('Wake-up passed', { timeout: 10000 });
    await expect(card.locator('.bgv-ring-t')).toHaveText('now');
    await expect(chip).toHaveAttribute('data-tip', /^Self-paced loop · wake-up passed · check the preview deploy\n/);

    // The loop ends: no crons left, the tab says nothing runs.
    await events(win, 'Deploy', ['loop-stop']);
    await expect(card).toHaveCount(0, { timeout: 10000 });
    await expect(chip).toHaveCount(0);
    await expect(view).toContainText('Nothing running in the background');
  } finally {
    await stop(l);
  }
});

test('narrow: pills keep the chosen one in view; three panes in a small window show one menu button and nothing overflows', async () => {
  test.setTimeout(90000);
  const l = await launch({ size: [1600, 980] });
  const { app, win } = l;
  try {
    await session(win, 'Auth');
    const shells = ['npm test -- auth --reporter=dot --coverage --watch=false', 'npm run lint', 'npm run typecheck', 'npm run e2e -- tests/e2e/terminal-tabs.spec.ts', 'npm run build:whisper', 'tail -f logs/server.log', 'npx vitest --watch', 'npm run dev -- --port 5173'];
    await events(win, 'Auth', shells.map((c, i) => `bg-shell:b${i + 1}:${c}`));
    await typeInto(win, 'Auth', `ev:bg-out:b1:${'x'.repeat(300)}\r`);
    await row(win, 'Auth').locator('.row-main').click();
    await expect(win.locator('.session-bar .work-chip')).toContainText('8 shells', { timeout: 10000 });
    // View › Background (⌘⌥B) opens it beside the session: two panes, the tab in the pills' width (360–639 px).
    await menu(app, 'Background');
    const view = win.locator('.bgv');
    await expect(view).toBeVisible();
    const width = () => view.evaluate((el) => el.getBoundingClientRect().width);
    await expect.poll(width).toBeLessThan(640);
    expect(await width()).toBeGreaterThanOrEqual(360);

    // Pills: a radio group; End selects the last pill, which stays inside the bounded pills box.
    const pills = view.locator('.bgv-pills');
    await expect(pills).toBeVisible();
    await expect(view.locator('.bgv-list')).toBeHidden();
    await expect(view.locator('.bgv-menu')).toBeHidden();
    await pills.locator('.bgv-pill').first().click();
    await win.keyboard.press('End');
    const last = pills.locator('.bgv-pill[data-id="b8"]');
    await expect(last).toHaveAttribute('aria-checked', 'true');
    await expect(last).toBeFocused();
    await expect(view.locator('.bgv-head .bgv-name')).toHaveText('npm run dev -- --port 5173');
    await expect.poll(() => inside(win, '.bgv-pill.is-on', '.bgv-pills-in')).toBe(true);
    await expect.poll(() => inside(win, '.bgv-pill.is-on', '.bgv-pills')).toBe(true);
    await still(win);
    await win.mouse.move(5, 500);
    await look(win, join(SHOTS, 'pills.png'));
    // Back to the first (Home), long output in it: still inside.
    await win.keyboard.press('Home');
    await expect(pills.locator('.bgv-pill[data-id="b1"]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => inside(win, '.bgv-pill.is-on', '.bgv-pills-in')).toBe(true);

    // Split Right: three panes, below 360 px: the picker is one menu button; the log never widens the pane. Then a
    // small window: three panes at their minimum share, still nothing overflows.
    await menu(app, 'Split Right');
    for (const [shot, size] of [['narrow-three-panes.png', null], ['narrow-small-window.png', [1000, 700]]] as const) {
      if (size) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w, h), size);
      await expect.poll(width).toBeLessThan(size ? 300 : 360);
      await expect(view.locator('.bgv-menu')).toBeVisible();
      await expect(view.locator('.bgv-pills')).toBeHidden();
      await expect(view.locator('.bgv-list')).toBeHidden();
      await expect(view.locator('.bgv-menu-btn')).toHaveAccessibleName('Choose an item: npm test -- auth --reporter=dot --coverage --watch=false');
      await expect(view.locator('.bgv-log')).toContainText('xxxxxxxx');
      // The meta cards: one column once the detail is 300 px or less, else two.
      const detailWidth = await view.locator('.bgv-detail').evaluate((el) => el.clientWidth);
      const lefts = await view.locator('.bgv-card').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(lefts).size).toBe(detailWidth <= 300 ? 1 : 2);
      // The filter is an icon button here; ⌘F reveals the field and focuses it, Esc clears it, then folds it back.
      const field = view.locator('.bgv-filter input');
      const filterBtn = view.locator('.bgv-filter-btn');
      await expect(field).toBeHidden();
      await expect(filterBtn).toBeVisible();
      await view.locator('.bgv-log').focus();
      await win.keyboard.press('Meta+f');
      await expect(field).toBeVisible();
      await expect(field).toBeFocused();
      await field.fill('xxxx');
      await expect(view.locator('.bgv-count')).toHaveText('1 of 1 line');
      expect(await view.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
      expect(await view.locator('.bgv-detail').evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
      await win.mouse.move(5, 500);
      await look(win, join(SHOTS, shot.replace('.png', '-filter.png')));
      await win.keyboard.press('Escape');
      await expect(field).toHaveValue('');
      await expect(field).toBeVisible();
      await win.keyboard.press('Escape');
      await expect(field).toBeHidden();
      await expect(filterBtn).toBeFocused();
      // The button itself opens it too.
      await filterBtn.click();
      await expect(field).toBeFocused();
      await win.keyboard.press('Escape');
      await expect(filterBtn).toBeFocused();
      expect(await view.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
      expect(await view.locator('.bgv-detail').evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
      // The header's search keeps its text inside its box (it used to wrap out of a 22 px box at 1000 px); squeezed, it
      // is an icon button, never narrower than one.
      expect(await win.evaluate(() => {
        const p = document.querySelector('.search-placeholder')!;
        const a = p.getBoundingClientRect();
        const b = document.querySelector('.search')!.getBoundingClientRect();
        const spills = p.getClientRects().length > 0 && (a.top < b.top - 0.5 || a.bottom > b.bottom + 0.5 || a.right > b.right + 0.5);
        return { spills, button: b.width >= 28 };
      })).toEqual({ spills: false, button: true });
      await win.mouse.move(5, 500);
      await look(win, join(SHOTS, shot));
    }
  } finally {
    await stop(l);
  }
});

test('a monitor without a command is watched by Claude Code (a neutral note, no output, no error card); an agent\'s long task is kept whole, clamped with "Show more"', async () => {
  test.setTimeout(90000);
  const l = await launch({ size: [2000, 1100] });
  const { win } = l;
  try {
    await session(win, 'Auth');
    await typeInto(win, 'Auth', 'ev:bg-watch:w1:live updates for artifact abc\r');
    await expect(row(win, 'Auth').locator('.work-chip')).toBeVisible({ timeout: 10000 });
    await row(win, 'Auth').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Show Background' }).click();
    const view = win.locator('.bgv');
    await expect(view.locator('.bgv-head .bgv-name')).toHaveText('live updates for artifact abc');
    const note = view.locator('.bgv-watched');
    await expect(note).toContainText('Watched by Claude Code');
    await expect(note).toContainText('its events reach Claude as notifications');
    await expect(view.locator('.bgv-log')).toHaveCount(0);
    await expect(view.locator('.bgv-unavailable')).toHaveCount(0);
    // Nothing is followed, so nothing can turn into an error card either.
    await expect.poll(() => view.locator('.bgv-unavailable').count(), { timeout: 2000 }).toBe(0);
    await still(win);
    await win.mouse.move(5, 500);
    await look(win, resolve('e2e-shots/background-inspector/watcher-note.png'));

    // An agent with a long task, beside the monitor.
    await events(win, 'Auth', ['bg-agent-long:a2']);
    await view.locator('.bgv-list .bgv-row', { hasText: 'Explore' }).click();
    const task = view.locator('.bgv-task');
    await expect(task).toContainText('1. Check the refresh path', { timeout: 10000 });
    const more = view.getByRole('button', { name: 'Show more' });
    await expect(more).toBeVisible();
    // Clamped: the last line is cut off (its text is in the DOM, but below the clamp).
    const hidden = () => task.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const last = [...r.getClientRects()].pop()!; return last.bottom > el.getBoundingClientRect().bottom + 1 || el.scrollHeight > el.clientHeight + 1; });
    expect(await hidden()).toBe(true);
    await more.click();
    await expect(view.getByRole('button', { name: 'Show less' })).toBeVisible();
    await expect(task).toContainText('LAST LINE: done');
    expect(await task.evaluate((el) => (el.textContent ?? '').split('\n').length)).toBe(15);
    expect(await task.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    expect(await task.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop + el.clientHeight >= el.scrollHeight - 1; })).toBe(true);
    await win.mouse.move(5, 500);
    await look(win, resolve('e2e-shots/background-inspector/agent-task-full.png'));
    await view.getByRole('button', { name: 'Show less' }).click();
    expect(await hidden()).toBe(true);
  } finally {
    await stop(l);
  }
});

test('an output that never appears says so; a window of another project cannot follow this project\'s items', async () => {
  test.setTimeout(120000);
  const other = mkdtempSync(join(tmpdir(), 'atl-prj-other-'));
  // A missing output is given up on after 1 s here (10 s in the app).
  const l = await launch({ recent: [other], extra: { ATELIER_TEST_BG_MISSING_MS: '1000' } });
  const { app, win } = l;
  try {
    await session(win, 'Auth');
    // A shell whose output file Claude Code never writes.
    await typeInto(win, 'Auth', 'ev:bg-shell:b9:npm run nothing\r');
    await expect(row(win, 'Auth').locator('.work-chip')).toBeVisible({ timeout: 10000 });
    // The row's context menu (the keyboard path to the sidebar chip's popover) opens the tab beside.
    await row(win, 'Auth').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Show Background' }).click();
    const view = win.locator('.bgv');
    await expect(view.locator('.bgv-head .bgv-name')).toHaveText('npm run nothing');
    // Missing files are retried for a while, then the card says so.
    const card = view.locator('.bgv-unavailable');
    await expect(card).toContainText('Output not available', { timeout: 10000 });
    await expect(card).toContainText("Claude Code didn't leave an output file where Atelier expects it.");
    await still(win);
    await win.mouse.move(5, 500);
    await look(win, join(SHOTS, 'unavailable.png'));

    // This window may follow its own project's item…
    const id = await terminalId(win, 'Auth');
    expect(await watchFrom(win, id, 'b9')).toEqual({ ok: true });
    // …a window of another project may not, though it names the terminal and the item.
    const [welcome] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click())]);
    const recent = welcome.getByRole('button', { name: new RegExp(basename(other)) });
    await expect(recent).toBeVisible();
    const [second] = await Promise.all([app.waitForEvent('window'), recent.click()]);
    await expect(second.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    expect(await termCount(second)).toBe(0);
    expect(await watchFrom(second, id, 'b9')).toEqual({ ok: false, reason: 'missing' });
  } finally {
    await stop(l);
  }
});

test('the popover opens on the real elapsed time, never a stale "1 s" before the first tick', async () => {
  test.setTimeout(60000);
  const l = await launch();
  const { win } = l;
  try {
    await session(win, 'Clock');
    await events(win, 'Clock', ['bg-agent:a1']);
    await row(win, 'Clock').locator('.row-main').click();
    const chip = win.locator('.session-bar .work-chip');
    await expect(chip).toContainText('1 agent', { timeout: 10000 });
    await win.waitForTimeout(2000);
    // Every text the time shows, from the frame it appears: the first one is what the user sees on opening.
    await win.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => {
        const el = document.querySelector('.bgp-time');
        const text = el?.textContent ?? '';
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await chip.click();
    await expect(win.getByRole('dialog', { name: 'Background' })).toBeVisible();
    const seen = await win.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.length).toBeGreaterThan(0);
    expect(Number(/^(\d+) s$/.exec(seen[0]!)?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
  } finally {
    await stop(l);
  }
});
