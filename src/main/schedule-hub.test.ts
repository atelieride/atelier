import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { ScheduleHub, type ScheduleClient, type ScheduleHost } from './schedule-hub';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';

const T0 = new Date(2026, 9, 25, 14, 30).getTime();
const p = (o: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
  id: 'p1', terminalId: 't1', sessionId: 's1', projectRoot: '/w', title: 'api', text: 'x', at: T0, ifBusy: 'wait',
  createdAt: 0, status: 'pending', ...o
});

class FakeClient extends EventEmitter implements ScheduleClient {
  caps = new Set(['schedules']);
  sent: unknown[] = [];
  reply: (msg: { t: string }) => unknown = () => p();
  hasCapability(c: string) { return this.caps.has(c); }
  async request<T>(msg: unknown): Promise<T> {
    this.sent.push(typeof msg === 'function' ? (msg as () => unknown)() : msg);
    return this.reply(msg as { t: string }) as T;
  }
}

function setup() {
  const client = new FakeClient();
  const out = { broadcast: [] as unknown[], project: [] as [string, unknown][], banners: [] as unknown[], focused: new Set<string>() };
  const host: ScheduleHost = {
    broadcast: (_ch, payload) => out.broadcast.push(payload),
    toProject: (project, _ch, payload) => out.project.push([project, payload]),
    projectFocused: (project) => out.focused.has(project),
    terminalProject: (id) => (id === 't1' ? '/w' : id === 't2' ? '/other' : null),
    banner: (b) => out.banners.push(b)
  };
  const hub = new ScheduleHub(client, host, { now: () => T0, platform: 'darwin' });
  return { client, hub, out };
}

describe('ScheduleHub', () => {
  test('forwards every list to every window and keeps it for new ones', () => {
    const { client, hub, out } = setup();
    client.emit('schedules', [p()]);
    expect(out.broadcast).toEqual([[p()]]);
    expect(hub.list()).toEqual([p()]);
  });
  test('without the capability: nothing listed, requests refused as unavailable', async () => {
    const { client, hub } = setup();
    client.caps.clear();
    client.emit('schedules', [p()]);
    expect(hub.list()).toEqual([]);
    expect(await hub.add('/w', { terminalId: 't1', text: 'x', at: T0, ifBusy: 'wait' })).toEqual({ ok: false, error: 'unavailable' });
    expect(client.sent).toEqual([]);
  });
  test('add only into a terminal of the window\'s project; refusals come back as errors', async () => {
    const { client, hub } = setup();
    expect(await hub.add('/w', { terminalId: 't2', text: 'x', at: T0, ifBusy: 'wait' })).toEqual({ ok: false, error: 'unknown terminal' });
    expect(await hub.add('/w', { terminalId: 't1', text: 'x', at: T0, ifBusy: 'wait' })).toEqual({ ok: true, prompt: p() });
    expect(client.sent).toEqual([{ t: 'schedAdd', terminalId: 't1', text: 'x', at: T0, ifBusy: 'wait' }]);
    client.reply = () => { throw new Error('time taken'); };
    expect(await hub.add('/w', { terminalId: 't1', text: 'x', at: T0, ifBusy: 'wait' })).toEqual({ ok: false, error: 'time taken' });
  });
  test('update, remove, fire and snooze only for prompts of the window\'s project', async () => {
    const { client, hub } = setup();
    client.emit('schedules', [p(), p({ id: 'p2', projectRoot: '/other' })]);
    expect(await hub.remove('/w', 'p2')).toEqual({ ok: false, error: 'unknown prompt' });
    expect(await hub.remove('/w', 'p1')).toEqual({ ok: true });
    expect(await hub.fire('/w', 'p1', 'usage')).toEqual({ ok: true });
    expect(await hub.snooze('/w', 'p1', 10)).toEqual({ ok: true });
    expect(await hub.update('/w', { id: 'p1', text: 'y' })).toMatchObject({ ok: true });
    expect(client.sent).toEqual([
      { t: 'schedRemove', id: 'p1' }, { t: 'schedFire', id: 'p1', force: 'usage' }, { t: 'schedSnooze', id: 'p1', minutes: 10 }, { t: 'schedUpdate', id: 'p1', text: 'y' }
    ]);
    expect(await hub.restore('/w', p({ id: 'p9', projectRoot: '/other' }))).toEqual({ ok: false, error: 'unknown prompt' });
    // A prompt of this project pointed at another project's live terminal.
    expect(await hub.restore('/w', p({ id: 'p9', terminalId: 't2' }))).toEqual({ ok: false, error: 'unknown prompt' });
  });
  test('a prompt that arms with no focused window of its project is fired at once; with one, the window counts down', () => {
    const { client, out } = setup();
    client.emit('schedules', [p(), p({ id: 'p2' })]);
    client.emit('schedules', [p({ status: 'armed', armedUntil: T0 + 10_000 }), p({ id: 'p2' })]);
    expect(client.sent).toEqual([{ t: 'schedFire', id: 'p1' }]);
    out.focused.add('/w');
    client.emit('schedules', [p({ status: 'armed', armedUntil: T0 + 10_000 }), p({ id: 'p2', status: 'armed', armedUntil: T0 + 10_000 })]);
    expect(client.sent).toHaveLength(1);
  });
  test('a pasted prompt (armed until now) is never fired again', () => {
    const { client } = setup();
    client.emit('schedules', [p()]);
    client.emit('schedules', [p({ status: 'armed', armedUntil: T0 })]);
    expect(client.sent).toEqual([]);
  });
  test('news: a toast to the project\'s windows, a banner when none of them is focused', () => {
    const { client, out } = setup();
    client.emit('schedules', [p(), p({ id: 'p2' })]);
    client.emit('schedules', [p({ status: 'sent' }), p({ id: 'p2', status: 'missed', reason: 'asleep' })]);
    expect(out.project.map(([root, n]) => [root, (n as { kind: string }).kind])).toEqual([['/w', 'sent'], ['/w', 'missed']]);
    expect(out.banners).toEqual([
      { title: 'api', body: 'Sent your 14:30 prompt', terminalId: 't1', projectRoot: '/w' },
      { title: 'api', body: 'Not sent at 14:30: the Mac was asleep', terminalId: 't1', projectRoot: '/w' }
    ]);
    out.focused.add('/w');
    client.emit('schedules', [p({ status: 'sent' }), p({ id: 'p2', status: 'missed', reason: 'asleep' }), p({ id: 'p3' })]);
    client.emit('schedules', [p({ status: 'sent' }), p({ id: 'p2', status: 'missed', reason: 'asleep' }), p({ id: 'p3', at: T0 + 86_400_000 + 60_000, movedFrom: T0, reason: 'limit' })]);
    expect(out.banners).toHaveLength(2);
    expect(out.project.at(-1)).toMatchObject(['/w', { kind: 'moved' }]);
  });
  test('banner copy for moves and skips', () => {
    const { client, out } = setup();
    client.emit('schedules', [p(), p({ id: 'p2' })]);
    client.emit('schedules', [p({ at: T0 + 86_400_000 + 60_000, movedFrom: T0, reason: 'limit' }), p({ id: 'p2', status: 'skipped', reason: 'busy' })]);
    expect(out.banners.map((b) => (b as { body: string }).body)).toEqual(['Usage limit: moved to Mon 14:31', 'Skipped your 14:30 prompt: Claude was working']);
  });
});
