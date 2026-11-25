// A Claude session's conversation on a phone, end to end, with the fake phone (tests/support/fake-phone.ts) through the
// test relay and the fake Claude (tests/e2e/fake-claude.pl): the phone follows the conversation and types a prompt into
// it while the window shows the session at the window's own size, the phone badge on its row; a phone opening the
// terminal fitted leaves the window that size until it types. A permission dialog read from the screen and answered
// with its own digit; a choice for a dialog no longer on screen refused.
import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { basename, resolve } from 'node:path';
import { look } from './shots';
import type { Msg } from '../support/fake-phone';
import { close, launchWithPhone, pairPhone, type Launched } from './iphone-fixture';

const SHOTS = 'test-results/iphone-conversation';

/** A project whose Claude sessions are the fake Claude, each with a UUID session id (its transcript can be found). */
const launch = (extra: Record<string, string>) => launchWithPhone({
  ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_UUID_SESSIONS: '1', ATELIER_FAKE_LINGER: '120', ...extra
}, { size: [1280, 800] });

type Row = { id: string; state: string; ask?: string };
const rowsOf = (s: Msg) => s.sessions as Row[];
const rowOf = (s: Msg, id: string) => rowsOf(s).find((x) => x.id === id);

/** The phone paired, and a Claude session it started in the project. */
async function newSession(l: Launched): Promise<string> {
  await pairPhone(l.app, l.win, l.phone);
  const project = ((await l.phone.state()).projects as { id: string; name: string }[]).find((p) => p.name === basename(l.root))!.id;
  const made = await l.phone.create(project, 'claude');
  expect(made.t).toBe('created');
  return made.id as string;
}

type Size = { id: string; cols: number; rows: number };
/** From now on, every size a window gives a terminal, as main receives it. */
const watchSizes = (app: ElectronApplication) => app.evaluate(({ ipcMain }) => {
  const g = globalThis as unknown as { sizes: Size[] };
  g.sizes = [];
  ipcMain.on('term:resize', (_e, a: Size) => { g.sizes.push(a); });
});
const sizesOf = (app: ElectronApplication, id: string) =>
  app.evaluate((_e, id) => (globalThis as unknown as { sizes: Size[] }).sizes.filter((s) => s.id === id).map((s) => `${s.cols}x${s.rows}`), id);

/** How the window draws a terminal: its rows and the size of its screen. */
async function drawn(slot: Locator): Promise<{ rows: number; width: number; height: number }> {
  const box = (await slot.locator('.xterm-screen').boundingBox())!;
  return { rows: await slot.locator('.xterm-rows > div').count(), width: Math.round(box.width), height: Math.round(box.height) };
}

test('a phone follows a Claude session and types into it; the window\'s terminal keeps its size; the badge shows', async () => {
  test.setTimeout(180_000);
  const l = await launch({ ATELIER_FAKE_CONVERSATION: '1' });
  const { app, win, phone } = l;
  try {
    await watchSizes(app);
    const id = await newSession(l);
    const row = win.locator(`[data-term-row="${id}"]`);
    // Shown in the window, at its pane's size; Claude has run its first turn and waits at its prompt.
    await row.click();
    const slot = win.locator('.terminal-slot:visible');
    await expect(slot.locator('.xterm-rows')).toContainText('Try "fix the tests"', { timeout: 30000 });
    await phone.state((s) => rowOf(s, id)?.state === 'done', 30000);
    // The window's size: the last one it gave, once its layout is settled (the session's bar takes rows when it comes)
    // and it draws the terminal at it.
    await expect.poll(async () => (await sizesOf(app, id)).at(-1)?.split('x')[1] === String((await drawn(slot)).rows), { timeout: 10000 }).toBe(true);
    const given = await sizesOf(app, id);
    const size = given.at(-1)!;
    const [cols, rows] = size.split('x').map(Number) as [number, number];
    const before = await drawn(slot);
    expect(before.rows).toBe(rows);
    /** The window still owns the terminal's size: no note, drawn as before, no other size given, the phone told none. */
    const kept = async (what: string) => {
      await expect(slot.locator('.size-note'), what).toHaveCount(0);
      expect(await drawn(slot), what).toEqual(before);
      expect((await sizesOf(app, id)).slice(given.length).filter((s) => s !== size), what).toEqual([]);
      expect(phone.messages.filter((m) => m.t === 'size'), what).toEqual([]);
    };
    await expect(row.locator('.phone-badge')).toHaveCount(0);

    // Followed: the conversation so far, from its first entry; the session counts as open on the phone.
    const page = await phone.follow(id);
    expect(page).toMatchObject({
      t: 'chat', id, start: true, entries: [
        { n: 1, k: 'prompt', text: 'Run the tests' },
        { n: 2, k: 'reply', text: 'Running the test suite.' },
        { n: 3, k: 'tool', tool: 'Bash', target: 'npm test', status: 'ok', detail: '12 passed' }
      ]
    });
    expect(page).not.toHaveProperty('pending');
    await expect(row.locator('.phone-badge')).toBeVisible({ timeout: 10000 });
    await kept('followed');
    await look(win, `${SHOTS}/following.png`, { settle: 400 });

    // A prompt from the phone: typed into Claude's prompt and sent; the reply comes in the conversation.
    expect(await phone.say(id, 'fix the tests')).toMatchObject({ t: 'ok' });
    await expect(slot.locator('.xterm-rows')).toContainText('FAKE-CLAUDE got=fix the tests', { timeout: 10000 });
    await expect.poll(() => phone.conversation(id).map((e) => [e.n, e.k, e.text]), { timeout: 15000 }).toEqual([
      [1, 'prompt', 'Run the tests'], [2, 'reply', 'Running the test suite.'], [3, 'tool', undefined],
      [4, 'prompt', 'fix the tests'], [5, 'reply', 'You said: fix the tests']
    ]);
    await kept('said');

    // The terminal opened on the phone, fitted: drawn at the window's size, which the window keeps; typing takes it.
    expect(await phone.attach(id, 60, 30, { fit: true })).toMatchObject({ t: 'snapshot', id, cols, rows });
    await kept('attached fitted');
    phone.input(id, 'x');
    await expect(slot.locator('.size-note')).toContainText('Sized for iPhone', { timeout: 10000 });

    // Neither followed nor open on the phone: the badge goes.
    phone.unfollow(id);
    phone.detach(id);
    await expect(row.locator('.phone-badge')).toHaveCount(0, { timeout: 10000 });
  } finally {
    await close(l);
  }
});

test('a phone reads the permission dialog and chooses Yes with its digit; a stale ask is refused', async () => {
  test.setTimeout(180_000);
  const l = await launch({ ATELIER_FAKE_PERMISSION_KEYS: '1' });
  const { phone } = l;
  try {
    const id = await newSession(l);
    const ask = rowOf(await phone.state((s) => !!rowOf(s, id)?.ask, 30000), id)!.ask!;
    // Read once the dialog is drawn (the session's wait may come first): the request's own rows, its options in order.
    await expect.poll(async () => (await phone.dialog(id)).t, { timeout: 15000 }).toBe('dialog');
    const d = await phone.dialog(id);
    expect(d).toMatchObject({
      t: 'dialog', id, kind: 'permission',
      rows: ['Bash command', 'npm test', 'Run the requested command', 'Do you want to proceed?'],
      options: [
        { n: 1, label: 'Yes' },
        { n: 2, label: 'Yes, and don\'t ask again for npm test commands' },
        { n: 3, label: 'No, and tell Claude what to do differently (esc)' }
      ]
    });
    expect(d.ask).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8}$/);
    expect((d.ask as string).startsWith(`${ask}.`)).toBe(true);

    // Another page of the same wait (not the dialog on screen): refused, nothing typed; the one shown: its digit.
    expect(await phone.choose(id, `${ask}.AAAAAAAA`, 1, 'Yes')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    expect(await phone.choose(id, d.ask as string, 1, 'Yes')).toMatchObject({ t: 'ok' });
    await phone.attach(id, 80, 24);
    await phone.sees(id, 'FAKE-CLAUDE allowed', 10000);
    // The dialog reads one key at a time: a key typed before the digit would show as such.
    expect(phone.screen(id)).not.toContain('FAKE-CLAUDE key=');
  } finally {
    await close(l);
  }
});
