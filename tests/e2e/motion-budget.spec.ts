import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Idle motion budget: at rest nothing loops but the visible working
// session's activity label, and that one only while the window is active; a state change plays a finite cue.

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

async function launch(): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  // One cycle per cue instead of 3 (8 for "starting"): the cues still play and end on their own, which is what these
  // tests prove; the real counts are pinned by tests/integration/motion-budget.test.ts.
  await win.waitForLoadState('domcontentloaded');
  await win.addStyleTag({ content: ':root { --cue-cycles: 1 !important; --cue-cycles-long: 1 !important; }' });
  return { app, home, win };
}
async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}
const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
}
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}
/**
 * The animations running now: name, whether it loops, and the class of what it animates (plus its pseudo-element).
 * xterm's own cursor blink is left out (terminals are out of scope): tests use xterm's DOM renderer, which
 * blinks with a CSS animation; the app uses WebGL, which blinks with a timer and only in the focused terminal.
 */
const running = (win: Page) => win.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && !/^blink_(bar|block|underline)_/.test((a as CSSAnimation).animationName)).map((a) => {
  const e = a.effect as KeyframeEffect;
  const el = e.target as Element | null;
  return { name: (a as CSSAnimation).animationName, infinite: e.getTiming().iterations === Infinity, on: `${el?.getAttribute('class') ?? ''}${e.pseudoElement ?? ''}` };
}));
const setWindow = (win: Page, type: 'focus' | 'blur') => win.evaluate((t) => window.dispatchEvent(new Event(t)), type);
// The longest cue at one cycle: the waiting pane's 2.4 s breath.
const SETTLE = 8000;

test('at rest nothing loops, not even the visible working session\'s label, active window or not; rest states are drawn; a turn ended with a background agent counting rests too', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    // The root says from the start whether the window has focus.
    const focused = await win.evaluate(() => document.hasFocus());
    await expect(win.locator('html')).toHaveAttribute('data-window', focused ? 'active' : 'inactive');
    for (const name of ['Ask', 'Wait', 'Work', 'Done', 'Bg']) await newSession(win, name);
    await typeInto(win, 'Work', '\r');
    await typeInto(win, 'Done', '\r');
    await typeInto(win, 'Bg', '\r');
    await expect(row(win, 'Done')).toHaveClass(/state-done/, { timeout: 10000 });
    // Bg: its turn ended but its background agent still counts, so it shows as working while Claude waits at its prompt.
    await expect(row(win, 'Bg')).toHaveClass(/state-done/, { timeout: 10000 });
    await typeInto(win, 'Bg', 'ev:work\rev:agents:1\r');
    await typeInto(win, 'Bg', 'ev:stop\rev:agent-tool\r');
    await expect(row(win, 'Bg')).toHaveClass(/state-running/, { timeout: 10000 });
    await expect(row(win, 'Bg').locator('.work-chip')).toHaveClass(/is-counting/);
    await typeInto(win, 'Work', 'ev:work\r');
    await expect(row(win, 'Work')).toHaveClass(/state-running/, { timeout: 10000 });
    await row(win, 'Work').click();
    // No label sweeps any more: the visible working session's label is plain text.
    await expect(win.locator('.sb-activity')).toHaveCount(1);
    await expect(win.locator('.shimmer')).toHaveCount(0);

    await setWindow(win, 'focus');
    await expect(win.locator('html')).toHaveAttribute('data-window', 'active');
    await expect.poll(() => running(win), { timeout: SETTLE, intervals: [500] }).toEqual([]);

    await setWindow(win, 'blur');
    await expect.poll(() => running(win), { timeout: 5000 }).toEqual([]);

    // Rest states: the working row's subtitle is solid text; the waiting pane keeps its calm hairline.
    const fill = await row(win, 'Work').locator('.session-activity').first().evaluate((el) => getComputedStyle(el).webkitTextFillColor);
    expect(fill).not.toBe('rgba(0, 0, 0, 0)');
    await row(win, 'Ask').click();
    await expect.poll(() => running(win), { timeout: SETTLE, intervals: [500] }).toEqual([]);
    const glow = await win.locator('.workspace-body.is-waiting').evaluate((el) => ({
      calm: getComputedStyle(el, '::before').boxShadow, bright: getComputedStyle(el, '::after').opacity
    }));
    expect(glow.calm).not.toBe('none');
    expect(glow.bright).toBe('0');
    await look(win, 'test-results/motion-budget-rest.png');

    // The visible session's label does not loop while only its background agent works: Claude itself is idle.
    await row(win, 'Bg').click();
    await setWindow(win, 'focus');
    await expect.poll(() => running(win), { timeout: SETTLE, intervals: [500] }).toEqual([]);
  } finally {
    await stop(app, home);
  }
});

test('a session that starts waiting plays its cue, then rests; the footer dot replays for each new waiting session', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await newSession(win, 'First');
    const ring = (await running(win)).filter((a) => a.name === 'atl-ring-cue');
    expect(ring.length).toBeGreaterThan(0);
    expect(ring.every((a) => !a.infinite)).toBe(true);
    await expect.poll(() => running(win), { timeout: SETTLE, intervals: [500] }).toEqual([]);

    const footerDot = win.locator('.foot-item.is-waiting i');
    await newSession(win, 'Second');
    expect(await footerDot.evaluate((el) => el.getAnimations().length)).toBe(1);
    await expect.poll(() => running(win), { timeout: SETTLE, intervals: [500] }).toEqual([]);

    // Answering one of them is attention given: the footer dot does not cue again.
    await typeInto(win, 'Second', '\r');
    await expect(win.locator('.foot-item.is-waiting')).toContainText('1');
    expect(await footerDot.evaluate((el) => el.getAnimations().length)).toBe(0);
  } finally {
    await stop(app, home);
  }
});
