import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorInfo, TaskGetResult, TaskList } from '../../src/shared/tasks';
import { e2eEnv } from './env';
import { READ_TOOLS, startFake } from './fake-clickup-cli';
import { NOTION_READ_TOOLS, startFakeNotionCli } from './fake-notion-cli';

// Wiring smoke for the ClickUp connector, no UI: the real app, Electron's net transport, the
// preload bridge and the IPC, against the local fake ClickUp. Main follows the authorize page itself
// (ATELIER_TEST_FOLLOW_AUTH: no browser opens) and safeStorage is the test stand-in (never the Keychain).
// The Settings › Connectors UI has its own e2e (connectors.spec.ts).

type Api = {
  connectors: {
    list(): Promise<{ connectors: ConnectorInfo[]; notices: unknown[] }>;
    connect(id: 'clickup'): Promise<ConnectorInfo>;
    disconnect(id: 'clickup'): Promise<ConnectorInfo>;
    openTask(source: 'clickup', id: string): Promise<boolean>;
  };
  tasks: { list(): Promise<TaskList[]>; get(source: 'clickup', id: string): Promise<TaskGetResult> };
  settings: { set(patch: { openTasksInApp: boolean }): Promise<unknown> };
};

test('connectors wiring: connect through main, tasks over IPC, open a task through main, disconnect', async () => {
  const fake = await startFake();
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  const { env, home } = e2eEnv({ ATELIER_TEST_CLICKUP_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1', ATELIER_TEST_URL_LOG: urlLog, ATELIER_TEST_APP_SCHEMES: 'clickup' });
  const app = await electron.launch({ args: ['out/main/index.js'], env });
  try {
    const win = await app.firstWindow();
    const api = <T>(fn: (a: Api) => Promise<T>) => win.evaluate(`(${fn.toString()})(window.atelier)`) as Promise<T>;
    await expect.poll(() => api((a) => a.connectors.list().then((r) => r.connectors[0]?.status))).toBe('disconnected');

    await api((a) => a.connectors.connect('clickup'));
    await expect.poll(() => api((a) => a.connectors.list().then((r) => r.connectors[0]?.status)), { timeout: 15000 }).toBe('connected');
    const card = await api((a) => a.connectors.list().then((r) => r.connectors[0]!));
    expect(card).toMatchObject({ account: 'Ada Fake', workspace: 'Fakeworks' });

    const lists = await api((a) => a.tasks.list());
    expect(lists[0]!.tasks.map((t) => t.displayId)).toContain('ENG-101');
    const detail = await api((a) => a.tasks.get('clickup', '86fk0001a'));
    expect(detail.ok).toBe(true);
    expect(await api((a) => a.tasks.get('clickup', '86fkgone0'))).toEqual({ ok: false, reason: 'gone' });

    // ClickUp's desktop app "installed" (ATELIER_TEST_APP_SCHEMES): the task opens there, not in the browser…
    expect(await api((a) => a.connectors.openTask('clickup', '86fk0001a'))).toBe(true);
    expect(readFileSync(urlLog, 'utf8').trim().split('\n')).toEqual(['clickup://t/86fk0001a']);
    // …unless Settings › Connectors says otherwise: then the browser.
    await api((a) => a.settings.set({ openTasksInApp: false }));
    expect(await api((a) => a.connectors.openTask('clickup', '86fk0001a'))).toBe(true);
    const log = readFileSync(urlLog, 'utf8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^https:\/\/app\.clickup\.com\/t\/.*86fk0001a$/);
    // The authorize page was followed by main, never opened in a browser.
    expect(log).not.toContain('/oauth/authorize');

    const blob = join(home, 'connectors', 'clickup.bin');
    expect(existsSync(blob)).toBe(true);
    expect(readFileSync(blob, 'utf8')).not.toContain('fkat_');
    await api((a) => a.connectors.disconnect('clickup'));
    expect(existsSync(blob)).toBe(false);
    const calls = await fake.calls();
    expect(calls).toContain('clickup_filter_tasks');
    expect(calls.filter((n) => !READ_TOOLS.includes(n))).toEqual([]);
  } finally {
    await app.close();
    fake.close();
  }
});

// A Notion task opens in Notion's desktop app (`notion://www.notion.so/<id>`) when one is
// "installed" (ATELIER_TEST_APP_SCHEMES) and Settings › Connectors › Notion says so; the browser otherwise.
test('a Notion task opens in the Notion app, or in the browser when the setting is off', async () => {
  test.setTimeout(60_000);
  const notion = await startFakeNotionCli();
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  const { env } = e2eEnv({ ATELIER_TEST_NOTION_URL: notion.url, ATELIER_TEST_FOLLOW_AUTH: '1', ATELIER_TEST_URL_LOG: urlLog, ATELIER_TEST_APP_SCHEMES: 'notion' });
  const app = await electron.launch({ args: ['out/main/index.js'], env });
  const SPRINT = '00000006000040008000000000000006';
  const RATE = '0000000f00004000800000000000000f';
  try {
    const win = await app.firstWindow();
    const status = () => (win.evaluate(`window.atelier.connectors.list()`) as Promise<{ connectors: ConnectorInfo[] }>).then((r) => r.connectors.find((c) => c.id === 'notion')?.status);
    await win.evaluate(`window.atelier.connectors.connect('notion')`);
    await expect.poll(status, { timeout: 15000 }).toBe('connected');
    expect(await win.evaluate(`window.atelier.connectors.addSource('notion', '${SPRINT}')`)).toMatchObject({ ok: true });
    await expect.poll(async () => ((await win.evaluate('window.atelier.tasks.list()')) as TaskList[])
      .find((l) => l.source === 'notion')?.tasks.some((t) => t.id === RATE), { timeout: 15000 }).toBe(true);

    expect(await win.evaluate(`window.atelier.connectors.openTask('notion', '${RATE}')`)).toBe(true);
    expect(readFileSync(urlLog, 'utf8').trim().split('\n')).toEqual([`notion://www.notion.so/${RATE}`]);
    await win.evaluate(`window.atelier.settings.set({ openNotionTasksInApp: false })`);
    expect(await win.evaluate(`window.atelier.connectors.openTask('notion', '${RATE}')`)).toBe(true);
    const lines = readFileSync(urlLog, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^https://(www\\.notion\\.so|app\\.notion\\.com)/.*${RATE}$`));
  } finally {
    await app.close();
    notion.close();
  }
});

// Each connector's network goes only to its own endpoint (the fakes here, never the real servers), and each one's session
// filters requests with its own allowlist: with one shared session the last filter installed would win and the other
// connector's origin would be cancelled. Both connect in ONE run, ClickUp first (so its session exists before Notion's
// is created). (The registry's order, ClickUp, Notion then Jira: connectors-list.spec.ts.)
test("ClickUp and Notion both connect in one run, each through its own session; Notion's network goes only to its endpoint", async () => {
  test.setTimeout(60_000);
  const notion = await startFakeNotionCli();
  const clickup = await startFake();
  const { env } = e2eEnv({ ATELIER_TEST_NOTION_URL: notion.url, ATELIER_TEST_CLICKUP_URL: clickup.url, ATELIER_TEST_FOLLOW_AUTH: '1' });
  const app = await electron.launch({ args: ['out/main/index.js'], env });
  try {
    const win = await app.firstWindow();
    const statusOf = (id: string) => (win.evaluate(`window.atelier.connectors.list()`) as Promise<{ connectors: ConnectorInfo[] }>)
      .then((r) => r.connectors.find((c) => c.id === id)?.status);
    await win.evaluate(`window.atelier.connectors.connect('clickup')`);
    await expect.poll(() => statusOf('clickup'), { timeout: 15000 }).toBe('connected');
    // ClickUp's first fetch done: from now on nothing should reach its fake but its own refresh below.
    await expect.poll(async () => ((await win.evaluate(`window.atelier.tasks.list()`)) as TaskList[]).some((l) => l.tasks.some((t) => t.displayId === 'ENG-101'))).toBe(true);
    const clickupHits = await clickup.hits();
    await win.evaluate(`window.atelier.connectors.connect('notion')`);
    await expect.poll(() => statusOf('notion'), { timeout: 15000 }).toBe('connected');
    // Connected, no database chosen yet: the sources step ("Choose databases"). Notion's sign-in and calls reached the
    // Notion fake only; ClickUp's fake got no request from them, on any path.
    const cards = (await (win.evaluate(`window.atelier.connectors.list()`) as Promise<{ connectors: ConnectorInfo[] }>)).connectors;
    expect(cards.find((c) => c.id === 'notion')).toMatchObject({ sources: [] });
    expect(await clickup.hits()).toBe(clickupHits);
    // ClickUp still reaches its own origin after Notion's session came up (a fresh refresh must hit its fake again),
    // and Notion's calls went to its own fake.
    const before = (await clickup.calls()).length;
    await win.evaluate(`window.atelier.connectors.refresh('clickup')`);
    await expect.poll(async () => (await clickup.calls()).length, { timeout: 15000 }).toBeGreaterThan(before);
    expect(await statusOf('clickup')).toBe('connected');
    const lists = (await win.evaluate(`window.atelier.tasks.list()`)) as TaskList[];
    expect(lists.some((l) => l.tasks.some((t) => t.displayId === 'ENG-101'))).toBe(true);
    expect(await clickup.calls()).toContain('clickup_filter_tasks');
    expect((await notion.calls()).length).toBeGreaterThan(0);
    expect((await notion.calls()).filter((n) => !NOTION_READ_TOOLS.includes(n))).toEqual([]);
    await win.evaluate(`window.atelier.connectors.disconnect('notion')`);
    await expect.poll(() => statusOf('notion')).toBe('disconnected');
    expect(await statusOf('clickup')).toBe('connected');
  } finally {
    await app.close();
    notion.close();
    clickup.close();
  }
});
