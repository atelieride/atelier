import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Find in the terminal: ⌘F over a terminal's screen and scrollback, newest first.
// Copies go to the test copy log (ATELIER_TEST_CLIPBOARD_LOG), never to the real clipboard.

async function launch(): Promise<{ app: ElectronApplication; home: string; win: Page; copies: () => string[] }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const log = join(mkdtempSync(join(tmpdir(), 'atl-clip-')), 'copies.log');
  const { env, home } = e2eEnv({ ATELIER_TEST_CLIPBOARD_LOG: log });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const copies = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : []);
  return { app, home, win: await app.firstWindow(), copies };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const screen = (win: Page) => win.locator('.xterm-rows:visible');
const row = (win: Page, text: RegExp) => win.locator('.xterm-rows:visible > div', { hasText: text }).last();
const topRow = (win: Page) => win.locator('.xterm-rows:visible > div').first();
const card = (win: Page) => win.locator('.terminal-slot:visible .term-find-layer .find-card');
const field = (win: Page) => card(win).getByRole('textbox', { name: 'Find' });
const counter = (win: Page) => card(win).locator('.fc-count .fc-wide');
/** The overview ruler's painted pixels: any at all, and how many in its left edge column (where xterm draws a border). */
const rulerInk = (win: Page) => win.locator('.terminal-slot:visible .xterm-decoration-overview-ruler').evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let any = 0; let edge = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) { any++; if (((i - 3) / 4) % c.width === 0) edge++; }
  return { any: any > 0, edge };
});
/** The inline backgrounds in the visible rows (the DOM renderer paints a match's cells so). */
const rowBgs = (win: Page) => win.locator('.xterm-rows:visible [style*="background-color"]').evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).style.backgroundColor))]);
/** Aurora's match color: --hit-bg over --term-bg, #483A1E (find.test.ts). */
const AURORA_HIT = 'rgb(72, 58, 30)';
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

/** Types a command into the test's terminal, the first one (as if from the keyboard, but without moving focus). */
async function send(win: Page, cmd: string) {
  await win.evaluate(async (c) => {
    const api = (window as unknown as { atelier: AtelierApi }).atelier;
    const term = (await api.terminals.list())[0];
    api.terminals.input(term!.id, c + '\r');
  }, cmd);
}
/** Runs a command in the test's terminal and waits for what it prints. */
async function run(win: Page, cmd: string, until: RegExp | string) {
  await send(win, cmd);
  await expect(screen(win)).toContainText(until, { timeout: 10000 });
}

test('find in a terminal: ⌘F, newest first, ↵ up and ⇧↵ down, options, live output, Esc back to the shell, context menu, palette, full-screen note', async () => {
  const { app, home, win, copies } = await launch();
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(screen(win)).toContainText(/main ›/, { timeout: 10000 });
    // 200 rows, "needle" on every 20th: more than a screen, so the oldest matches are in the scrollback. The command
    // spells it in two halves, so only the output matches.
    await run(win, `seq 1 200 | awk '{ print "row " $1 ($1 % 20 == 0 ? " nee" "dle" : "") }'`, /row 200 needle[\s\S]*main ›\s*$/);

    // The ruler over the scrollbar paints nothing without a search: no ticks, and no border line down its left edge.
    await expect.poll(() => rulerInk(win)).toEqual({ any: false, edge: 0 });

    // The first ⌘F of the window: what is typed right after it reaches the card, never the shell.
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Meta+f');
    await win.keyboard.type('nee');
    await expect(card(win)).toBeVisible();
    await expect(field(win)).toHaveValue('nee');
    await win.keyboard.press('Escape');
    await expect(card(win)).toHaveCount(0);

    // A selection of the user's becomes the query, and the very occurrence selected is the current match: "row" on
    // row 199 is the 200th of 201 (the command line holds one too).
    await row(win, /^row 199$/).dblclick({ position: { x: 12, y: 6 }, force: true });
    await win.keyboard.press('Meta+f');
    await expect(field(win)).toHaveValue('row');
    await expect(counter(win)).toHaveText('200 of 201');

    // Another query starts from the newest match: the last of them (row 200) is the current one.
    await field(win).fill('needle');
    await expect(counter(win)).toHaveText('10 of 10');
    // A tick for each match on the scrollbar (still no edge line).
    await expect.poll(() => rulerInk(win)).toEqual({ any: true, edge: 0 });
    await still(win);
    await look(win.locator('.terminal-slot:visible'), 'test-results/terminal-find.png');

    // ↵ goes up (older), ⇧↵ down (newer); the ↑/↓ buttons say so.
    await win.keyboard.press('Enter');
    await expect(counter(win)).toHaveText('9 of 10');
    await win.keyboard.press('Shift+Enter');
    await expect(counter(win)).toHaveText('10 of 10');
    await expect(card(win).getByRole('button', { name: 'Previous Match' })).toHaveAttribute('data-kbd', '↵');
    await expect(card(win).getByRole('button', { name: 'Next Match' })).toHaveAttribute('data-kbd', '⇧↵');
    // ⌘G is ↵ in the card.
    await win.keyboard.press('Meta+g');
    await expect(counter(win)).toHaveText('9 of 10');
    // Up to the oldest, far in the scrollback: it scrolls into view.
    await expect(screen(win)).not.toContainText('row 20 needle');
    for (let i = 0; i < 8; i++) await win.keyboard.press('Enter');
    await expect(counter(win)).toHaveText('1 of 10');
    await expect(screen(win)).toContainText('row 20 needle');

    // The wheel over the card scrolls the terminal underneath.
    const top = await topRow(win).textContent();
    await card(win).hover();
    await win.mouse.wheel(0, 600);
    await expect.poll(() => topRow(win).textContent()).not.toBe(top);

    // A new query starts from the newest match ("row 1": 111 of them, row 199 the newest); one that only grows,
    // shrinks or changes case keeps its place.
    await field(win).fill('row 1');
    await expect(counter(win)).toHaveText('111 of 111');
    await field(win).fill('needle');
    await expect(counter(win)).toHaveText('10 of 10');
    await win.keyboard.press('Enter');
    await expect(counter(win)).toHaveText('9 of 10');
    await field(win).fill('NEEDLE');
    await expect(counter(win)).toHaveText('9 of 10');
    // Options: Match Case finds none for NEEDLE.
    await card(win).getByRole('button', { name: 'Match Case' }).click();
    await expect(counter(win)).toHaveText('No results');
    await card(win).getByRole('button', { name: 'Match Case' }).click();
    await expect(counter(win)).toHaveText('10 of 10');
    // A regular expression (rows 100, 110… 190), one that doesn't compile, then whole words.
    await card(win).getByRole('button', { name: 'Regular Expression' }).click();
    await field(win).fill('row 1.0');
    await expect(counter(win)).toHaveText('10 of 10');
    await field(win).fill('row 1(');
    await expect(counter(win)).toHaveText('Invalid');
    await expect(card(win).locator('.fc-error')).toBeVisible();
    await card(win).getByRole('button', { name: 'Regular Expression' }).click();
    await field(win).fill('needle');
    await expect(counter(win)).toHaveText('10 of 10');
    // "needle" is a whole word; "needl" never is ("nee" is: the command line spells " nee" "dle").
    await card(win).getByRole('button', { name: 'Whole Word' }).click();
    await expect(counter(win)).toHaveText('10 of 10');
    await field(win).fill('needl');
    await expect(counter(win)).toHaveText('No results');
    await card(win).getByRole('button', { name: 'Whole Word' }).click();
    await expect(counter(win)).toHaveText('10 of 10');
    await field(win).fill('NEEDLE');
    await expect(counter(win)).toHaveText('10 of 10');

    // New output: the matches follow it, the current one stays the current one.
    await run(win, `echo "late $(echo nee)dle"`, /late needle/);
    await expect(counter(win)).toHaveText('10 of 11');

    // Another theme repaints the matches in its own colors.
    await expect.poll(() => rowBgs(win)).toContain(AURORA_HIT);
    const before = await rowBgs(win);
    await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.set({ theme: 'ember' }));
    await expect.poll(() => rowBgs(win)).not.toContain(AURORA_HIT);
    expect((await rowBgs(win)).some((bg) => !before.includes(bg)), JSON.stringify(await rowBgs(win))).toBe(true);
    await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.set({ theme: 'aurora' }));

    // A tab in front of it: its search rests (no matches drawn); back in front, they are again.
    const hits = () => win.locator('.terminal-slot .xterm-find-result-decoration');
    await expect(hits().first()).toBeAttached();
    await expect(win.locator('.tabs .tab')).toHaveCount(1);
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
    await expect(win.locator('.tabs .tab')).toHaveCount(2);
    await expect(card(win)).toHaveCount(0);
    await expect(hits()).toHaveCount(0);
    await win.locator('.tabs .tab').first().click();
    await expect(card(win)).toBeVisible();
    await expect(hits().first()).toBeAttached();
    await expect(counter(win)).toHaveText('10 of 11');

    // Esc right after output: the card goes, the current match stays selected. The addon searches again 200 ms after
    // the last output; that pending search, run after the card closed, would clear the selection.
    await field(win).focus();
    await send(win, 'echo ping-$((2+2))');
    // The output and the prompt after it drawn (checked every frame), then Esc at once: well within the 200 ms.
    await win.waitForFunction(() => {
      const text = [...document.querySelectorAll('.xterm-rows')].map((r) => r.textContent ?? '').join('');
      const at = text.indexOf('ping-4');
      return at >= 0 && text.lastIndexOf('main ›') > at;
    }, null, { polling: 'raf' });
    await win.keyboard.press('Escape');
    await expect(card(win)).toHaveCount(0);
    // Past the addon's 200 ms, with no output since.
    await win.waitForTimeout(400);
    await win.keyboard.press('Shift+F10');
    await expect(win.getByRole('menuitem', { name: /^Copy/ })).toBeEnabled();
    await win.getByRole('menuitem', { name: /^Copy/ }).click();
    await expect.poll(() => copies().at(-1)).toBe('needle');
    await win.locator('.xterm-helper-textarea:visible').focus();
    // ⌘F again: that selection is the match, not one of the user's, so the query stays as typed (not "needle").
    await win.keyboard.press('Meta+f');
    await expect(field(win)).toHaveValue('NEEDLE');
    await win.keyboard.press('Escape');
    // The keyboard is the shell's again.
    await win.keyboard.type('echo back-$((1+1))');
    await win.keyboard.press('Enter');
    await expect(row(win, /^back-2/)).toBeAttached();

    // The context menu's Find: the last query again.
    await screen(win).click({ button: 'right', force: true });
    await win.getByRole('menuitem', { name: /^Find/ }).click();
    await expect(field(win)).toBeFocused();
    await expect(field(win)).toHaveValue('NEEDLE');
    await expect(counter(win)).toHaveText(/\d+ of 11/);

    // With the card open, text the user selects in the terminal stays theirs while output arrives (the search
    // doesn't take the selection back), and ⌘F then searches it.
    await row(win, /^back-2/).dblclick({ position: { x: 12, y: 6 }, force: true });
    await run(win, `echo "more $(echo nee)dle"`, /more needle/);
    await win.waitForTimeout(400);
    await win.keyboard.press('Shift+F10');
    await expect(win.getByRole('menuitem', { name: /^Copy/ })).toBeEnabled();
    await win.getByRole('menuitem', { name: /^Copy/ }).click();
    await expect.poll(() => copies().at(-1)).toBe('back-2');
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Meta+f');
    await expect(field(win)).toHaveValue('back-2');
    await expect(counter(win)).toHaveText('1 of 1');
    await win.keyboard.press('Escape');

    // The palette's Find in Terminal (the terminal tab in front).
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Find in Terminal');
    await win.keyboard.press('Enter');
    await expect(field(win)).toBeFocused();
    await win.keyboard.press('Escape');

    // A full-screen program (the alternate screen): only its screen is searched, and the card says so.
    await run(win, `printf '\\033[?1049h'; echo "alt $(echo nee)dle"`, /alt needle/);
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Meta+f');
    await expect(card(win).locator('.fc-note')).toHaveText("Full-screen program: only what's on screen is searched.");
    // The needles of the normal screen aren't searched there: only the one on screen.
    await field(win).fill('needle');
    await expect(counter(win)).toHaveText('1 of 1');
    await win.keyboard.press('Escape');
    await run(win, `printf '\\033[?1049l'`, /row 200 needle/);
  } finally {
    await stop(app, home);
  }
});
