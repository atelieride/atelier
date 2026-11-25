// A Claude session's conversation on a phone, end to end, with the fake phone (tests/support/fake-phone.ts) through the
// test relay and the fake Claude (tests/e2e/fake-claude.pl): the phone follows the conversation and types a prompt into
// it while the window shows the session at the window's own size, the phone badge on its row; a phone opening the
// terminal fitted leaves the window that size until it types. A permission dialog read from the screen and answered
// with its own digit; a choice for a dialog no longer on screen refused. The live check's sequence
// (tests/e2e/iphone-live.manual.ts) with the fake phone: follow, a prompt, a permission asked on cue and chosen, the
// terminal opened fitted, the stand-in for Claude Code recording its terminal's size all along.
import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { look } from './shots';
import type { Msg } from '../support/fake-phone';
import { close, launchWithPhone, newWaitingSession, pairPhone, sizeKept, type Launched } from './iphone-fixture';

const SHOTS = 'test-results/iphone-conversation';

/** A project whose Claude sessions are the fake Claude, each with a UUID session id (its transcript can be found). */
const launch = (extra: Record<string, string>) => launchWithPhone({
  ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_UUID_SESSIONS: '1', ATELIER_FAKE_LINGER: '120', ...extra
}, { size: [1280, 800] });

type Row = { id: string; state: string; ask?: string; wait?: string; waitingFor?: string };
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

/**
 * Every size main got from the window for a Claude session's terminal, once the window's layout is settled: the
 * session's bar shown (it takes rows when it comes), the last size given drawn by the window, the same on two reads in
 * a row (a late sizing, 78×33 then 78×31, settles first).
 */
async function settledSizes(app: ElectronApplication, slot: Locator, id: string): Promise<string[]> {
  await expect(slot.page().locator('.session-bar')).toBeVisible({ timeout: 15000 });
  let last = '';
  await expect.poll(async () => {
    const given = (await sizesOf(app, id)).at(-1);
    const rows = (await drawn(slot)).rows;
    const now = `${given} drawn with ${rows} rows`;
    const settled = given?.split('x')[1] === String(rows) && now === last;
    last = now;
    return settled;
  }, { timeout: 10000 }).toBe(true);
  return sizesOf(app, id);
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
    // The window's size: the last one it gave, once its layout is settled.
    const given = await settledSizes(app, slot, id);
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
    // Open on the phone first, to see every key typed into it.
    await phone.attach(id, 80, 24);
    await phone.sees(id, 'Do you want to proceed?', 15000);
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

    // Another page of the same wait (not the dialog on screen): refused, nothing typed: the dialog still waits, the
    // same page read again, nothing allowed. The one shown: its digit.
    expect(await phone.choose(id, `${ask}.AAAAAAAA`, 1, 'Yes')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    expect(await phone.dialog(id)).toMatchObject({ t: 'dialog', ask: d.ask });
    expect(phone.screen(id)).toContain('Do you want to proceed?');
    expect(phone.screen(id)).not.toMatch(/FAKE-CLAUDE (allowed|denied|key=)/);
    expect(await phone.choose(id, d.ask as string, 1, 'Yes')).toMatchObject({ t: 'ok' });
    await phone.sees(id, 'FAKE-CLAUDE allowed', 10000);
    // The dialog reads one key at a time: a key typed before the digit would show as such.
    expect(phone.screen(id)).not.toContain('FAKE-CLAUDE key=');
  } finally {
    await close(l);
  }
});

test('the live check\'s sequence: follow, a prompt and its reply, a permission asked on cue and chosen, the terminal opened fitted; the stand-in\'s size never changes', async () => {
  test.setTimeout(180_000);
  // The files the stand-in for Claude Code shares with the test: the cue to ask a permission, the sizes it had.
  const dir = mkdtempSync(join(tmpdir(), 'atl-iph-live-'));
  const askFile = join(dir, 'ask-permission');
  const sizeFile = join(dir, 'claude-size.txt');
  const l = await launch({
    ATELIER_FAKE_CONVERSATION: '1', ATELIER_FAKE_PERMISSION_KEYS: '1', ATELIER_FAKE_LINGER: '600',
    ATELIER_FAKE_ASK_FILE: askFile, ATELIER_FAKE_SIZE_FILE: sizeFile
  });
  const { app, win, phone } = l;
  const sizes = () => readFileSync(sizeFile, 'utf8').trim().split('\n');
  try {
    await watchSizes(app);
    await pairPhone(app, win, phone);
    // As the live check: a Claude session from the window's New Claude Session, in front, asking for a permission.
    const id = await newWaitingSession(app, win);
    const claudeRow = win.locator(`[data-term-row="${id}"]`);
    const slot = win.locator('.terminal-slot:visible');
    const rows = slot.locator('.xterm-rows');
    await expect(rows).toContainText('Do you want to proceed?', { timeout: 15000 });
    const size = (await settledSizes(app, slot, id)).at(-1)!;
    const [cols, height] = size.split('x').map(Number) as [number, number];

    // Allowed from the phone's row: the stand-in goes on to its prompt, where it records the size it has: the window's.
    const row = rowOf(await phone.state((s) => !!rowOf(s, id)?.wait, 30000), id)!;
    expect(await phone.answer(id, row.wait!, 'allow')).toMatchObject({ t: 'ok' });
    await expect(rows).toContainText('FAKE-CLAUDE allowed', { timeout: 15000 });
    await expect(rows).toContainText('Try "fix the tests"', { timeout: 15000 });
    // Its turn over as main sees it too (the hooks may come after the screen): a prompt goes only then.
    await phone.state((s) => rowOf(s, id)?.state === 'done' && !rowOf(s, id)?.wait, 15000);
    expect(sizes()).toEqual([size]);
    await sizeKept(win, id, sizeFile, 'allowed');

    // Followed: the reply already in the transcript; the phone badge on the session's row.
    const page = await phone.follow(id);
    expect(page).toMatchObject({ t: 'chat', id });
    expect(page.entries).toContainEqual(expect.objectContaining({ k: 'reply', text: 'Running the test suite.' }));
    await expect(claudeRow.locator('.phone-badge')).toBeVisible({ timeout: 10000 });
    await sizeKept(win, id, sizeFile, 'followed');
    await look(win, `${SHOTS}/live-conversation.png`, { settle: 400 });

    // A prompt from the phone, and its reply in the conversation.
    const said = await phone.say(id, 'Now build it');
    expect(said, JSON.stringify(said)).toMatchObject({ t: 'ok' });
    await expect(rows).toContainText('FAKE-CLAUDE got=Now build it', { timeout: 10000 });
    await expect.poll(() => phone.conversation(id).filter((e) => e.k !== 'tool').slice(-2).map((e) => [e.k, e.text]), { timeout: 15000 }).toEqual([
      ['prompt', 'Now build it'], ['reply', 'You said: Now build it']
    ]);
    await sizeKept(win, id, sizeFile, 'said');

    // On cue, the stand-in asks for a permission: the row waits for it, and the dialog reads as Claude Code draws it,
    // tied to the conversation's running Bash call.
    writeFileSync(askFile, '');
    await expect(claudeRow).toContainText('Needs permission', { timeout: 15000 });
    const asked = rowOf(await phone.state((s) => rowOf(s, id)?.waitingFor === 'permission' && !!rowOf(s, id)?.ask && rowOf(s, id)?.wait !== row.wait, 15000), id)!;
    await expect.poll(async () => (await phone.dialog(id)).t, { timeout: 15000 }).toBe('dialog');
    await expect.poll(() => phone.conversation(id).find((e) => e.k === 'tool' && e.target === 'npm run build')?.status, { timeout: 15000 }).toBe('running');
    const build = phone.conversation(id).find((e) => e.k === 'tool' && e.target === 'npm run build')!;
    const d = await phone.dialog(id);
    expect(d).toMatchObject({
      t: 'dialog', id, kind: 'permission', entry: build.n,
      rows: ['Bash command', 'npm run build', 'Build the app', 'Do you want to proceed?'],
      options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, and don\'t ask again for npm run build commands' }, { n: 3, label: 'No' }]
    });
    expect((d.ask as string).startsWith(`${asked.ask}.`)).toBe(true);
    expect(await phone.choose(id, d.ask as string, 1, 'Yes')).toMatchObject({ t: 'ok' });
    await expect(rows).toContainText('FAKE-CLAUDE allowed npm run build', { timeout: 10000 });
    await expect(claudeRow).not.toContainText('Needs permission', { timeout: 10000 });
    await sizeKept(win, id, sizeFile, 'chose');
    await look(win, `${SHOTS}/live-chose.png`, { settle: 400 });

    // The terminal opened on the phone, fitted: at the window's size, which the stand-in keeps.
    const snap = await phone.attach(id, 60, 30, { fit: true });
    await sizeKept(win, id, sizeFile, 'attached fitted');
    expect(snap).toMatchObject({ t: 'snapshot', id, cols, rows: height });
    await expect(claudeRow.locator('.phone-badge')).toBeVisible();
    await look(win, `${SHOTS}/live-terminal.png`, { settle: 400 });

    // Typing on the phone takes the size: the stand-in records it (what the checks above would have seen).
    phone.input(id, 'x');
    await expect.poll(() => sizes().at(-1), { timeout: 10000 }).toBe('60x30');
  } finally {
    await close(l);
  }
});
