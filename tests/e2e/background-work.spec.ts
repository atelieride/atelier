import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look, shotsOn } from './shots';

// Background work, end to end: the e2e atelierd is this build's (capability
// 'background'); the fake Claude sends the hook events Claude Code sends for background subagents, shells, crons and a
// dev server ("ev:bg-…", "ev:serve:<port>", "ev:cron:<schedule>" lines, see fake-claude.pl), mirroring the captured
// payloads in tests/fixtures/hooks/background-*.jsonl. OS banners go to e2eEnv's ATELIER_TEST_NOTIFY_LOG.

type Api = {
  terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void };
  settings: { set(patch: object): Promise<unknown> };
};

const SHOTS = resolve('e2e-shots/background-work');

interface Launched { app: ElectronApplication; home: string; win: Page; notifyLog: string; urlLog: string }

async function launch(extra: Record<string, string> = {}): Promise<Launched> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_URL_LOG: urlLog, ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow(), notifyLog: env.ATELIER_TEST_NOTIFY_LOG!, urlLog };
}

/** The dev servers the fake Claude started ("FAKE-CLAUDE serve-pid=<pid>", each its own process group). */
const servers: number[] = [];

async function stop({ app, home }: Launched) {
  try {
    await app.close();
  } finally {
    // Whatever app.close() did (a hung or crashed app), the e2e atelierd stops and no dev server is left behind.
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
    // The fake kills them when it exits; a test that failed midway still leaves none behind.
    for (const pid of servers.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
}

/** Types into a session's prompt without selecting it. */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

/**
 * Sends hook events one at a time, `gap` ms apart. atelierd coalesces terminal lists for 100 ms: events sent at once
 * would reach main as one change and hide the in-between states, which real Claude Code holds longer (each event is a
 * step of an agent, e.g. a woken main agent's new turn after the SubagentStop that woke it).
 */
async function events(win: Page, title: string, list: string[], gap = 400) {
  for (const e of list) {
    await typeInto(win, title, `ev:${e}\r`);
    await win.waitForTimeout(gap);
  }
}

const setSettings = (win: Page, patch: object) => win.evaluate((p) => (window as unknown as { atelier: Api }).atelier.settings.set(p), patch);
const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
const setSidebar = async (win: Page, width: number) => {
  await win.locator('.body').evaluate((el, w) => (el as HTMLElement).style.setProperty('--sidebar-w', `${w}px`), width);
  await expect.poll(() => win.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
};

/** The "Finished" OS banners of a session so far. */
const finished = (notifyLog: string, title: string) => (existsSync(notifyLog) ? readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean) : [])
  .map((l) => JSON.parse(l) as { title: string; body: string }).filter((b) => b.title === title && b.body === 'Finished').length;

/** The grouped list: [section label, row titles] in order. */
const sections = (win: Page) => win.locator('.list.inbox').evaluateAll((lists) => {
  const out: [string, string[]][] = [];
  for (const el of lists[0]?.children ?? []) {
    if (el.classList.contains('inbox-head')) out.push([el.querySelector('.section-label')?.textContent ?? '', []]);
    else if (el.classList.contains('session-row')) out.at(-1)?.[1].push(el.querySelector('.session-title')?.textContent ?? '');
  }
  return out;
});

/** A free TCP port in 20000–39999 (non-ephemeral: a dev server's). */
async function freePort(): Promise<number> {
  const start = Math.floor(Math.random() * 20000);
  for (let i = 0; i < 200; i++) {
    const port = 20000 + ((start + i) % 20000);
    const ok = await new Promise<boolean>((done, fail) => {
      const s = createServer();
      s.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? done(false) : fail(err)));
      s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port in 20000–39999 after 200 tries');
}

/** Starts a dev server in the session (ev:serve) and remembers its process group for the cleanup. */
async function serve(win: Page, title: string, port: number) {
  await typeInto(win, title, `ev:serve:${port}\r`);
  await row(win, title).locator('.row-main').click();
  const screen = win.locator('.xterm-rows:visible');
  await expect.poll(async () => /serve-pid=(\d+)/.exec((await screen.textContent()) ?? '')?.[1] ?? '', { timeout: 10000 }).not.toBe('');
  servers.push(Number(/serve-pid=(\d+)/.exec((await screen.textContent()) ?? '')![1]));
}

/** Waits long enough for a "Finished" to go out (finishes are batched for 2.5 s), then counts. */
const settledFinished = async (win: Page, l: Launched, title: string) => { await win.waitForTimeout(3500); return finished(l.notifyLog, title); };

test('a subagent waiting on its own background shell: Working with "1 agent · 1 shell", no "Finished" until the final Stop, then exactly one', async () => {
  const l = await launch();
  const { win } = l;
  try {
    // Every finish (the fake's turns last seconds; the 1-minute default would keep them quiet).
    await setSettings(win, { notifyDone: true, notifyDoneAfter: 'always' });
    await newSession(win, 'Bg');
    // Another session selected: Bg is never looked at, so its finished turns stay unread.
    await newSession(win, 'Other');
    await typeInto(win, 'Bg', '\r');
    await expect(row(win, 'Bg')).toHaveClass(/state-done/, { timeout: 10000 });
    await expect.poll(() => finished(l.notifyLog, 'Bg'), { timeout: 10000 }).toBe(1);
    const chip = row(win, 'Bg').locator('.work-chip');

    // The captured sequence: a new turn launches a background subagent, which starts its own background shell (each
    // step seen before the next is sent).
    await typeInto(win, 'Bg', 'ev:work\r');
    await expect(row(win, 'Bg')).toHaveClass(/state-running/, { timeout: 10000 });
    await typeInto(win, 'Bg', 'ev:agents:1\r');
    await expect(chip.locator('.work-full')).toHaveText('1 agent');
    await typeInto(win, 'Bg', 'ev:bg-shell:s1@a1:sleep 30; echo shell-B-done\r');
    await expect(chip.locator('.work-full')).toHaveText('1 agent · 1 shell');
    // The subagent "finishes responding" while its shell runs (it lists itself and the shell), the main agent gets its
    // misleading "completed" report, then ends its turn listing only the shell.
    await events(win, 'Bg', ['bg-substop', 'bg-notify:a1', 'bg-stop']);
    await expect(row(win, 'Bg')).toHaveClass(/state-running/, { timeout: 10000 });
    await expect(row(win, 'Bg')).toHaveClass(/is-unread/);
    await expect(chip.locator('.work-full')).toHaveText('1 agent · 1 shell');
    await expect(chip).toHaveClass(/is-counting/);
    await expect(chip).toHaveAttribute('data-tip', '1 agent · 1 shell\nagent · Explore\nshell · sleep 30; echo shell-B-done\nClick for details');
    await expect(row(win, 'Bg').locator('.session-activity')).toHaveText('In background · Explore');
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Other']], ['Working', ['Bg']]]);
    // The main agent's Stop was an intermediate turn: no "Finished".
    expect(await settledFinished(win, l, 'Bg')).toBe(1);

    // The shell ends (no hook), its subagent is woken and stops for good, reports back, and the main agent's last
    // Stop has nothing left: Ready for review, and one "Finished".
    await events(win, 'Bg', ['bg-done:s1', 'agents:1', 'bg-substop', 'bg-notify:a1', 'bg-stop']);
    await expect(chip).toHaveCount(0, { timeout: 10000 });
    await expect(row(win, 'Bg')).toHaveClass(/state-done/);
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Other']], ['Ready for review', ['Bg']]]);
    await expect.poll(() => finished(l.notifyLog, 'Bg'), { timeout: 10000 }).toBe(2);
    expect(await settledFinished(win, l, 'Bg')).toBe(2);
  } finally {
    await stop(l);
  }
});

test('a dev server started in the background is not work: the session finishes once the scan has seen its port long enough, one "Finished", the port on the second line', async () => {
  // A server once its listener has been seen for 4 s here (15 s in the app); the ports hub polls every 500 ms (4 s).
  const l = await launch({ ATELIER_TEST_SERVER_LISTEN_MS: '4000', ATELIER_TEST_PORTS_POLL_MS: '500' });
  const { win } = l;
  try {
    // Every finish (the fake's turns last seconds; the 1-minute default would keep them quiet).
    await setSettings(win, { notifyDone: true, notifyDoneAfter: 'always' });
    await newSession(win, 'Dev');
    await newSession(win, 'Other');
    await typeInto(win, 'Dev', '\r');
    await expect(row(win, 'Dev')).toHaveClass(/state-done/, { timeout: 10000 });
    await expect.poll(() => finished(l.notifyLog, 'Dev'), { timeout: 10000 }).toBe(1);

    // A new turn starts the server in the background (a real child listening on a free non-ephemeral port), then ends.
    const port = await freePort();
    await typeInto(win, 'Dev', 'ev:work\r');
    await expect(row(win, 'Dev')).toHaveClass(/state-running/, { timeout: 10000 });
    await serve(win, 'Dev', port);
    await row(win, 'Other').locator('.row-main').click();
    await typeInto(win, 'Dev', 'ev:bg-stop\r');
    const stopAt = Date.now();
    // A listener younger than that may be a test run's: the shell still counts, the session stays Working (the Stop has
    // long arrived after 1.5 s; the listener has not been seen for 4 s yet).
    await win.waitForTimeout(1500);
    await expect(row(win, 'Dev')).toHaveClass(/state-running/);
    expect(finished(l.notifyLog, 'Dev')).toBe(1);
    // Once its listener has been seen long enough the scan proves it a server: done, no work chip, one "Finished".
    await expect(row(win, 'Dev')).toHaveClass(/state-done/, { timeout: 15000 });
    expect(Date.now() - stopAt).toBeLessThan(15000);
    await expect(row(win, 'Dev').locator('.work-chip')).toHaveCount(0);
    await expect.poll(() => finished(l.notifyLog, 'Dev'), { timeout: 15000 }).toBe(2);
    // Its port shows on the second line, below the title (at 264 px, the live dot naming it).
    await setSidebar(win, 264);
    const dot = row(win, 'Dev').locator('.row-ports .port-all');
    await expect(dot).toHaveAttribute('data-tip', `Open localhost:${port} · perl`, { timeout: 10000 });
    await expect.poll(() => row(win, 'Dev').evaluate((el) => {
      const line = el.querySelector('.session-line')!.getBoundingClientRect();
      const sub = el.querySelector('.session-sub')!.getBoundingClientRect();
      const chip = el.querySelector('.row-ports .port-all')!.getBoundingClientRect();
      return { belowTitle: chip.top >= line.bottom - 0.5, onSecondLine: Math.abs((chip.top + chip.bottom) / 2 - (sub.top + sub.bottom) / 2) < 3 };
    })).toEqual({ belowTitle: true, onSecondLine: true });
    expect(await settledFinished(win, l, 'Dev')).toBe(2);
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Other']], ['Ready for review', ['Dev']]]);
  } finally {
    await stop(l);
  }
});

test('a scheduled wake-up: the clock chip shows the next time, with its prompt in the tooltip', async () => {
  // (Moving on when the time passes is main's work timer: work-hub.test.ts, cron-view.test.ts.)
  const l = await launch();
  const { win } = l;
  try {
    await newSession(win, 'Loop');
    await typeInto(win, 'Loop', '\r');
    await expect(row(win, 'Loop')).toHaveClass(/state-done/, { timeout: 10000 });
    // Every minute: the chip shows the coming minute; crons never keep a session working.
    await typeInto(win, 'Loop', 'ev:cron:* * * * *\r');
    const chip = row(win, 'Loop').locator('.sched-chip');
    await setSidebar(win, 400);
    await expect(chip.locator('.sched-time')).toHaveText(/^\d\d:\d\d$/, { timeout: 10000 });
    await expect(chip).toHaveAttribute('data-tip', /^1 scheduled wake-up · next at \d\d:\d\d( tomorrow)? · check the deploy\nClick for details$/);
    await expect(row(win, 'Loop')).toHaveClass(/state-done/);
    await expect(row(win, 'Loop').locator('.work-chip')).toHaveCount(0);
  } finally {
    await stop(l);
  }
});

test('ephemeral ports stay hidden until "Show ephemeral ports"; at 264 px the port dot opens a menu listing every port', async () => {
  // The ports hub polls every 500 ms here (4 s in the app).
  const l = await launch({ ATELIER_TEST_PORTS_POLL_MS: '500' });
  const { win } = l;
  try {
    await newSession(win, 'Tests');
    // One ephemeral port (a test run's) and two non-ephemeral ones (a dev server's), all of the same process.
    await typeInto(win, 'Tests', '\rev:listen-ephemeral\rev:listen:2\r');
    await expect(row(win, 'Tests')).toHaveClass(/state-done/, { timeout: 10000 });
    await setSidebar(win, 264);
    // The poll that shows the two others would show the ephemeral one too: it stays hidden.
    const dot = row(win, 'Tests').locator('.row-ports .port-all');
    await expect(dot).toHaveAttribute('data-tip', /^Listening: :\d+ · perl, :\d+ · perl$/, { timeout: 10000 });
    const shown = (await dot.getAttribute('data-tip'))!.match(/:(\d+) ·/g)!.map((x) => Number(x.slice(1, -2)));
    expect(shown.every((port) => port < 49152)).toBe(true);

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const toggle = dialog.getByRole('switch', { name: 'Show ephemeral ports' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // With this build's atelierd (capability 'background') the work setting is live.
    await dialog.getByRole('button', { name: 'Claude' }).click();
    await expect(dialog.getByRole('switch', { name: 'Count background work as Working' })).toBeEnabled();
    await win.keyboard.press('Escape');
    // Shown: the dot lists all three, and a click opens the menu of them.
    await expect(dot).toHaveAttribute('data-tip', /^Listening: :\d+ · perl, :\d+ · perl, :\d+ · perl$/, { timeout: 10000 });
    const ephemeral = (await dot.getAttribute('data-tip'))!.match(/:(\d+) ·/g)!.map((x) => Number(x.slice(1, -2))).find((port) => !shown.includes(port))!;
    expect(ephemeral).toBeGreaterThanOrEqual(49152);
    await expect(dot).toHaveAttribute('aria-haspopup', 'menu');
    await dot.click();
    const menu = win.getByRole('menu');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveCount(3);
    await expect(items).toHaveText([/^Open localhost:\d+ · perl$/, /^Open localhost:\d+ · perl$/, /^Open localhost:\d+ · perl$/]);
    await expect(menu.getByRole('menuitem', { name: `Open localhost:${ephemeral} · perl` })).toHaveCount(1);
    await still(win);
    await look(win.locator('.sidebar'), 'test-results/background-work-port-menu.png');
    // An entry opens localhost through main (logged, never a real browser).
    await menu.getByRole('menuitem', { name: `Open localhost:${ephemeral} · perl` }).click();
    await expect.poll(() => (existsSync(l.urlLog) ? readFileSync(l.urlLog, 'utf8') : ''), { timeout: 5000 }).toContain(`http://localhost:${ephemeral}/`);
    await expect(menu).toHaveCount(0);
  } finally {
    await stop(l);
  }
});

test('an atelierd without background: no work or scheduled chip, "Finished" follows the main agent, Settings › Terminal says how to get it', async () => {
  const l = await launch({ ATELIER_TEST_NO_PROFILES: 'background' });
  const { win } = l;
  try {
    // Every finish (the fake's turns last seconds; the 1-minute default would keep them quiet).
    await setSettings(win, { notifyDone: true, notifyDoneAfter: 'always' });
    await newSession(win, 'Old');
    await newSession(win, 'Other');
    await typeInto(win, 'Old', '\r');
    await expect(row(win, 'Old')).toHaveClass(/state-done/, { timeout: 10000 });
    await expect.poll(() => finished(l.notifyLog, 'Old'), { timeout: 10000 }).toBe(1);
    // A background shell, then the main Stop with a scheduled wake-up: done right away, as before background work.
    await events(win, 'Old', ['work', 'bg-shell:s1:npm run e2e', 'cron']);
    await expect.poll(() => finished(l.notifyLog, 'Old'), { timeout: 10000 }).toBe(2);
    await expect(row(win, 'Old')).toHaveClass(/state-done/);
    await expect(row(win, 'Old').locator('.work-chip, .sched-chip')).toHaveCount(0);
    await expect(row(win, 'Old').locator('.session-activity', { hasText: 'In background' })).toHaveCount(0);

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    await expect(dialog.locator('.set-notice')).toHaveText(/^Restart atelierd to see background work/);
    await expect(dialog.locator('.set-notice')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Restart atelierd…' })).toHaveCount(1);
    // The setting it would bring is there, disabled, saying why.
    await dialog.getByRole('button', { name: 'Claude' }).click();
    const count = dialog.getByRole('switch', { name: 'Count background work as Working' });
    await expect(count).toBeDisabled();
    const countRow = dialog.locator('.set-row', { has: win.getByRole('switch', { name: 'Count background work as Working' }) });
    await expect(countRow).toHaveClass(/is-disabled/);
    await expect(countRow.locator('.set-hint')).toHaveText('Needs atelierd restart (see Terminal).');
    if (shotsOn()) mkdirSync(SHOTS, { recursive: true });
    await look(countRow, join(SHOTS, 'count-setting-needs-restart.png'), { animations: 'disabled' });
  } finally {
    await stop(l);
  }
});
