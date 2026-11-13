import { expect, test, type BrowserContext, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The REAL live demo, end to end: the built site with the demo the
// build put in dist/demo-app/, no stub. live-demo.spec.ts covers the page's side with a stub; this file covers what the
// visitor does inside: keyboard ownership, the beats, Changes, Docker, Redis, the checklist, the ways out, the direct
// link, a demo that cannot start, the network and the console, and the pause.
//
// The demo's world runs on its own clock (src/demo/engine/clock.ts): the beats take seconds, the worker crashes 20 s
// in. Timeouts below are generous on purpose; nothing waits a fixed time where a condition can be polled.

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
/** Screenshots worth looking at (git-ignored): the header with an unread pill, the checklist, a guided item's result. */
const SHOTS = fileURLToPath(new URL('../../../e2e-shots/live-demo/polish', import.meta.url));

/** Watches a page from before its first script, in every frame: errors (thrown, unhandled, CSP violations) and, on the
 *  top page, the demo's messages. */
const WATCH = () => {
  const w = window as unknown as { __errors: string[]; __demoMsgs: { type: string; done?: number; total?: number }[] };
  w.__errors = [];
  addEventListener('error', (e) => w.__errors.push(`error: ${e.message}`));
  addEventListener('unhandledrejection', (e) => w.__errors.push(`rejection: ${String((e.reason as Error | undefined)?.message ?? e.reason)}`));
  // A CSP violation is a browser log entry, not a console call: Playwright's console event never sees it (Lighthouse's
  // Best Practices does, as an Issue). Even a caught one counts (a library probing for eval).
  document.addEventListener('securitypolicyviolation', (e) => w.__errors.push(`csp: ${e.effectiveDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`));
  if (window.top === window) {
    w.__demoMsgs = [];
    addEventListener('message', (e) => {
      const d = e.data as { source?: string; type?: string } | null;
      if (d && d.source === 'atelier-demo' && typeof d.type === 'string') w.__demoMsgs.push(d as { type: string });
    });
  }
};

/** Warnings a browser logs about timing, not about the page: WebKit only, under load. Errors always count. */
const BENIGN_WARNINGS = [
  // WebKit: a preloaded font the page had not drawn yet when its few-seconds heuristic looked (the page sits under
  // the open demo).
  /was preloaded using link preload but not used within a few seconds/,
  // WebKit: a requestIdleCallback task ran past its deadline (React's scheduler, a busy machine).
  /^task queue exceeded allotted deadline by \d+ms$/
];

interface Watch { console: string[]; requests: { url: string; method: string; frame: string }[] }
async function watch(page: Page): Promise<Watch> {
  const w: Watch = { console: [], requests: [] };
  await page.addInitScript(WATCH);
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || (t === 'warning' && !BENIGN_WARNINGS.some((b) => b.test(m.text())))) w.console.push(`[${t}] ${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => w.console.push(`[pageerror] ${e.message}`));
  page.on('request', (r) => w.requests.push({ url: r.url(), method: r.method(), frame: r.frame().url() }));
  return w;
}

const stage = (page: Page) => page.locator('.demo-stage');
const app = (page: Page): FrameLocator => page.frameLocator('.demo-stage iframe');
const demoFrame = (page: Page): Frame => page.frame({ url: /\/demo-app\// })!;
const messages = (page: Page) => page.evaluate(() => (window as unknown as { __demoMsgs: { type: string; done?: number; total?: number }[] }).__demoMsgs);
const frameErrors = async (page: Page) => [
  ...await page.evaluate(() => (window as unknown as { __errors: string[] }).__errors),
  ...(demoFrame(page) ? await demoFrame(page).evaluate(() => (window as unknown as { __errors?: string[] }).__errors ?? []) : [])
];
const selected = (page: Page) => app(page).locator('.session-row.is-selected');
const row = (page: Page, name: string) => app(page).locator('.session-row', { hasText: name });

/** What the terminals print, as the renderer receives it (xterm draws with WebGL: its DOM has no text), styles dropped. */
async function recordOutput(page: Page) {
  await demoFrame(page).evaluate(() => {
    const w = window as unknown as { __out: string; atelier: { on: { data(cb: (id: string, d: string) => void): void } } };
    w.__out = '';
    w.atelier.on.data((_id, d) => { w.__out += d; });
  });
}
const output = (page: Page) => demoFrame(page).evaluate(() => (window as unknown as { __out: string }).__out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));

async function openFromHero(page: Page) {
  await page.goto('/');
  await expect(page.locator('.hero [data-live-demo][data-armed]')).toBeAttached();
  await page.locator('.hero .demo-hit').click();
  await isOpen(page);
}
async function isOpen(page: Page) {
  await expect(stage(page)).toHaveClass(/is-ready/, { timeout: 15000 });
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
  await expect(page.locator('header.appbar')).toBeHidden();
  await expect.poll(async () => (await messages(page)).map((m) => m.type)).toContain('ready');
  // The real app is on screen inside the frame: its sessions, the demo's menu bar.
  await expect(app(page).locator('.workspace')).toBeVisible();
  await expect(app(page).getByText('Live demo · scripted sessions')).toBeVisible();
  // The focus is the demo's (the coach mark is dismissed by the first key anyway).
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
}
async function isClosed(page: Page) {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo');
  await expect(stage(page)).toBeHidden();
  await expect(page.locator('header.appbar')).toBeVisible();
  await expect(page.locator('.hero .frame')).toBeVisible();
}
/** Focus forced onto the page (a click on the dimmed edge would do it). */
async function blurDemo(page: Page) {
  await stage(page).locator('iframe').evaluate((f) => (f as HTMLIFrameElement).blur());
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
}

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90000 });

test.describe('the real demo', () => {
  test('opens from the hero; ⌘K is the app\'s palette, never the site\'s search, even with the focus on the page', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const palette = app(page).locator('.palette');
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await expect(page.locator('dialog.search-sheet')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    // Focus forced onto the parent page: the key goes back into the demo.
    await blurDemo(page);
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await expect(page.locator('dialog.search-sheet')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    await page.keyboard.press('Escape');
    // "/" from the page is the app's too: it never opens the site's search.
    await blurDemo(page);
    await page.keyboard.press('/');
    await expect(page.locator('dialog.search-sheet')).toBeHidden();
    expect(w.console).toEqual([]);
  });

  test('off a Mac, Ctrl+K is ⌘K', async ({ browser }) => {
    const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // A Windows visitor, in every frame (the demo reads its own navigator).
    await ctx.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', configurable: true });
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'Windows', brands: [], mobile: false }), configurable: true });
    });
    const page = await ctx.newPage();
    await page.addInitScript(WATCH);
    await openFromHero(page);
    const palette = app(page).locator('.palette');
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await blurDemo(page);
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await expect(page.locator('dialog.search-sheet')).toBeHidden();
    await ctx.close();
  });

  test('⌘J goes to the session waiting; answering makes it work, then done; Changes lists its edit; the checklist ticks', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const count = app(page).locator('.dm-check-count');
    await expect(count).toHaveText('0/13');
    await page.keyboard.press('Meta+j');
    await expect(selected(page)).toContainText('db-migration');
    await expect(selected(page)).toHaveClass(/state-waiting/);
    await expect(count).toHaveText('1/13');
    await expect(app(page).locator('.dm-check-item[data-item="jump"]')).toHaveClass(/is-done/);
    // Changes has no schema yet.
    const changes = app(page).locator('aside.changes');
    await expect(changes).toBeVisible();
    await expect(changes).not.toContainText('schema.prisma');
    await page.keyboard.press('1');
    await expect(row(page, 'db-migration')).toHaveClass(/state-running/, { timeout: 10000 });
    await expect(app(page).locator('.dm-check-item[data-item="approve"]')).toHaveClass(/is-done/);
    await expect(count).toHaveText('2/13');
    await expect(row(page, 'db-migration')).toHaveClass(/state-done/, { timeout: 45000 });
    await expect(changes).toContainText('schema.prisma');
    await expect(changes).toContainText('migration.sql');
    // Attributed to it: Changes by session puts both under db-migration.
    //
    await changes.getByRole('button', { name: /^Filters/ }).click();
    await changes.getByRole('dialog', { name: 'Filters' }).getByRole('radio', { name: 'Session' }).click();
    await page.keyboard.press('Escape');
    await expect(changes.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);
    // The group's header ("db-migration · 2 files"), then its files, before the next group's header.
    await expect(changes.locator('.changes-body')).toContainText(/db-migration\s*2 files(?:(?!\d+ files?)[\s\S])*migration\.sql(?:(?!\d+ files?)[\s\S])*schema\.prisma/);
    // ⌘⇧M ticks "See what it changed"; every tick reached the page.
    await page.keyboard.press('Meta+Shift+m');
    await expect(count).toHaveText('3/13');
    await expect.poll(async () => (await messages(page)).filter((m) => m.type === 'checklist').map((m) => `${m.done}/${m.total}`)).toEqual(['1/13', '2/13', '3/13']);
    expect(w.console).toEqual([]);
  });

  // Ask in the demo: the real panel, the companion played from its script.
  test('Ask: ⌘I opens it on the session in front, on its empty state; Catch me up, then a chip that streams a verdict and a file chip that opens the file; the item ticks', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const item = app(page).locator('.dm-check-item[data-item="ask"]');
    await expect(item.locator('button')).toHaveText('⌘I: ask a session where it is');
    await expect(item).not.toHaveClass(/is-done/);
    // auth-refactor is in front at startup (the overview's scene), waiting on its test run.
    await expect(selected(page)).toContainText('auth-refactor');
    await page.keyboard.press('Meta+i');
    const panel = app(page).getByRole('complementary', { name: 'Ask about auth-refactor' });
    await expect(panel).toBeVisible();
    // Catch me up when opened is off by default, as in the app: the empty state, its button and the starters; opening
    // alone ticks nothing.
    const empty = panel.locator('.ask-empty');
    await expect(empty.getByRole('group', { name: 'Suggested questions' }).getByRole('button')).toHaveText(['What is it doing?', 'How far along is it?', 'Explain its plan']);
    await expect(item).not.toHaveClass(/is-done/);
    // The list makes way at once (companion.thread): it never covers the empty state's button or the composer.
    const check = app(page).locator('.dm-check');
    const clear = async () => {
      const [list, ask] = [await check.boundingBox(), await panel.boundingBox()];
      return !!list && !!ask && list.x + list.width <= ask.x;
    };
    await expect.poll(clear).toBe(true);
    await expect(empty.getByRole('button', { name: 'Catch me up' })).toBeVisible();
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'ask-empty.png') });
    // Catch me up: reading first, then the card (the needs-you card above it: the session waits).
    await empty.getByRole('button', { name: 'Catch me up' }).click();
    await expect(panel.locator('.ask-catching')).toBeVisible();
    await expect(panel.locator('.ask-needs')).toContainText('auth-refactor needs permission');
    const card = panel.locator('.ask-card');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator('.ask-pt')).toHaveText([/Move sessions to the token store/, /Check it with the auth tests.*Waiting for your OK to run npm test -- auth/]);
    await expect(card.locator('.ask-pt.is-in_progress .ask-pt-tm')).toHaveText('now');
    await expect(card).toContainText('Where it is');
    await expect(card.locator('.ask-src')).toContainText('From the chat and 2 files');
    await expect(item).toHaveClass(/is-done/);
    // The list stays out of the way: it never covers the panel's composer.
    expect(await clear()).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'ask-catch-up.png') });
    const chips = panel.locator('.ask-sugg .ask-sg');
    await expect(chips).toHaveText(["What's left?", 'Why 30 s of clock skew when a session expires?', 'How does readSession work?']);
    await chips.first().click();
    // It streams: what it reads, then the verdict as a chip and the words with a caret.
    const live = panel.locator('.ask-ans.is-live');
    await expect(live.locator('.ask-trace-row').first()).toHaveText(/Read(ing)? the chat/);
    await expect(live.locator('.ask-verdict')).toBeVisible({ timeout: 10000 });
    await expect(live.locator('.ask-caret')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'ask-streaming.png') });
    const answer = panel.locator('.ask-item[data-kind="answer"]');
    await expect(answer).toHaveCount(1, { timeout: 20000 });
    await expect(answer.locator('.ask-ans-hd')).toHaveText('Ask · Sonnet · read 1 file');
    await expect(answer.locator('.ask-verdict')).toHaveText('In progress: Waiting for your OK · 1/2');
    await expect(answer.locator('.ask-verdict .ask-meter i.on')).toHaveCount(1);
    await answer.getByRole('button', { name: /^Detail/ }).click();
    await expect(answer.locator('.ask-detail-bd')).toContainText('30 s before it expires');
    await page.screenshot({ path: join(SHOTS, 'ask-answer.png') });
    // The file chip opens the file in the editor, at its line.
    const chip = answer.getByRole('button', { name: 'src/auth/session.ts:11–19' });
    await expect(chip).toHaveText('session.ts:11–19');
    await chip.click();
    await expect(app(page).locator('.file-view:visible .cm-activeLine')).toContainText('export function readSession', { timeout: 10000 });
    expect(w.console).toEqual([]);
  });

  test('Ask: its "show me" opens it on a session at work, on its empty state; a question the script doesn\'t know gets the honest line and ticks the item', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const item = app(page).locator('.dm-check-item[data-item="ask"]');
    await item.locator('button').click();
    await expect(app(page).locator('.dm-toast')).toContainText('Press Catch me up, or try a suggested question.');
    await expect(selected(page)).toContainText('billing-tests');
    const panel = app(page).getByRole('complementary', { name: 'Ask about billing-tests' });
    // Catch me up when opened is off by default, as in the app: its button and the starters, nothing ticked yet.
    const empty = panel.locator('.ask-empty');
    await expect(empty.getByRole('button', { name: 'Catch me up' })).toBeVisible({ timeout: 10000 });
    await expect(empty.getByRole('group', { name: 'Suggested questions' }).getByRole('button')).toHaveText(['What is it doing?', 'How far along is it?', 'Explain its plan']);
    await expect(item).not.toHaveClass(/is-done/);
    // A second click keeps it open (⌘I would close it): the shell decides two frames after the click.
    await item.locator('button').click();
    await demoFrame(page).evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
    await expect(panel).toBeVisible();
    const composer = panel.getByRole('textbox', { name: /Ask/ });
    await composer.fill('Is the checkout secure?');
    await composer.press('Enter');
    await expect(panel.locator('.ask-item[data-kind="answer"]')).toContainText("In this demo Ask answers from a script; in Atelier it reads the session's chat and code, read-only.", { timeout: 15000 });
    await expect(item).toHaveClass(/is-done/);
    expect(w.console).toEqual([]);
  });

  test('the Ask row\'s Try it: Ask on the session at work, on its empty state; its Catch me up plays that session\'s card', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/features');
    const rowEl = page.locator('#ask');
    await rowEl.scrollIntoViewIfNeeded();
    await expect(rowEl.locator('[data-live-demo][data-armed]')).toBeAttached();
    await rowEl.locator('.try-live').click();
    await isOpen(page);
    await expect(selected(page)).toContainText('billing-tests');
    const panel = app(page).getByRole('complementary', { name: 'Ask about billing-tests' });
    const catchUp = panel.locator('.ask-empty').getByRole('button', { name: 'Catch me up' });
    await expect(catchUp).toBeVisible({ timeout: 10000 });
    await catchUp.click();
    await expect(panel.locator('.ask-card .ask-pt')).toHaveText([/Cover rounding/, /Cover currencies/], { timeout: 10000 });
    await expect(app(page).locator('.dm-check-item[data-item="ask"]')).toHaveClass(/is-done/);
    expect(w.console).toEqual([]);
  });

  // Git writes in the demo: staging and ✦ are live in the fictional repository; a commit never happens, it asks to
  // download (the shell's notice), and the app stays quiet (no error toast, the drawer as it was).
  test("Git: stage auth-refactor's file, ✦ writes its commit; Commit asks to download and commits nothing; the item ticks", async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const check = app(page).locator('.dm-check');
    // Changes shows at startup: the list floats just above its commit bar, never over it (nor over the workspace).
    const bar = app(page).locator('aside.changes .git-bar');
    await expect(bar).toContainText('nothing staged');
    await expect.poll(async () => {
      const [list, under] = [await check.boundingBox(), await bar.boundingBox()];
      return !!list && !!under && list.y + list.height <= under.y;
    }).toBe(true);
    // The item's "show me": Changes with the drawer open, and what to do there.
    await check.locator('.dm-check-item[data-item="commit"] button').click();
    await expect(app(page).locator('.dm-toast')).toContainText('Tick a file to stage it');
    const changes = app(page).locator('aside.changes');
    const drawer = changes.locator('.git-drawer');
    await expect(drawer).toBeVisible();
    // The list makes way: it sits left of the panel, never over the commit bar, ✦ or Commit.
    await expect.poll(async () => {
      const [list, panel] = [await check.boundingBox(), await changes.boundingBox()];
      return !!list && !!panel && list.x + list.width <= panel.x;
    }).toBe(true);
    const box = changes.getByRole('checkbox', { name: 'Stage session.ts' });
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await expect(drawer.locator('.git-commit-main')).toHaveAttribute('aria-disabled', 'true');
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await expect(drawer.locator('.git-chip')).toContainText('acme-store');
    await expect(drawer.locator('.git-commit-main')).toContainText('Commit 1 file');
    // ✦: the canned message for auth-refactor's work streams into the field.
    const field = drawer.getByRole('textbox', { name: 'Commit message' });
    await drawer.locator('.git-sparkle').click();
    await expect(field).toHaveValue(/^refactor\(auth\): read sessions through the token store\n\n/, { timeout: 10000 });
    await expect(check.locator('.dm-check-item[data-item="commit"]')).toHaveClass(/is-done/);
    await mkdir(SHOTS, { recursive: true });
    await changes.screenshot({ path: join(SHOTS, 'git-drawer.png') });
    // Commit: the download notice; nothing committed, nothing failed.
    await drawer.locator('.git-commit-main').click();
    await expect(app(page).locator('.dm-toast')).toContainText('This one runs on your Mac.');
    await expect(app(page).locator('.dm-toast')).toContainText('Download Atelier');
    await expect(drawer).toBeVisible();
    await expect(field).toHaveValue(/^refactor\(auth\): /);
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await expect(changes.locator('.git-bar.is-failed, .git-oplog.is-failed, .git-notice.is-result')).toHaveCount(0);
    await expect(app(page).locator('.toast')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'git-commit-download.png') });
    expect(w.console).toEqual([]);
  });

  // Context usage in the demo: fictional numbers, the setup the same for every
  // session, the conversation as large as the session's status line (auth-refactor: 41 % of Opus 5.5's 1M).
  test('Context usage: the Session panel\'s Context tile analyses auth-refactor on fictional numbers; its files open only on the Mac', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    await row(page, 'auth-refactor').click();
    await app(page).locator('.session-bar .sb-model').click();
    await app(page).getByRole('dialog', { name: /^Session: / }).getByRole('button', { name: /Context/ }).click();
    const sheet = app(page).getByRole('dialog', { name: 'Context: auth-refactor' });
    await expect(sheet).toBeVisible();
    // The analysis takes a moment, its steps shown, then the report.
    await expect(sheet.locator('.cxu-steps')).toBeVisible();
    await expect(sheet.locator('.cxu-when')).toHaveText('Analyzed just now', { timeout: 15000 });
    await expect(sheet.locator('.cxu-tile').first()).toContainText('410k');
    await expect(sheet.locator('.cxu-tile').first()).toContainText('41%');
    await expect(sheet.locator('.cxu-tile').nth(1)).toContainText('67k');
    await expect(sheet.locator('.cxu-arc')).toHaveCount(5);
    const groups = sheet.getByRole('listbox', { name: 'Groups' }).getByRole('option');
    await expect(groups).toHaveText([/^Messages\s*343k/, /^System\s*31\.4k/, /^MCP servers\s*23k/, /^Skills\s*6\.7k/, /^Memory files\s*5\.9k/]);
    // MCP servers first, the heaviest open: what is in the context, what waits outside, the one that failed.
    await expect(sheet.getByRole('option', { name: /MCP servers/ })).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.getByRole('button', { name: /acme-docs/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet.locator('.cxu-tools').first()).toContainText('get_page');
    await expect(sheet.locator('.cxu-tools').first()).toContainText('2 tools waiting outside the context');
    await expect(sheet.locator('.cxu-offline')).toHaveText('1 server not connected · cost nothing');
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'context-usage.png') });
    // Its files are the fictional user's, on their Mac: the demo says so and the sheet stays.
    await sheet.getByRole('option', { name: /Memory files/ }).click();
    await sheet.getByRole('button', { name: /^Open .*CLAUDE\.md$/ }).first().click();
    const toast = app(page).locator('.dm-toast');
    await expect(toast).toContainText('This one runs on your Mac.');
    await expect(toast).toBeVisible();
    await expect(sheet).toBeVisible();
    await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: join(SHOTS, 'context-usage-memory.png') });
    expect(w.console).toEqual([]);
    expect(await frameErrors(page)).toEqual([]);
  });

  test('Esc while Claude works interrupts it, as in Claude Code; it never leaves the demo', async ({ page }) => {
    await watch(page);
    await openFromHero(page);
    await recordOutput(page);
    await page.keyboard.press('Meta+j');
    await page.keyboard.press('Meta+j');
    await expect(selected(page)).toContainText('auth-refactor');
    await page.keyboard.press('1');
    await expect(row(page, 'auth-refactor')).toHaveClass(/state-running/, { timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect.poll(() => output(page)).toContain('Interrupted by user');
    await expect(row(page, 'auth-refactor')).toHaveClass(/state-idle/);
    await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
  });

  test('Docker: the worker crashes about 20 s in, with its stack; the logs stream', async ({ page }) => {
    await watch(page);
    await openFromHero(page);
    await page.keyboard.press('Control+Shift+d');
    const side = app(page).locator('.sidebar.is-docker');
    await expect(side).toBeVisible();
    await side.getByText('api', { exact: true }).click();
    const lines = app(page).locator('.dk-logs .dk-ln');
    await expect(lines.first()).toBeVisible();
    // Streaming: the last line changes, more than once.
    const last = async () => (await lines.last().getAttribute('data-key')) ?? '';
    const seen = new Set<string>([await last()]);
    await expect.poll(async () => { seen.add(await last()); return seen.size; }, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    await side.getByText('worker', { exact: true }).click();
    await expect(app(page).locator('.dk-logs')).toContainText('ECONNREFUSED 127.0.0.1:6379', { timeout: 40000 });
    await expect(app(page).locator('.dk-logs')).toContainText('at TCPConnectWrap.afterConnect');
    // Then it stays down: exited 1 after its restarts.
    await expect(app(page).locator('.workspace')).toContainText(/Exited|exited/, { timeout: 40000 });
  });

  test('Automations: the store\'s two rules and their runs; the one working is billing-tests, which says who started it', async ({ page }) => {
    await watch(page);
    await openFromHero(page);
    await app(page).locator('.activity-bar button[aria-label^="Automations"]').click();
    const side = app(page).locator('.au-side');
    await expect(side).toContainText('Bug fixes from the sprint');
    await expect(side).toContainText('Docs pages from Notion');
    const main = app(page).locator('.au-view');
    await expect(main).toContainText('ENG-142');
    await expect(main).toContainText('ENG-139');
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'automations-view.png') });
    await app(page).locator('.activity-bar button[aria-label^="Sessions"]').click();
    await row(page, 'billing-tests').click();
    const strip = app(page).locator('.au-strip');
    await expect(strip).toContainText('Bug fixes from the sprint');
    await expect(strip).toContainText('ClickUp ENG-142');
    await page.screenshot({ path: join(SHOTS, 'automations-strip.png') });
    expect(await frameErrors(page)).toEqual([]);
  });

  // In-app confirms: the app's own question, played by the real renderer.
  test('closing a session asks in its row: Esc keeps it, Close closes it; nothing native, nothing in the console', async ({ page }) => {
    await watch(page);
    await openFromHero(page);
    const session = row(page, 'onboarding-copy');
    await session.hover();
    await session.locator('.row-close').click();
    const asking = app(page).locator('.session-row.is-confirming');
    await expect(asking).toContainText('Close onboarding-copy?');
    await expect(asking).toContainText('Resume it later from');
    await mkdir(SHOTS, { recursive: true });
    await page.waitForTimeout(400); // the row's unfold
    await page.screenshot({ path: join(SHOTS, 'close-confirm.png') });
    await page.keyboard.press('Escape');
    await expect(asking).toHaveCount(0);
    await expect(row(page, 'onboarding-copy')).toHaveCount(1);
    await session.hover();
    await session.locator('.row-close').click();
    await asking.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(row(page, 'onboarding-copy')).toHaveCount(0);
    expect(await frameErrors(page)).toEqual([]);
  });

  // "Things to try" is a guided list: every item is a "show me" button; the usual detection ticks it.
  test('Things to try: a click shows each thing; search opens the palette, focused; Docker brings the worker\'s crash forward', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const check = app(page).locator('.dm-check');
    await expect(check.locator('.dm-check-hint')).toHaveText('Click one to see it.');
    const item = (id: string) => check.locator(`.dm-check-item[data-item="${id}"] button`);
    await expect(item('docker')).toHaveText('Docker (⌃⇧D): see why worker stopped');
    await item('redis').hover();
    await mkdir(SHOTS, { recursive: true });
    await check.screenshot({ path: join(SHOTS, 'checklist-hover.png') });
    // Search: the app's palette, with the keyboard in it (never on the item).
    await item('search').click();
    const palette = app(page).locator('.palette');
    await expect(palette).toBeVisible();
    await expect.poll(() => demoFrame(page).evaluate(() => !!document.activeElement?.closest('.palette'))).toBe(true);
    await expect(check.locator('.dm-check-item[data-item="search"]')).toHaveClass(/is-done/);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    // Docker, a few seconds in: the worker still runs. Its Inspect opens and the crash plays now, not 20 s in.
    const clicked = Date.now();
    await item('docker').click();
    await expect(app(page).locator('.dm-toast')).toContainText('The worker is about to stop');
    await expect(app(page).locator('.sidebar.is-docker')).toBeVisible();
    const why = app(page).locator('.dk-why');
    await expect(why).toContainText('Why it stopped', { timeout: 15000 });
    await expect(why).toContainText('ECONNREFUSED 127.0.0.1:6379');
    expect(Date.now() - clicked).toBeLessThan(15000);
    await expect(check.locator('.dm-check-item[data-item="docker"]')).toHaveClass(/is-done/);
    await app(page).locator('.dk-inspect').screenshot({ path: join(SHOTS, 'docker-item-why.png') });
    expect(w.console).toEqual([]);
  });

  // Workspaces: off as in the
  // app; the item turns them on with the world's four fronts; a workspace's name brings its session forward and ticks
  // it; Go lists them with the one in front checked.
  test('Things to try: the workspaces item turns them on, four fronts; Billing\'s name brings billing-tests forward and ticks; Go checks it', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    await expect(app(page).locator('.ws-head')).toHaveCount(0);
    const check = app(page).locator('.dm-check');
    const item = check.locator('.dm-check-item[data-item="workspaces"]');
    await expect(item.locator('button')).toHaveText('Turn on workspaces (View), then switch to Billing');
    await item.locator('button').click();
    const front = app(page).locator('.ws-group.is-active .ws-head');
    await expect(front).toContainText('Auth & sessions');
    await expect(app(page).locator('.ws-group:not(.is-active) .ws-name')).toHaveText(['Billing', 'DB migration', 'Docs & copy']);
    await expect(app(page).locator('.dm-toast')).toContainText('Billing');
    await expect(item).not.toHaveClass(/is-done/);
    await app(page).locator('.ws-group', { has: app(page).locator('.ws-name', { hasText: /^Billing$/ }) }).locator('.ws-name-btn').click();
    await expect(front).toContainText('Billing');
    await expect(app(page).locator('.ws-group.is-active').locator('.session-row', { hasText: 'billing-tests' })).toBeVisible();
    // Auth & sessions, left behind, stays open (revised 2026-11-08): only a chevron folds it.
    const auth = app(page).locator('.ws-group:not(.is-active)', { has: app(page).locator('.ws-name', { hasText: /^Auth & sessions$/ }) });
    await expect(auth.locator('.session-row', { hasText: 'auth-refactor' })).toBeVisible();
    await expect(auth.locator('.ws-chev')).toHaveAttribute('aria-expanded', 'true');
    await expect(item).toHaveClass(/is-done/);
    await app(page).locator('.dm-title', { hasText: 'Go' }).click();
    await expect(app(page).getByRole('menuitemradio', { name: 'Billing' })).toHaveAttribute('aria-checked', 'true');
    await expect(app(page).getByRole('menuitemradio', { name: 'Auth & sessions' })).toHaveAttribute('aria-checked', 'false');
    await mkdir(SHOTS, { recursive: true });
    await app(page).locator('.dm-menu').screenshot({ path: join(SHOTS, 'workspaces-go-menu.png') });
    await page.keyboard.press('Escape');
    await app(page).locator('.sidebar').screenshot({ path: join(SHOTS, 'workspaces-sidebar.png') });
    expect(w.console).toEqual([]);
  });

  test('Things to try: after the worker\'s crash, the Docker item opens its "Why it stopped" and ticks', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const worker = () => demoFrame(page).evaluate(async () => (await (window as unknown as { atelier: { docker: { snapshot(): Promise<{ containers: { name: string; state: string }[] }> } } })
      .atelier.docker.snapshot()).containers.find((c) => c.name === 'worker')?.state);
    await expect.poll(worker, { timeout: 45000 }).toBe('exited');
    const docker = app(page).locator('.dm-check-item[data-item="docker"]');
    await expect(docker).not.toHaveClass(/is-done/);
    await docker.locator('button').click();
    await expect(app(page).locator('.dk-why')).toContainText('Why it stopped');
    await expect(app(page).locator('.dk-why')).toContainText('ECONNREFUSED 127.0.0.1:6379');
    await expect(docker).toHaveClass(/is-done/);
    // No "about to stop" here: it has.
    await expect(app(page).locator('.dm-toast')).not.toContainText('about to stop');
    expect(w.console).toEqual([]);
  });

  // JSON navigation: the real renderer's tree, parsed in its worker, in the browser.
  test('Things to try: the JSON item opens package.json with its tree beside it and ticks; a second click keeps it', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const json = app(page).locator('.dm-check-item[data-item="json"]');
    await expect(json.locator('button')).toHaveText('Open package.json as a tree (⇧⌘V)');
    await json.locator('button').click();
    const tree = app(page).locator('.json-tree');
    await expect(tree).toBeVisible();
    await expect(tree.locator('.jt-row', { hasText: 'scripts' })).toBeVisible();
    await expect(json).toHaveClass(/is-done/);
    await json.locator('button').click();
    await expect(tree).toBeVisible();
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'json-tree.png') });
    expect(w.console).toEqual([]);
  });

  // Background is worth opening the whole visit: the demo starts on sessions with none, and billing-tests' agents and
  // vitest run end about 50 s in; its test watcher keeps running after.
  test('Things to try: a minute in, the Background item shows billing-tests\' background, with its test watcher running', async ({ page }) => {
    test.setTimeout(150000);
    const w = await watch(page);
    await openFromHero(page);
    type Work = { title: string; work?: { entries: { id: string; kind: string }[] } };
    const billing = () => demoFrame(page).evaluate(async () => {
      const list = await (window as unknown as { atelier: { terminals: { list(): Promise<Work[]> } } }).atelier.terminals.list();
      return list.find((t) => t.title === 'billing-tests')?.work?.entries.map((e) => e.kind).join(',') ?? '';
    });
    // Its agents and its vitest run are over: only the watcher is left (about 58 s in).
    await expect.poll(billing, { timeout: 75000, intervals: [1000] }).toBe('monitor');
    await expect(selected(page)).not.toContainText('billing-tests');
    await app(page).locator('.dm-check-item[data-item="background"] button').click();
    const view = app(page).locator('.bgv');
    await expect(view).toBeVisible();
    await expect(view.locator('.bgv-session-name')).toHaveText('billing-tests');
    await expect(view.locator('.bgv-empty')).toHaveCount(0);
    await expect(view).toContainText('Watch billing tests');
    await expect(app(page).locator('.dm-check-item[data-item="background"]')).toHaveClass(/is-done/);
    await mkdir(SHOTS, { recursive: true });
    await view.screenshot({ path: join(SHOTS, 'background-item.png') });
    expect(w.console).toEqual([]);
  });

  // The Notification Center's header (a real app bug the demo showed): with the "1 unread" pill it was a few px wider
  // than the 380 px popover, so the pill and "Mark all as read" wrapped onto two lines.
  test('the Notification Center\'s header stays on one line with the worker\'s crash unread', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const bell = app(page).locator('.bell-btn');
    await bell.click();
    const pop = app(page).locator('.notes-pop');
    await expect(pop).toBeVisible();
    // The worker's crash arrives while it is open (about 20 s in), unread.
    await expect(pop.locator('.note-row.kind-container.is-unread')).toBeVisible({ timeout: 45000 });
    const head = pop.locator('.notes-head');
    await expect(head.locator('.notes-unread')).toBeVisible();
    const lines = () => head.evaluate((el) => [...el.children].map((c) => ({ cls: c.className, h: Math.round(c.getBoundingClientRect().height), w: c.scrollWidth - c.clientWidth })));
    for (const c of await lines()) {
      expect(c.h, c.cls).toBeLessThanOrEqual(26);
      // Nothing clipped inside a child either (a label cut short is a wrap in disguise).
      expect(c.w, c.cls).toBeLessThanOrEqual(0);
    }
    const unreadHeight = await head.evaluate((el) => el.getBoundingClientRect().height);
    await mkdir(SHOTS, { recursive: true });
    await pop.screenshot({ path: join(SHOTS, 'notifications-unread.png') });
    await head.getByRole('button', { name: /mark all as read/i }).click();
    await expect(head.locator('.notes-unread')).toHaveCount(0);
    expect(await head.evaluate((el) => el.getBoundingClientRect().height)).toBe(unreadHeight);
    expect(w.console).toEqual([]);
  });

  test('Redis: failed jobs; "Ask Claude Why It Failed" types the job into a new session and Enter plays the diagnosis', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    await page.keyboard.press('Control+Shift+r');
    const side = app(page).locator('.sidebar.is-redis');
    await side.locator('.rd-row', { hasText: 'email-queue' }).click();
    const failed = app(page).locator('.rd-jrow');
    await expect(failed.first()).toBeVisible();
    expect(await failed.count()).toBeGreaterThanOrEqual(3);
    await failed.first().click();
    await recordOutput(page);
    const out = () => output(page);
    await app(page).getByRole('button', { name: 'Ask Claude Why It Failed' }).click();
    // A new session in front, named after the job, the job's context in its prompt (not sent).
    const tab = app(page).locator('.tab.is-active');
    await expect(tab).toContainText('redis email-queue', { timeout: 10000 });
    await expect.poll(out, { timeout: 10000 }).toMatch(/\[Pasted text #1 \+\d+ lines\]/);
    await expect(app(page).locator('.dm-check-item[data-item="redis"]')).toHaveClass(/is-done/);
    expect(await out()).not.toContain('Investigating');
    // Enter sends it: Claude plays the diagnosis of that failure, and asks to edit compose.yml.
    await page.keyboard.press('Enter');
    await expect.poll(out, { timeout: 30000 }).toContain('mails through SMTP_URL');
    await expect(tab).toHaveClass(/is-waiting/, { timeout: 30000 });
    expect(w.console).toEqual([]);
  });

  test.describe('at 2×', () => {
    test.use({ deviceScaleFactor: 2 });
    // The launch. The demo boots hidden from the click while the window is pressed; once it is ready
    // the live app zooms open, downscaled all the way (never drawn above its size). The demo shares the page's main
    // thread (same origin), so its boot lands while the pill beats: what must hold is that the page itself adds no
    // long task, and that the motion is the compositor's (live-demo.spec.ts proves that with a blocked main thread).
    // The time to the live app and the frame pacing the main thread sees are recorded for the record.
    test('the opening: the demo boots at the click; the app zooms open once ready, never upscaled; no long task of the page\'s own', async ({ page }) => {
      const w = await watch(page);
      await page.addInitScript(() => {
        const w = window as unknown as { __long: { start: number; duration: number; who: string }[] };
        w.__long = [];
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & { attribution?: { containerType: string }[] })[]) w.__long.push({ start: e.startTime, duration: e.duration, who: `${e.name}/${e.attribution?.[0]?.containerType ?? ''}` });
        }).observe({ type: 'longtask' });
      });
      await page.goto('/');
      await expect(page.locator('.hero [data-live-demo][data-armed]')).toBeAttached();
      await page.mouse.move(720, 780);
      await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some((r) => /live-demo-stage/.test(r.name)))).toBe(true);
      await page.waitForTimeout(300);
      // Every frame from the click: the app's opacity and scale, the largest scale anything is drawn at, the demo loading.
      await page.evaluate(() => {
        type S = { t: number; opacity: number; scale: number; drawn: number; loading: boolean };
        const w = window as unknown as { __motion: S[]; __t0: number };
        w.__motion = [];
        const scaleOf = (e: Element | null) => { let s = 1; for (; e && e !== document.documentElement; e = e.parentElement) { const t = getComputedStyle(e).transform; if (t !== 'none') s *= new DOMMatrix(t).a; } return s; };
        addEventListener('click', () => {
          w.__t0 = performance.now();
          const tick = () => {
            const now = performance.now();
            const win = document.querySelector('.demo-stage .demo-win');
            const f = document.querySelector('.demo-stage iframe');
            const shots = [...document.querySelectorAll('.demo-stage img, [data-live-demo] img'), ...(f ? [f] : [])];
            w.__motion.push({ t: now - w.__t0, opacity: win ? Number(getComputedStyle(win).opacity) : 0, scale: scaleOf(win), drawn: Math.max(0, ...shots.map(scaleOf)), loading: !!f?.getAttribute('src') });
            if (now - w.__t0 < 3000) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }, { capture: true, once: true });
      });
      await page.mouse.click(720, 780);
      await isOpen(page);
      await expect.poll(() => stage(page).locator('.demo-win').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
      const { motion, long, t0 } = await page.evaluate(() => {
        const w = window as unknown as { __motion: { t: number; opacity: number; scale: number; drawn: number; loading: boolean }[]; __long: { start: number; duration: number; who: string }[]; __t0: number };
        return { motion: w.__motion, long: w.__long, t0: w.__t0 };
      });
      // The demo loads from the frame after the click's, not after anything (frames, not ms: WebKit's first frames at
      // 2× take longer).
      expect(motion.findIndex((s) => s.loading), JSON.stringify(motion.slice(0, 3).map((s) => Math.round(s.t)))).toBeLessThanOrEqual(1);
      const shown = motion.findIndex((s) => s.opacity > 0);
      expect(motion[shown]!.t).toBeGreaterThanOrEqual(240);
      expect(Math.min(...motion.slice(shown).map((s) => s.scale))).toBeLessThan(0.97);
      for (const s of motion) {
        expect(s.scale, `${Math.round(s.t)} ms`).toBeLessThanOrEqual(1);
        expect(s.drawn, `${Math.round(s.t)} ms`).toBeLessThanOrEqual(1);
      }
      // No long task of the page itself from the click to the end of the zoom (the demo's boot, in its iframe, is its own).
      const end = t0 + motion[shown]!.t + 300;
      const during = long.filter((l) => l.start < end && l.start + l.duration > t0);
      expect(during.filter((l) => l.who.startsWith('self')), JSON.stringify(during)).toEqual([]);
      const zoom = motion.slice(shown).filter((s) => s.t <= motion[shown]!.t + 300);
      const gaps = zoom.slice(1).map((s, i) => s.t - zoom[i]!.t);
      test.info().annotations.push({ type: 'launch', description: `app visible ${Math.round(motion[shown]!.t)} ms after the click; zoom frames ${zoom.length}, mean interval ${(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)).toFixed(1)} ms, max ${Math.max(...gaps).toFixed(1)} ms; long tasks: ${JSON.stringify(during.map((l) => `${l.who} ${Math.round(l.duration)} ms`))}` });
      expect(w.console).toEqual([]);
    });
  });

  test('ways out: the red light, Exit demo and Back; the hero comes back, scrolled where it was, at /', async ({ page }) => {
    await watch(page);
    await page.goto('/');
    await expect(page.locator('.hero [data-live-demo][data-armed]')).toBeAttached();
    await page.evaluate(() => { history.scrollRestoration = 'manual'; window.scrollTo({ top: 160, behavior: 'instant' }); });
    const ways: [string, () => Promise<void>][] = [
      ['red light', () => app(page).locator('.dm-light.is-close').click()],
      ['Exit demo', () => app(page).locator('.dm-exit').click()],
      ['Back', () => page.goBack().then(() => undefined)]
    ];
    for (const [name, out] of ways) {
      await page.mouse.click(720, 640);
      await isOpen(page);
      await out();
      await isClosed(page);
      expect(await page.evaluate(() => window.scrollY), name).toBe(160);
    }
    // Esc belongs to the app: it never exits.
    await page.mouse.click(720, 640);
    await isOpen(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
  });

  // A row's view shows, never toggles (features.ts): split-right adds a pane each time it runs, so the demo splits only
  // from one pane. Try it twice (or Back then Forward) leaves the same two panes.
  test('the workspace row\'s Try it splits once: a second Try it and Back/Forward keep two panes', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/features');
    const row = page.locator('#workspace');
    const panes = () => app(page).locator('.workspace-body .pane-frame').count();
    const tryIt = async () => {
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator('[data-live-demo][data-armed]')).toBeAttached();
      await row.locator('.try-live').click();
      await isOpen(page);
    };
    await tryIt();
    await expect(app(page).locator('.workspace-body.is-split')).toBeVisible();
    await expect.poll(panes).toBe(2);
    await app(page).locator('.dm-exit').click();
    await expect(page).toHaveURL(/\/features$/);
    await tryIt();
    await page.waitForTimeout(800);
    expect(await panes()).toBe(2);
    await page.goBack();
    await expect(page).toHaveURL(/\/features$/);
    await expect(page.locator('html')).not.toHaveAttribute('data-demo');
    await page.goForward();
    await isOpen(page);
    await page.waitForTimeout(800);
    expect(await panes()).toBe(2);
    expect(w.console).toEqual([]);
  });

  // The editor row promises "a real editor next to Claude": Try it shows the explorer and opens session.ts (auth-refactor's
  // edit, change bars in the margin, as the row's shot) in the focused pane, never a new split.
  test('the editor row\'s Try it: the explorer and session.ts in the editor, in one pane, or in the split already there', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/features');
    const panes = () => app(page).locator('.workspace-body .pane-frame').count();
    const tryIt = async (id: string) => {
      const row = page.locator(`#${id}`);
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator('[data-live-demo][data-armed]')).toBeAttached();
      await row.locator('.try-live').click();
      await isOpen(page);
    };
    const editorShown = async () => {
      await expect(app(page).locator('.sidebar .tree-row').first()).toBeVisible();
      await expect(app(page).locator('.tab.is-active')).toContainText('session.ts');
      await expect(app(page).locator('.cm-editor').filter({ hasText: 'SKEW_MS' }).first()).toBeVisible();
    };
    // From a fresh load: one pane.
    await tryIt('editor');
    await editorShown();
    // One pane: no split (a single pane has no pane frames).
    await expect(app(page).locator('.workspace-body.is-split')).toHaveCount(0);
    expect(await panes()).toBe(0);
    await mkdir(SHOTS, { recursive: true });
    await app(page).locator('.workspace').screenshot({ path: join(SHOTS, 'editor-row.png') });
    await app(page).locator('.dm-exit').click();
    await expect(page).toHaveURL(/\/features$/);
    // From the workspace row's split: it stays two panes, session.ts in the focused one.
    await tryIt('workspace');
    await expect.poll(panes).toBe(2);
    await app(page).locator('.dm-exit').click();
    await expect(page).toHaveURL(/\/features$/);
    await tryIt('editor');
    await editorShown();
    await page.waitForTimeout(500);
    expect(await panes()).toBe(2);
    expect(w.console).toEqual([]);
  });

  test('the Claude accounts row\'s Try it: New Session on Work, both accounts with their limits; Enter starts a Work session', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/features');
    const rowEl = page.locator('#accounts');
    await rowEl.scrollIntoViewIfNeeded();
    await expect(rowEl.locator('[data-live-demo][data-armed]')).toBeAttached();
    await rowEl.locator('.try-live').click();
    await isOpen(page);
    const cards = app(page).locator('.new-session-accounts .acct-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(cards.nth(0)).toContainText('Personal');
    await expect(cards.nth(0)).toContainText('~/.claude');
    await expect(cards.nth(0).locator('.acct-usage')).toContainText('34%');
    await expect(cards.nth(1)).toContainText('~/.claude-work');
    await expect(cards.nth(1).locator('.acct-usage')).toContainText('41%');
    // docs already runs as Work: its chip in the sidebar.
    await expect(row(page, 'docs').locator('.account-chip')).toHaveText('Work');
    await mkdir(SHOTS, { recursive: true });
    await app(page).locator('.new-session').screenshot({ path: join(SHOTS, 'accounts-row.png') });
    await app(page).getByPlaceholder('Session name (optional)').fill('release-notes');
    await app(page).getByPlaceholder('Session name (optional)').press('Enter');
    await expect(row(page, 'release-notes').locator('.account-chip')).toHaveText('Work', { timeout: 10000 });

    // File › New Session with Account: the accounts the settings have, as main builds it; gone with one account left.
    const file = app(page).locator('.dm-title', { hasText: 'File' });
    const withAccount = app(page).locator('.ctx-item', { hasText: 'New Session with Account' });
    await file.click();
    await withAccount.hover();
    await expect(app(page).locator('.ctx-item', { hasText: /^Personal$/ })).toBeVisible();
    await expect(app(page).locator('.ctx-item', { hasText: /^Work$/ })).toBeVisible();
    // Esc closes the submenu, then the menu, as on a Mac.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(app(page).locator('.dm-title.is-open')).toHaveCount(0);
    await demoFrame(page).evaluate(async () => {
      const api = (window as unknown as { atelier: { settings: { get(): Promise<{ claudeAccounts: { list: unknown[] } }>; set(p: unknown): Promise<unknown> } } }).atelier.settings;
      const { claudeAccounts } = await api.get();
      await api.set({ claudeAccounts: { ...claudeAccounts, list: claudeAccounts.list.slice(0, 1) } });
    });
    await file.click();
    await expect(app(page).locator('.ctx-item', { hasText: 'New File' }).first()).toBeVisible();
    await expect(withAccount).toHaveCount(0);
    expect(w.console).toEqual([]);
  });

  test('a sheet left open never covers the next row\'s view: accounts\' New Session, leave, Docker\'s Try it', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/features');
    const tryIt = async (id: string) => {
      const r = page.locator(`#${id}`);
      await r.scrollIntoViewIfNeeded();
      await expect(r.locator('[data-live-demo][data-armed]')).toBeAttached();
      await r.locator('.try-live').click();
      await isOpen(page);
    };
    await tryIt('accounts');
    await expect(app(page).locator('.new-session')).toBeVisible();
    await app(page).locator('.dm-exit').click();
    await expect(page).toHaveURL(/\/features$/);
    await tryIt('docker');
    await expect(app(page).locator('.palette-backdrop')).toHaveCount(0);
    await expect(app(page).locator('.dk-row').first()).toBeVisible();
    expect(w.console).toEqual([]);
  });

  test('/demo opened directly works, and leaving goes home', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/demo');
    await isOpen(page);
    await page.keyboard.press('Meta+j');
    await expect(selected(page)).toContainText('db-migration');
    await app(page).locator('.dm-exit').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(w.console).toEqual([]);
  });

  for (const [what, fulfil] of [
    ['its entry script throws', { status: 200, contentType: 'text/javascript', body: 'throw new Error("forced failure at startup");' }],
    ['its entry script is missing', { status: 404, contentType: 'text/plain', body: 'not found' }]
  ] as const) {
    test(`a demo that cannot start (${what}): back to the hero, with the toast`, async ({ page }) => {
      const manifest = JSON.parse(await (await page.request.get('/demo-app/manifest.json')).text()) as { entry: string };
      await page.route(`**/demo-app/${manifest.entry}`, (r) => r.fulfill(fulfil));
      await page.goto('/');
      await expect(page.locator('.hero [data-live-demo][data-armed]')).toBeAttached();
      await page.locator('.hero .demo-hit').click();
      const toast = page.locator('.demo-toast');
      await expect(toast).toBeVisible({ timeout: 15000 });
      await expect(toast).toHaveText(/The live demo couldn't start\. Download Atelier to try it for real\./);
      await isClosed(page);
    });
  }

  test('every request is same-origin, static, a GET; nothing in the console', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    // Around the app: the palette, a file, Docker, Redis, the background inspector.
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('session.ts');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+Shift+d');
    await app(page).locator('.sidebar.is-docker').getByText('api', { exact: true }).click();
    await page.keyboard.press('Control+Shift+r');
    await app(page).locator('.sidebar.is-redis .rd-row', { hasText: 'email-queue' }).click();
    await page.keyboard.press('Meta+Alt+b');
    await page.waitForTimeout(2000);
    const origin = new URL(page.url()).origin;
    const bad = w.requests.filter((r) => {
      const u = new URL(r.url);
      if (u.protocol === 'data:' || u.protocol === 'blob:') return false;
      if (u.origin !== origin || r.method !== 'GET') return true;
      const p = decodeURIComponent(u.pathname);
      const file = p.endsWith('/') ? join(dist, p, 'index.html') : join(dist, p);
      return !(existsSync(file) || existsSync(`${file}.html`));
    });
    expect(bad).toEqual([]);
    expect(w.requests.some((r) => r.url.includes('/demo-app/assets/'))).toBe(true);
    expect(w.console).toEqual([]);
    expect(await frameErrors(page)).toEqual([]);
  });

  test('the world stops while the demo is hidden: the tab in the background, or the demo closed', async ({ page }) => {
    await watch(page);
    await openFromHero(page);
    await page.keyboard.press('Control+Shift+d');
    await app(page).locator('.sidebar.is-docker').getByText('api', { exact: true }).click();
    const lines = app(page).locator('.dk-logs .dk-ln');
    await expect(lines.first()).toBeVisible();
    const last = async () => (await lines.last().getAttribute('data-key')) ?? '';
    const moves = async (ms: number) => { const a = await last(); await page.waitForTimeout(ms); return (await last()) !== a; };
    expect(await moves(3500)).toBe(true);
    // The tab goes to the background (the demo's document says hidden).
    const hide = (hidden: boolean) => demoFrame(page).evaluate((h) => {
      Object.defineProperty(document, 'hidden', { get: () => h, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => (h ? 'hidden' : 'visible'), configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await hide(true);
    await page.waitForTimeout(300);
    expect(await moves(4000)).toBe(false);
    await hide(false);
    await expect.poll(() => moves(1500), { timeout: 10000 }).toBe(true);
    // Closed (the page says pause): the same.
    await app(page).locator('.dm-exit').click();
    await isClosed(page);
    await page.waitForTimeout(300);
    expect(await moves(4000)).toBe(false);
    await page.locator('.hero .demo-hit').click();
    await isOpen(page);
    await expect.poll(() => moves(1500), { timeout: 10000 }).toBe(true);
  });

  // Find in Files in the demo: the real view over the fictional project's files, answered by the demo bridge.
  test('Find in Files: the activity item and ⇧⌘F reach the field; TokenStore is found in session.ts and tokens.ts, and a result opens its file with the match selected', async ({ page }) => {
    const w = await watch(page);
    await openFromHero(page);
    const field = app(page).getByRole('textbox', { name: 'Search files' });
    await app(page).getByRole('button', { name: /^Find in Files/ }).click();
    await expect(field).toBeVisible();
    // Leave the view, then ⇧⌘F brings it back with the keyboard in the field, even from the page around the frame.
    await app(page).getByRole('button', { name: /^Files/ }).click();
    await expect(field).toBeHidden();
    await blurDemo(page);
    await page.keyboard.press('Meta+Shift+f');
    await expect(field).toBeFocused();
    await field.fill('TokenStore');
    await expect(app(page).locator('.fif-summary .fif-totals')).toHaveText(/^\d+ results in 2 files$/);
    // In path order: src/auth/session.ts, then src/auth/tokens.ts.
    const files = app(page).locator('.fif-row.is-file .fif-name');
    await expect(files).toHaveText([/^session\.ts/, /^tokens\.ts/]);
    // The first result: session.ts's import, line 1.
    const first = app(page).locator('.fif-row.is-match').first();
    await expect(first).toHaveAttribute('data-rel', 'src/auth/session.ts');
    await expect(first).toHaveAttribute('data-line', '1');
    await first.click();
    await expect(app(page).locator('.tab.is-active')).toContainText('session.ts');
    // The editor's selection holds the match: the strong mark is drawn on the occurrence the selection holds, whether
    // or not the editor has the keyboard (here it has not: the page around the frame has it).
    await blurDemo(page);
    const strong = app(page).locator('.file-view:visible .cm-fif-hit-strong');
    await expect(strong).toHaveText('TokenStore');
    await expect.poll(() => strong.evaluate((el) => el.closest('.cm-line')?.textContent ?? '')).toBe("import { TokenStore } from './tokens';");
    expect(w.console).toEqual([]);
  });
});
