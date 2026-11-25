// Closing from the phone, end to end, with a fake phone on Atelier's own Noise code (tests/support/fake-phone.ts)
// through the test relay (tests/support/test-relay.ts): an activity and a workspace closed as their Close… does (what
// is in them moves to the workspace above, or stops), the last workspace kept; then the project's window itself closed
// and opened again: with no answer while Atelier's setting is to ask, a busy terminal keeps running in the closed
// project; the phone's "stop" stops it; a window with an unsaved file refuses to close. Nothing is asked on this
// computer.
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { look } from './shots';
import { type FakePhone, type Msg } from '../support/fake-phone';
import { close, command, launchWithPhone, pairPhone, settingsSet, type Launched } from './iphone-fixture';

const SHOTS = 'test-results/iphone-windows';

type Place = { id: string; name: string; parent?: string };
type Workspaces = { active: string; places: Place[]; members: Record<string, string> };
type Row = { id: string; state: string };
const projectOf = (s: Msg, root: string) => (s.projects as { id: string; name: string; open: boolean }[]).find((p) => p.name === basename(root));
const rowOf = (s: Msg, id: string) => (s.sessions as Row[]).find((r) => r.id === id);
/** The workspaces of the latest layout the phone got for a project (undefined: off there). */
const workspacesOf = (phone: FakePhone, project: string) => ([...phone.messages].reverse().find((m) => m.t === 'layout' && m.project === project)?.layout as Msg | null | undefined)?.workspaces as Workspaces | undefined;
const pair = (l: Launched) => pairPhone(l.app, l.win, l.phone);
const windowCount = (l: Launched) => l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed()).length);

test('from the phone: an activity and a workspace closed, their rows moved to the workspace above or stopped; the last workspace stays', async () => {
  test.setTimeout(180_000);
  const l = await launchWithPhone({}, { size: [1280, 800] });
  const { win, phone, root } = l;
  try {
    await pair(l);
    const state = await phone.state();
    const project = projectOf(state, root)!.id;
    const terminal = (state.sessions as Row[])[0]!.id;
    await expect.poll(() => [...phone.messages].some((m) => m.t === 'layout' && m.project === project && m.layout !== null), { timeout: 10000 }).toBe(true);
    // Workspaces and activities turned on here first: only this computer turns them on.
    await command(l.app, 'toggle-workspaces');
    await settingsSet(win, { wsActivities: true });
    await expect.poll(() => workspacesOf(phone, project)?.places.length).toBe(1);
    await phone.state((s) => (s.features as Msg | undefined)?.activities === true, 10000);
    const w2 = (await phone.newWorkspace(project, 'Release')).id as string;
    const a = (await phone.newActivity(project, w2, 'QA pass')).id as string;
    const w1 = workspacesOf(phone, project)!.places[0]!.id;
    expect(await phone.move(terminal, a)).toMatchObject({ t: 'ok' });
    await expect.poll(() => workspacesOf(phone, project)?.members[terminal]).toBe(a);

    // The activity closed with no choice, as Close Activity…'s default: its terminal joins its workspace.
    expect(await phone.closePlace(project, a)).toMatchObject({ t: 'ok' });
    await expect.poll(() => workspacesOf(phone, project)?.places.map((p) => p.id)).toEqual([w1, w2]);
    await expect.poll(() => workspacesOf(phone, project)?.members[terminal]).toBe(w2);
    await expect(win.locator(`[data-wsa-group="${a}"]`)).toHaveCount(0);

    // The workspace closed: its terminal joins the one above, still running; no confirm on this computer.
    expect(await phone.closePlace(project, w2, 'move')).toMatchObject({ t: 'ok' });
    await expect(win.locator('.ws-group .ws-name')).toHaveText(['Workspace 1']);
    await expect(win.locator(`[data-ws-group="${w1}"] [data-term-row="${terminal}"]`)).toBeVisible();
    await expect(win.locator('.confirm-pop')).toHaveCount(0);
    await expect.poll(() => workspacesOf(phone, project)?.places.map((p) => p.id)).toEqual([w1]);
    expect(rowOf(await phone.state(), terminal)).toBeTruthy();

    // The last workspace stays.
    expect(await phone.closePlace(project, w1, 'stop')).toMatchObject({ t: 'error', code: 'invalid', message: 'A project\'s last workspace stays.' });

    // A workspace with a new terminal in it, closed with stop: the terminal stops, the other one stays.
    const w3 = (await phone.newWorkspace(project, 'Scratch')).id as string;
    const fresh = (await phone.create(project, 'terminal', { place: w3 })).id as string;
    await expect.poll(() => workspacesOf(phone, project)?.members[fresh], { timeout: 15000 }).toBe(w3);
    expect(await phone.closePlace(project, w3, 'stop')).toMatchObject({ t: 'ok' });
    const after = await phone.state((s) => !rowOf(s, fresh), 15000);
    expect(rowOf(after, terminal)).toBeTruthy();
    await expect(win.locator('.ws-group .ws-name')).toHaveText(['Workspace 1']);
    await look(win, `${SHOTS}/places-closed.png`, { settle: 300 });
  } finally {
    await close(l);
  }
});

test('from the phone: the project\'s window closed and opened again; busy work kept running unless the phone says stop; an unsaved file refuses', async () => {
  test.setTimeout(180_000);
  // Closing asks when something is busy, as Atelier's default setting does.
  const l = await launchWithPhone({ ATELIER_TEST_CLOSE_SESSIONS: 'ask' }, { size: [1280, 800] });
  const { app, win, phone, root } = l;
  try {
    await pair(l);
    const state = await phone.state();
    const project = projectOf(state, root)!.id;
    const terminal = (state.sessions as Row[])[0]!.id;

    // A command running in the shell: busy.
    expect(await phone.attach(terminal)).toMatchObject({ t: 'snapshot' });
    phone.input(terminal, 'sleep 45\r');
    await phone.state((s) => rowOf(s, terminal)?.state === 'running', 15000);

    // Closed with no answer while the setting is to ask: busy, so it keeps running with the window closed.
    const [, closed] = await Promise.all([win.waitForEvent('close'), phone.closeWindow(project)]);
    expect(closed, JSON.stringify(closed)).toMatchObject({ t: 'ok' });
    const kept = await phone.state((s) => projectOf(s, root)?.open === false, 15000);
    expect(rowOf(kept, terminal)).toBeTruthy();
    // Closing a window already closed: done.
    expect(await phone.closeWindow(project, 'stop')).toMatchObject({ t: 'ok' });

    // Opened again, as a recent project opens: the terminal is in it.
    const [again, opened] = await Promise.all([app.waitForEvent('window'), phone.openWindow(project)]);
    expect(opened, JSON.stringify(opened)).toMatchObject({ t: 'ok' });
    await expect(again.locator(`[data-term-row="${terminal}"]`)).toBeVisible({ timeout: 15000 });
    await phone.state((s) => projectOf(s, root)?.open === true, 15000);
    // An open one comes to the front: no second window.
    expect(await phone.openWindow(project)).toMatchObject({ t: 'ok' });
    expect(await windowCount(l)).toBe(1);
    await look(again, `${SHOTS}/reopened.png`, { settle: 300 });

    // Closed with the phone's stop: the busy terminal stops.
    const [, stopped] = await Promise.all([again.waitForEvent('close'), phone.closeWindow(project, 'stop')]);
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ t: 'ok' });
    await phone.state((s) => projectOf(s, root)?.open === false && !rowOf(s, terminal), 15000);

    // A file edited and not saved: the close is refused in words, the window stays, nothing asked here.
    writeFileSync(join(root, 'notes.md'), '# Notes\n');
    const [third] = await Promise.all([app.waitForEvent('window'), phone.openWindow(project)]);
    await expect(third.locator('.header')).toBeVisible({ timeout: 15000 });
    await third.getByRole('button', { name: /^Files/ }).click();
    await third.locator('.tree-row', { hasText: 'notes.md' }).first().dblclick();
    await expect(third.locator('.tab.is-active', { hasText: 'notes.md' })).toBeVisible();
    await third.locator('.file-view:visible .cm-content').click();
    await third.keyboard.press('Meta+ArrowDown');
    await third.keyboard.type('more');
    await expect(third.locator('.tab.is-active .tab-dirty')).toHaveCount(1);
    expect(await phone.closeWindow(project, 'keep')).toMatchObject({ t: 'error', code: 'invalid', message: 'It has unsaved files: save or close them on this computer first.' });
    expect(await windowCount(l)).toBe(1);
    await expect(third.locator('.confirm-sheet')).toHaveCount(0);
    await look(third, `${SHOTS}/unsaved-refused.png`, { settle: 300 });
  } finally {
    await close(l);
  }
});
