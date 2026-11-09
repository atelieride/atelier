import { describe, expect, test } from 'vitest';
import { compileWorld } from '../compile/index';
import { createDemo } from './index';

// The demo's Automations (site proposal 2026-10-19): the world's rules and runs, one working in billing-tests, and
// what the visitor can change without a connector.

const compiled = compileWorld();
const NOW = compiled.t0 + 86_400_000;
const make = () => createDemo(compiled, { version: '9.9.9', now: () => NOW });

describe('automations in the demo', () => {
  test('two rules of the store: one on (its next check due), one off; their runs, newest last', async () => {
    const { api } = make();
    const s = await api.automations.list();
    expect(s.automations.map((v) => [v.automation.name, v.status.kind])).toEqual([['Bug fixes from the sprint', 'on'], ['Docs pages from Notion', 'off']]);
    expect(s.automations.every((v) => v.automation.project === compiled.project.root)).toBe(true);
    expect(s.automations[0]!.status.nextPollAt! > NOW).toBe(true);
    expect(s.automations[0]!.runs.map((r) => [r.task.displayId, r.state])).toEqual([['ENG-128', 'skipped'], ['ENG-131', 'merged'], ['ENG-139', 'review'], ['ENG-142', 'working']]);
  });

  test('the working run is billing-tests\' session, the one for review onboarding-copy\'s (their strips show there)', async () => {
    const { api } = make();
    const id = async (name: string) => (await api.terminals.list()).find((t) => t.name === name)!.id;
    const runs = (await api.automations.list()).automations.flatMap((v) => v.runs);
    expect(runs.filter((r) => r.terminalId).map((r) => [r.task.displayId, r.terminalId])).toEqual([['ENG-139', await id('onboarding-copy')], ['ENG-142', await id('billing-tests')]]);
    expect(runs.every((r) => !('session' in r))).toBe(true);
  });

  test('on, off, stop, close and delete change the demo\'s copy, and every window hears of it', async () => {
    const { api } = make();
    const heard: number[] = [];
    api.on.automations((s) => heard.push(s.automations.length));
    expect((await api.automations.turnOn('au-docs', false)).automations[1]!.status.kind).toBe('on');
    expect((await api.automations.stopRun('run-eng-142')).automations[0]!.runs[3]).toMatchObject({ state: 'stopped', reason: 'Stopped by you' });
    const closed = await api.automations.closeRun('run-eng-139', true);
    expect(closed.outcome).toBe('ok');
    expect(closed.state.automations[0]!.runs[2]).toMatchObject({ state: 'closed', worktreeRemoved: true });
    expect((await api.automations.closeRun('run-eng-128', false)).outcome).toBe('error');
    expect((await api.automations.remove('au-docs')).automations).toHaveLength(1);
    expect(heard).toEqual([2, 2, 2, 1]); // the refused close changes nothing
  });

  test('a new automation is saved off, in the demo project; an edit keeps whether it is on', async () => {
    const { api } = make();
    const [first] = (await api.automations.list()).automations;
    const added = await api.automations.save({ ...first!.automation, id: 'au-new', name: 'New one', project: '/elsewhere', enabled: true });
    expect(added.automations[2]!.automation).toMatchObject({ name: 'New one', enabled: false, project: compiled.project.root });
    const edited = await api.automations.save({ ...first!.automation, name: 'Renamed', enabled: false });
    expect(edited.automations[0]!.automation).toMatchObject({ name: 'Renamed', enabled: true });
  });
});

describe('the editor in the demo: a connected ClickUp with one sprint', () => {
  const bugs = async () => (await make().api.automations.list()).automations[0]!.automation;

  test('ClickUp is connected as the visitor; Notion and Jira are not; its lists are offered', async () => {
    const { api } = make();
    const { connectors } = await api.connectors.list();
    expect(connectors.map((c) => [c.id, c.status])).toEqual([['clickup', 'connected'], ['notion', 'disconnected'], ['jira', 'disconnected']]);
    expect(connectors[0]).toMatchObject({ account: 'Ada Lovelace', workspace: 'Store' });
    expect((await api.automations.scopes('clickup')).map((s) => s.label)).toEqual(['Store › Engineering › Sprint 14', 'Store › Engineering › Backlog', 'Store › Design › Assets']);
    expect(await api.automations.scopes('notion')).toEqual([]);
  });

  test('Matching now plays the rule: what matches, and who "created by" leaves out', async () => {
    const { api } = make();
    const p = await api.automations.preview(await bugs());
    expect(p.matching.map((t) => t.displayId)).toEqual(['ENG-144']);
    expect(p.count).toBe(1);
    expect(p.leftOut.map((x) => [x.task.displayId, x.reason])).toEqual([['ENG-145', 'Created by Grace Hopper'], ['ENG-147', 'Created by Alan Turing']]);
  });

  test('the chips\' suggestions: the sprint\'s statuses (closed ones left out), its tags, its people but the visitor', async () => {
    const { api } = make();
    const v = (await api.automations.preview({ ...(await bugs()), conditions: [] })).values!;
    expect(v.status.map((s) => [s.name, s.count])).toEqual([['Ready for AI', 3], ['in progress', 1], ['review', 1], ['to do', 1], ['blocked', 0]]);
    expect(v.status.find((s) => s.name === 'Ready for AI')!.color).toBe('#7b68ee');
    expect(v.tag.map((g) => g.name)).toEqual(['bug', 'billing', 'feature', 'search', 'ux']);
    expect(v.people.map((x) => x.name)).toEqual(['Alan Turing', 'Grace Hopper']);
  });

  test('another list has no tasks; a source that isn\'t connected says so', async () => {
    const { api } = make();
    const a = await bugs();
    expect(await api.automations.preview({ ...a, source: { connector: 'clickup', scopes: ['901500000316'] } })).toMatchObject({ matching: [], count: 0, leftOut: [] });
    expect((await api.automations.preview({ ...a, source: { connector: 'notion', scopes: ['x'] } })).error).toBe('Notion isn\'t connected');
  });

  test('the palette lists the visitor\'s own open tasks, and a task opens with its text', async () => {
    const { api } = make();
    const [list] = await api.tasks.list();
    expect(list).toMatchObject({ source: 'clickup', status: 'connected', loading: false });
    expect(list!.tasks.map((t) => t.displayId)).toEqual(['ENG-142', 'ENG-144', 'ENG-139', 'ENG-147']);
    const got = await api.tasks.get('clickup', '86c1e0144');
    expect(got.ok && got.task.body).toBe('"creme" should find "crème brûlée".');
    expect((await api.tasks.search('clickup', 'gift')).map((t) => t.displayId)).toEqual(['ENG-147']);
    expect(await api.tasks.get('notion', '86c1e0144')).toEqual({ ok: false, reason: 'not-connected' });
  });
});
