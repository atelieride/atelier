// Workspaces and activities from the phone, end to end, with a fake phone on Atelier's own Noise code
// (tests/support/fake-phone.ts) through the test relay (tests/support/test-relay.ts): a workspace made where workspaces
// are off, an activity made in it while activities are off, both renamed, a terminal moved into the activity, then a
// change with the project's window closed (it opens, the change is applied there). The sidebar and the phone's next
// layout show each change.
import { expect, test } from '@playwright/test';
import { basename } from 'node:path';
import { look } from './shots';
import { FakePhone, type Msg } from '../support/fake-phone';
import { close, launchWithPhone, pairPhone, settingsOf, type Launched } from './iphone-fixture';

const SHOTS = 'test-results/iphone-places';

/** A project with a terminal open at its prompt, a test relay and a phone for it. */
const launch = () => launchWithPhone({}, { size: [1280, 800] });
const pair = (l: Launched) => pairPhone(l.app, l.win, l.phone);

type Place = { id: string; name: string; color: number; parent?: string; open: boolean };
type Workspaces = { active: string; activities: boolean; places: Place[]; members: Record<string, string> };
const projectOf = (s: Msg, root: string) => (s.projects as { id: string; name: string; open: boolean }[]).find((p) => p.name === basename(root));
/** The workspaces of the latest layout the phone got for a project (undefined: off there). */
const workspacesOf = (phone: FakePhone, project: string) => ([...phone.messages].reverse().find((m) => m.t === 'layout' && m.project === project)?.layout as Msg | null | undefined)?.workspaces as Workspaces | undefined;

test('from the phone: a workspace and an activity where both were off, renamed, a terminal moved in; a closed window opens for a change', async () => {
  test.setTimeout(240_000);
  const l = await launch();
  const { app, win, phone, root } = l;
  try {
    await pair(l);
    const state = await phone.state();
    const project = projectOf(state, root)!.id;
    const terminal = (state.sessions as { id: string }[])[0]!.id;
    await expect.poll(() => [...phone.messages].some((m) => m.t === 'layout' && m.project === project && m.layout !== null), { timeout: 10000 }).toBe(true);
    expect(workspacesOf(phone, project)).toBeUndefined();
    expect(await settingsOf(win)).toMatchObject({ wsActivities: false });

    // A workspace while workspaces are off: they turn on (everything in Workspace 1, still in front), and an empty
    // "Workspace 2" is made after it.
    const made = await phone.newWorkspace(project);
    expect(made, JSON.stringify(made)).toMatchObject({ t: 'created' });
    const w2 = made.id as string;
    await expect(win.locator('.ws-group .ws-name')).toHaveText(['Workspace 1', 'Workspace 2']);
    await expect(win.locator('.ws-group.is-active .ws-name')).toHaveText('Workspace 1');
    await expect.poll(() => workspacesOf(phone, project)?.places.map((p) => [p.name, p.id === w2])).toEqual([['Workspace 1', false], ['Workspace 2', true]]);
    const w1 = workspacesOf(phone, project)!.places[0]!.id;
    expect(workspacesOf(phone, project)!.active).toBe(w1);
    expect(workspacesOf(phone, project)!.members[terminal] ?? w1).toBe(w1);
    await look(win, `${SHOTS}/workspace-made.png`, { settle: 300 });

    // An activity in it while activities are off: the setting turns on (for every project, as its menu item does),
    // and "New activity" is made in Workspace 2, folded, nothing brought forward.
    const act = await phone.newActivity(project, w2);
    expect(act, JSON.stringify(act)).toMatchObject({ t: 'created' });
    const a = act.id as string;
    expect(await settingsOf(win)).toMatchObject({ wsActivities: true });
    const group = win.locator(`[data-ws-group="${w2}"]`);
    await group.locator('.ws-chev').click();
    const activity = group.locator(`[data-wsa-group="${a}"]`);
    await expect(activity.locator('.wsa-name')).toHaveText('New activity');
    await expect(win.locator('.ws-group.is-active .ws-name')).toHaveText('Workspace 1');
    await expect.poll(() => workspacesOf(phone, project)?.places.find((p) => p.id === a)).toMatchObject({ name: 'New activity', parent: w2 });
    expect(workspacesOf(phone, project)!.activities).toBe(true);

    // Both renamed.
    expect(await phone.renamePlace(project, w2, 'Release')).toMatchObject({ t: 'ok' });
    expect(await phone.renamePlace(project, a, 'QA pass')).toMatchObject({ t: 'ok' });
    await expect(group.locator('.ws-name')).toHaveText('Release');
    await expect(activity.locator('.wsa-name')).toHaveText('QA pass');
    await expect.poll(() => workspacesOf(phone, project)?.places.map((p) => p.name)).toEqual(['Workspace 1', 'Release', 'QA pass']);
    // A name that can't be one, and a place that isn't there: refused, nothing changes.
    expect(await phone.renamePlace(project, a, ' ')).toMatchObject({ t: 'error', code: 'invalid' });
    expect(await phone.renamePlace(project, 'wnothere', 'X')).toMatchObject({ t: 'error', code: 'not-found' });

    // The terminal moved into the activity, as dragging its row there does.
    expect(await phone.move(terminal, a)).toMatchObject({ t: 'ok' });
    await activity.locator('.wsa-chev').click();
    await expect(activity.locator(`[data-term-row="${terminal}"]`)).toBeVisible();
    await expect(win.locator(`[data-ws-group="${w1}"] [data-term-row="${terminal}"]`)).toHaveCount(0);
    await expect.poll(() => workspacesOf(phone, project)?.members[terminal]).toBe(a);
    await look(win, `${SHOTS}/moved.png`, { settle: 300 });

    // The project's window closed: the next change opens it, as opening a recent project does, and is applied there.
    await Promise.all([win.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())]);
    await phone.state((s) => projectOf(s, root)?.open === false, 15000);
    const [reopened, renamed] = await Promise.all([app.waitForEvent('window'), phone.renamePlace(project, a, 'Ship it')]);
    expect(renamed, JSON.stringify(renamed)).toMatchObject({ t: 'ok' });
    await expect(reopened.locator(`[data-wsa-group="${a}"] .wsa-name`)).toHaveText('Ship it', { timeout: 15000 });
    await expect(reopened.locator(`[data-wsa-group="${a}"] [data-term-row="${terminal}"]`)).toBeVisible();
    await expect.poll(() => workspacesOf(phone, project)?.places.find((p) => p.id === a)?.name).toBe('Ship it');
    await phone.state((s) => projectOf(s, root)?.open === true, 15000);
    await look(reopened, `${SHOTS}/reopened.png`, { settle: 300 });
  } finally {
    await close(l);
  }
});
