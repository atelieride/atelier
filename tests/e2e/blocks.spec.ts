import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Command blocks: the e2e atelierd's Atelier profile emits OSC 133 marks. Copies go to the test copy
// log (ATELIER_TEST_CLIPBOARD_LOG), never to the real clipboard.

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string; win: Page; copies: () => string[] }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const log = join(mkdtempSync(join(tmpdir(), 'atl-clip-')), 'copies.log');
  const { env, home } = e2eEnv({ ATELIER_TEST_CLIPBOARD_LOG: log, ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const copies = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : []);
  return { app, home, win: await app.firstWindow(), copies };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const screen = (win: Page) => win.locator('.xterm-rows:visible');
const topRow = (win: Page) => win.locator('.xterm-rows:visible > div').first();
const bars = (win: Page) => win.locator('.terminal-slot:visible .cb-bar:not([hidden])');
const statuses = (win: Page) => bars(win).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status).sort());
/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

/** Runs a command in the newest terminal and waits for the next prompt (the Atelier prompt's ›). */
async function run(win: Page, cmd: string, until: RegExp | string) {
  await win.evaluate(async (c) => {
    const api = (window as unknown as { atelier: AtelierApi }).atelier;
    const term = (await api.terminals.list()).at(-1);
    api.terminals.input(term!.id, c + '\r');
  }, cmd);
  await expect(screen(win)).toContainText(until, { timeout: 10000 });
}

test('command blocks: gutter colors, ⌘↑/⌘↓, copy output and command, sticky line, context menu, clear, setting; fake marks make no block; Copy command leaves out continuation prompts', async () => {
  const { app, home, win, copies } = await launch();
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(screen(win)).toContainText(/main ›/, { timeout: 10000 });
    // The first prompt is not a command: no bar.
    await expect(bars(win)).toHaveCount(0);

    await run(win, 'true', /› true\S*? main ›\s*$/);
    await run(win, 'false', /› false\S*? main ›\s*$/);
    await expect.poll(() => statuses(win)).toEqual(['fail', 'ok']);
    // An empty Enter redraws the prompt: no block.
    await run(win, '', /› false\S*? main ›\s*\S*? main ›\s*$/);
    await expect(bars(win)).toHaveCount(2);
    await still(win);
    await look(win.locator('.terminal-slot:visible'), 'test-results/blocks-gutter.png');

    // A long output: its bar runs past the top, the command stays pinned while you are inside it.
    await run(win, 'seq 1 300', /300\S*? main ›\s*$/);
    await expect.poll(() => statuses(win)).toEqual(['ok']);
    const sticky = win.locator('.terminal-slot:visible .cb-sticky:not([hidden])');
    await expect(sticky).toHaveText('seq 1 300');
    await expect(sticky).toHaveClass(/is-ok/);
    await look(win.locator('.terminal-slot:visible'), 'test-results/blocks-sticky.png');
    // The wheel over the sticky line still scrolls the terminal (and it stays while inside the output).
    const before = await topRow(win).textContent();
    await sticky.hover();
    await win.mouse.wheel(0, -400);
    await expect.poll(() => topRow(win).textContent()).not.toBe(before);
    await expect(sticky).toHaveText('seq 1 300');
    await win.mouse.wheel(0, 4000);
    await expect(screen(win)).toContainText(/300\S*? main ›\s*$/);

    // ⌘↑: to the last command (seq), then the one before (false); ⌘↓ back, then the bottom.
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Meta+ArrowUp');
    await expect(topRow(win)).toContainText('seq 1 300');
    await expect(sticky).toHaveCount(0);
    await win.keyboard.press('Meta+ArrowUp');
    await expect(topRow(win)).toContainText(/›\s*false/);
    await look(win.locator('.terminal-slot:visible'), 'test-results/blocks-jump.png');
    await win.keyboard.press('Meta+ArrowDown');
    await expect(topRow(win)).toContainText('seq 1 300');
    await win.keyboard.press('Meta+ArrowDown');
    await expect(screen(win)).toContainText(/300\S*? main ›\s*$/);

    // Hover inside the output: Copy output / Copy command.
    await win.keyboard.press('Meta+ArrowUp');
    await expect(topRow(win)).toContainText('seq 1 300');
    const row5 = win.locator('.xterm-rows:visible > div').nth(5);
    // xterm's screen layer sits over the rows: point at the row, whatever element is on top.
    await row5.hover({ force: true });
    const actions = win.locator('.terminal-slot:visible .cb-actions:not([hidden])');
    await expect(actions).toBeVisible();
    await still(win);
    await look(win.locator('.terminal-slot:visible'), 'test-results/blocks-hover.png');
    await actions.getByRole('button', { name: 'Copy output' }).click();
    await expect.poll(() => copies().at(-1)).toBe(Array.from({ length: 300 }, (_, i) => String(i + 1)).join('\n'));
    await expect(win.locator('.toast')).toContainText('Output copied');
    await actions.getByRole('button', { name: 'Copy command' }).click();
    await expect.poll(() => copies().at(-1)).toBe('seq 1 300');

    // Context menu on the false block: Copy Command; its output is empty, so Copy Output is off.
    await win.keyboard.press('Meta+ArrowUp');
    await expect(topRow(win)).toContainText(/›\s*false/);
    await topRow(win).click({ button: 'right', force: true });
    await expect(win.getByRole('menuitem', { name: 'Copy Output' })).toBeDisabled();
    await win.getByRole('menuitem', { name: 'Copy Command' }).click();
    await expect.poll(() => copies().at(-1)).toBe('false');

    // The palette has them too (for the selected terminal): copy the last command's output.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>command');
    await expect(win.locator('.palette-item', { hasText: 'Previous command' })).toBeVisible();
    await expect(win.locator('.palette-item', { hasText: 'Command blocks in terminals' })).toBeVisible();
    await win.locator('.palette-input').fill('>Copy last command output');
    await win.keyboard.press('Enter');
    await expect.poll(() => copies().at(-1)).toBe(Array.from({ length: 300 }, (_, i) => String(i + 1)).join('\n'));

    // Setting off: no bars, ⌘↑ does nothing; back on.
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Meta+ArrowDown'); await win.keyboard.press('Meta+ArrowDown');
    await expect(screen(win)).toContainText(/300\S*? main ›\s*$/);
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const toggle = dialog.getByRole('switch', { name: 'Command blocks' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await win.keyboard.press('Escape');
    await expect(bars(win)).toHaveCount(0);
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Meta+ArrowUp');
    await expect(screen(win)).toContainText(/300\S*? main ›\s*$/);
    await expect(topRow(win)).not.toContainText('seq 1 300');
    await win.getByRole('button', { name: 'Settings' }).click();
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    await dialog.getByRole('switch', { name: 'Command blocks' }).click();
    await win.keyboard.press('Escape');
    await expect(bars(win)).not.toHaveCount(0);

    // Ctrl+L under the long output: the screen is erased, the seq block ends above it and never grows again.
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Control+l');
    await expect(screen(win)).toContainText(/^\s*\S+ main ›\s*$/);
    await expect(bars(win)).toHaveCount(0);
    await expect(sticky).toHaveCount(0);
    await run(win, 'true', /› true\S*? main ›\s*$/);
    await expect.poll(() => statuses(win)).toEqual(['ok']);
    await win.keyboard.press('Meta+ArrowUp'); await win.keyboard.press('Meta+ArrowUp');
    await expect(topRow(win)).toContainText('seq 1 300');
    await win.keyboard.press('Meta+ArrowDown'); await win.keyboard.press('Meta+ArrowDown'); await win.keyboard.press('Meta+ArrowDown');

    // clear: the erased blocks are gone, a new command starts again.
    await run(win, 'clear', /^\s*\S+ main ›\s*$/);
    await expect(bars(win)).toHaveCount(0);
    await expect(sticky).toHaveCount(0);
    await run(win, 'true', /› true\S*? main ›\s*$/);
    await expect.poll(() => statuses(win)).toEqual(['ok']);

    // A second terminal, fresh: without the shell's nonce the marks are ignored, only the real command shows, finished
    // ok (no fake fail).
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
    await expect(screen(win)).toContainText(/main ›/, { timeout: 10000 });
    await expect(bars(win)).toHaveCount(0);
    await run(win, "printf '\\e]133;A\\a\\e]133;B\\a\\e]133;C\\a\\e]133;D;1\\a'; echo spoof-done", /spoof-done\S*? main ›\s*$/);
    await expect.poll(() => statuses(win)).toEqual(['ok']);

    // A multi-line command: its for> prompts are not part of the copied command.
    await run(win, 'for i in 1 2; do\recho item-$i\rdone', /item-2\S*? main ›\s*$/);
    await expect(screen(win)).toContainText('for>');
    await expect.poll(() => statuses(win)).toEqual(['ok', 'ok']);
    await win.locator('.xterm-rows:visible > div', { hasText: 'item-1' }).last().click({ button: 'right', force: true });
    await win.getByRole('menuitem', { name: 'Copy Command' }).click();
    await expect.poll(() => copies().at(-1)).toBe('for i in 1 2; do\necho item-$i\ndone');
  } finally {
    await stop(app, home);
  }
});

/** Rows on screen as text (the DOM renderer's non-breaking spaces as spaces). */
const rows = (win: Page) => win.evaluate(() => [...document.querySelectorAll('.terminal-slot:not([hidden]) .xterm-rows > div')]
  .filter((r) => (r as HTMLElement).offsetParent !== null).map((r) => (r.textContent ?? '').replace(/\u00a0/g, ' ')));

/** The center of the first `needle` on the last visible row that contains `row`. */
async function charAt(win: Page, row: string, needle: string): Promise<{ x: number; y: number }> {
  return win.evaluate(([rowText, n]) => {
    const els = [...document.querySelectorAll('.xterm-rows > div')].filter((r) => (r as HTMLElement).offsetParent !== null);
    const el = els.filter((r) => (r.textContent ?? '').replace(/\u00a0/g, ' ').includes(rowText)).at(-1)!;
    const at = (el.textContent ?? '').replace(/\u00a0/g, ' ').indexOf(n);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.textContent!.length;
      if (seen + len > at) {
        const range = document.createRange();
        range.setStart(node, at - seen); range.setEnd(node, at - seen + 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      seen += len;
    }
    throw new Error(`${n} not found`);
  }, [row, needle] as const);
}

test('click to move the cursor: a click in the command being typed moves the cursor; links there wait for ⌘; drags select; setting off', async () => {
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  const { app, home, win } = await launch({ ATELIER_TEST_URL_LOG: urlLog });
  const typeLine = async (text: string) => {
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type(text);
    await expect.poll(() => rows(win).then((r) => r.some((x) => x.includes(text)))).toBe(true);
  };
  const enterThenRow = async (start: string) => {
    await win.keyboard.press('Enter');
    await expect.poll(() => rows(win).then((r) => r.some((x) => x.startsWith(start))), { timeout: 10000 }).toBe(true);
  };
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(screen(win)).toContainText(/main ›/, { timeout: 10000 });

    await typeLine('echo hello world');
    const w = await charAt(win, 'echo hello world', 'world');
    await win.mouse.click(w.x, w.y);
    await win.keyboard.type('X');
    await enterThenRow('hello Xworld');
    await still(win);
    await look(win.locator('.terminal-slot:visible'), 'test-results/click-to-move.png');

    // A command wrapped over several rows: down (zsh moves with a line feed, the row loses its wrap flag), up, down.
    const tokens = Array.from({ length: 60 }, (_, i) => `k${String(i).padStart(3, '0')}`);
    await win.keyboard.type(`echo ${tokens.join(' ')}`);
    await expect.poll(() => rows(win).then((r) => r.join(''))).toContain('k058 k059');
    const lastRow = async () => rows(win).then((r) => r.findIndex((x) => x.includes('k059')));
    await expect.poll(lastRow).toBeGreaterThan(await rows(win).then((r) => r.findIndex((x) => x.includes('k001'))));
    for (const k of ['k001', 'k058', 'k002', 'k057']) {
      const p = await charAt(win, k, k);
      await win.mouse.click(p.x, p.y);
      await win.waitForTimeout(250);
    }
    await win.keyboard.type('X');
    await expect.poll(() => rows(win).then((r) => r.join(''))).toContain('Xk057');
    await enterThenRow('k000 k001');
    await expect.poll(() => rows(win).then((r) => r.join(''))).toContain('k056 Xk057 k058');

    // A URL in the command: the plain click moves the cursor, the link is not opened.
    await typeLine('echo https://example.com/zz end');
    const e = await charAt(win, 'echo https://example.com/zz end', 'example');
    await win.mouse.move(e.x, e.y);
    await win.waitForTimeout(300);
    await win.mouse.click(e.x, e.y);
    await win.keyboard.type('Y');
    await enterThenRow('https://Yexample.com/zz end');
    expect(existsSync(urlLog) ? readFileSync(urlLog, 'utf8') : '').toBe('');

    // A drag selects: the cursor stays at the end.
    await typeLine('echo abc def');
    const a = await charAt(win, 'echo abc def', 'abc');
    const d = await charAt(win, 'echo abc def', 'def');
    await win.mouse.move(a.x, a.y);
    await win.mouse.down();
    await win.mouse.move(d.x, d.y, { steps: 5 });
    await win.mouse.up();
    await win.keyboard.type('Z');
    await enterThenRow('abc defZ');

    // ⌘ pressed before the release: not a plain click, the cursor stays.
    await typeLine('echo uvw xyz');
    const u = await charAt(win, 'echo uvw xyz', 'uvw');
    await win.mouse.move(u.x, u.y);
    await win.mouse.down();
    await win.keyboard.down('Meta');
    await win.mouse.up();
    await win.keyboard.up('Meta');
    await win.keyboard.type('W');
    await enterThenRow('uvw xyzW');

    // Setting off: the click is only a click.
    await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.set({ clickMovesCursor: false }));
    await typeLine('echo one two');
    const t = await charAt(win, 'echo one two', 'two');
    await win.mouse.click(t.x, t.y);
    await win.keyboard.type('Q');
    await enterThenRow('one twoQ');
  } finally {
    await stop(app, home);
  }
});
