import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { expectMode } from '../../tests/support/platform';
import { ScheduleBook, type PromptState, type SchedulePort } from './schedules';
import { ARM_MS, ENTER_CAP_MS, ENTER_FLOOR_MS, GRACE_MS, MAX_ENTRIES, type ScheduledPrompt } from '@shared/scheduled-prompts';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, Usage } from '@shared/session';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 25, 12, 0);

const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...o
});
const term = (o: Partial<TerminalInfo> = {}, s: Partial<SessionInfo> | null = {}): TerminalInfo => ({
  id: 't1', projectRoot: '/w/proj', cwd: '/w/proj', title: 'api', name: null, color: '#fff', foreground: '2.1.300',
  createdAt: 0, session: s === null ? null : session(s), configDir: '/u/.claude', ...o
});

class FakePort implements SchedulePort {
  terms: TerminalInfo[] = [term()];
  states = new Map<string, PromptState>();
  writes: [string, string][] = [];
  usage: Usage | null = null;
  connected = true;
  terminals() { return this.terms; }
  promptState(id: string): PromptState | null {
    if (!this.terms.some((t) => t.id === id)) return null;
    return this.states.get(id) ?? { bracketed: true, draft: false, lastInputAt: 0, lastOutputAt: 0 };
  }
  write(id: string, data: string) { if (!this.terms.some((t) => t.id === id)) return false; this.writes.push([id, data]); return true; }
  usageFor() { return this.usage; }
  clients() { return this.connected; }
}

function setup(o: { file?: string } = {}) {
  let now = T0 - 30 * MIN;
  const port = new FakePort();
  let n = 0;
  const book = new ScheduleBook(port, { now: () => now, uuid: () => `p${++n}`, file: o.file });
  const changes: ScheduledPrompt[][] = [];
  book.on('changed', (l: ScheduledPrompt[]) => changes.push(l));
  return { port, book, changes, at: (t: number) => { now = t; }, now: () => now };
}

const one = (book: ScheduleBook) => book.list()[0]!;

describe('ScheduleBook requests', () => {
  test('add: a prompt for a Claude session, on its minute, with the session it belongs to', () => {
    const { book, changes } = setup();
    const p = book.add({ terminalId: 't1', text: 'run the tests', at: T0 + 30_000, ifBusy: 'wait' });
    expect(p).toMatchObject({ id: 'p1', terminalId: 't1', sessionId: 's1', projectRoot: '/w/proj', title: 'api', at: T0, status: 'pending', ifBusy: 'wait' });
    expect(changes).toHaveLength(1);
  });
  test('add refuses an unknown terminal, a plain terminal, a taken minute and a past one', () => {
    const { book, port } = setup();
    port.terms.push(term({ id: 't2' }, null));
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    expect(() => book.add({ terminalId: 'nope', text: 'a', at: T0, ifBusy: 'wait' })).toThrow('unknown terminal');
    expect(() => book.add({ terminalId: 't2', text: 'a', at: T0, ifBusy: 'wait' })).toThrow('not a Claude session');
    expect(() => book.add({ terminalId: 't1', text: 'b', at: T0 + 10_000, ifBusy: 'wait' })).toThrow('time taken');
    expect(() => book.add({ terminalId: 't1', text: 'b', at: T0 - 31 * MIN, ifBusy: 'wait' })).toThrow('time passed');
    // The current minute is still fine: it goes at once.
    expect(book.add({ terminalId: 't1', text: 'now', at: T0 - 30 * MIN, ifBusy: 'wait' }).status).toBe('pending');
  });
  test('update changes text and time (re-checked), and a missed prompt with a new time is pending again', () => {
    const { book, at } = setup();
    const a = book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    book.add({ terminalId: 't1', text: 'b', at: T0 + 5 * MIN, ifBusy: 'wait' });
    expect(() => book.update({ id: a.id, at: T0 + 5 * MIN })).toThrow('time taken');
    expect(book.update({ id: a.id, text: 'a2', at: T0 + 10 * MIN, ifBusy: 'skip' })).toMatchObject({ text: 'a2', at: T0 + 10 * MIN, ifBusy: 'skip' });
    at(T0 + 10 * MIN + GRACE_MS + 1);
    book.tick();
    expect(book.list().find((x) => x.id === a.id)!.status).toBe('missed');
    expect(book.update({ id: a.id, at: T0 + 60 * MIN }).status).toBe('pending');
    expect(() => book.update({ id: 'zz', text: 'x' })).toThrow('unknown prompt');
  });
  test('remove, then restore puts it back as it was', () => {
    const { book } = setup();
    const a = book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    book.remove(a.id);
    expect(book.list()).toEqual([]);
    expect(book.restore(a)).toEqual(a);
    expect(() => book.restore(a)).toThrow('already there');
  });
  test('restore keeps a prompt in its own project and session, and never comes back fired or armed', () => {
    const { book, port } = setup();
    const a = book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    book.remove(a.id);
    port.terms.push(term({ id: 't2', projectRoot: '/other' }, { sessionId: 's2' }));
    expect(() => book.restore({ ...a, terminalId: 't2' })).toThrow('unknown terminal');
    expect(() => book.restore({ ...a, projectRoot: '/other' })).toThrow('unknown terminal');
    expect(book.restore({ ...a, status: 'armed', armedUntil: T0, fired: true, forceUsage: true })).toEqual(a);
  });
  test('add refuses past the cap of live prompts', () => {
    const { book } = setup();
    for (let i = 0; i < MAX_ENTRIES; i++) book.add({ terminalId: 't1', text: `p${i}`, at: T0 + i * MIN, ifBusy: 'wait' });
    expect(() => book.add({ terminalId: 't1', text: 'one more', at: T0 + 9999 * MIN, ifBusy: 'wait' })).toThrow('too many');
  });
  test('snooze moves it by minutes past any clash', () => {
    const { book, at } = setup();
    const a = book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    book.add({ terminalId: 't1', text: 'b', at: T0 + 10 * MIN, ifBusy: 'wait' });
    at(T0);
    book.snooze(a.id, 10);
    expect(one(book).at).toBe(T0 + 11 * MIN);
    expect(one(book).status).toBe('pending');
  });
});

describe('ScheduleBook at the time', () => {
  test('free with an app connected: armed for the countdown, then pasted and sent after the screen settles', () => {
    const { book, port, at } = setup();
    book.add({ terminalId: 't1', text: 'line one\nline two', at: T0, ifBusy: 'wait' });
    at(T0);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'armed', armedUntil: T0 + ARM_MS, dueSince: T0 });
    expect(port.writes).toEqual([]);
    at(T0 + ARM_MS);
    book.tick();
    expect(port.writes).toEqual([['t1', '\x1b[200~'], ['t1', 'line one\rline two'], ['t1', '\x1b[201~']]);
    expect(book.sending()).toBe(true);
    // The Enter: not before the floor, then once the screen is quiet.
    port.states.set('t1', { bracketed: true, draft: false, lastInputAt: 0, lastOutputAt: T0 + ARM_MS + 200 });
    at(T0 + ARM_MS + 200);
    book.pump();
    expect(port.writes).toHaveLength(3);
    at(T0 + ARM_MS + 200 + ENTER_FLOOR_MS);
    book.pump();
    expect(port.writes.at(-1)).toEqual(['t1', '\r']);
    expect(one(book)).toMatchObject({ status: 'sent', doneAt: T0 + ARM_MS + 450 });
    expect(book.sending()).toBe(false);
  });
  test('the Enter goes at the cap even if the screen keeps moving', () => {
    const { book, port, at } = setup();
    port.connected = false;
    book.add({ terminalId: 't1', text: 'x', at: T0, ifBusy: 'wait' });
    at(T0);
    book.tick();
    expect(port.writes).toHaveLength(3);
    port.states.set('t1', { bracketed: true, draft: false, lastInputAt: 0, lastOutputAt: T0 + ENTER_CAP_MS });
    at(T0 + ENTER_CAP_MS);
    book.pump();
    expect(port.writes.at(-1)).toEqual(['t1', '\r']);
  });
  test('Claude working: waits with the reason, sends when free; a second prompt waits for the gap after a send', () => {
    const { book, port, at } = setup();
    port.connected = false;
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    book.add({ terminalId: 't1', text: 'b', at: T0 + MIN, ifBusy: 'wait' });
    port.terms = [term({}, { state: 'running' })];
    at(T0 + 2 * MIN);
    book.tick();
    expect(book.list().map((x) => [x.status, x.reason])).toEqual([['pending', 'busy'], ['pending', 'busy']]);
    port.terms = [term()];
    book.tick();
    at(T0 + 2 * MIN + ENTER_CAP_MS);
    book.pump();
    book.tick();
    expect(book.list().map((x) => x.status)).toEqual(['sent', 'pending']);
    expect(port.writes.filter(([, d]) => d === '\r')).toHaveLength(1);
  });
  test('skip: a busy Claude skips it', () => {
    const { book, port, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'skip' });
    port.terms = [term({}, { state: 'running' })];
    at(T0);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'skipped', reason: 'busy', doneAt: T0 });
  });
  test('usage at its limit: moved to the reset + 1 min, past a clash; Send Anyway skips the gate once', () => {
    const { book, port, at } = setup();
    port.connected = false;
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    book.add({ terminalId: 't1', text: 'b', at: T0 + 41 * MIN, ifBusy: 'wait' });
    port.usage = { fiveHour: { pct: 100, resetsAt: (T0 + 40 * MIN) / 1000 }, sevenDay: null, updatedAt: 0 };
    at(T0);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'pending', at: T0 + 42 * MIN, movedFrom: T0, reason: 'limit' });
    book.fire('p1', 'usage');
    expect(port.writes).toHaveLength(3);
  });
  test('Claude stops it for a limit right after the send: it stays sent, never retried (Claude Code continues it)', () => {
    const { book, port, at } = setup();
    port.connected = false;
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    at(T0);
    book.tick();
    at(T0 + ENTER_CAP_MS);
    book.pump();
    expect(one(book).status).toBe('sent');
    port.terms = [term({}, { state: 'error', errorReason: 'rate_limit', updatedAt: T0 + 5000 })];
    port.usage = { fiveHour: { pct: 100, resetsAt: (T0 + 90 * MIN) / 1000 }, sevenDay: null, updatedAt: 0 };
    at(T0 + 6000);
    book.tick();
    expect(one(book).status).toBe('sent');
    expect(one(book).at).toBe(T0);
    expect(one(book)).not.toHaveProperty('limitRetried');
    expect(one(book)).not.toHaveProperty('reason');
  });
  test('Mac asleep past the grace: missed, never sent; Send Now sends it', () => {
    const { book, port, at } = setup();
    port.connected = false;
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    at(T0 + GRACE_MS + MIN);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'missed', reason: 'asleep' });
    expect(port.writes).toEqual([]);
    book.fire('p1');
    expect(one(book).status).toBe('armed');
    expect(port.writes).toHaveLength(3);
  });
  test('Send Now while Claude works: sent as soon as it is free, with no countdown', () => {
    const { book, port, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    port.terms = [term({}, { state: 'running' })];
    book.fire('p1');
    expect(one(book)).toMatchObject({ status: 'pending', reason: 'busy', fired: true });
    port.terms = [term()];
    at(T0 - 29 * MIN);
    book.tick();
    expect(port.writes).toHaveLength(3);
  });
  test('the session resumed in a new terminal: the prompt follows it', () => {
    const { book, port, at } = setup();
    port.connected = false;
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    port.terms = [term({ id: 't9' })];
    at(T0);
    book.tick();
    expect(one(book).terminalId).toBe('t9');
    expect(port.writes[0]![0]).toBe('t9');
  });
  test('terminal gone: waits for a resume, then missed closed', () => {
    const { book, port, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    port.terms = [];
    at(T0);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'pending', reason: 'closed' });
    at(T0 + GRACE_MS + 1);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'missed', reason: 'closed' });
  });
  test('typing while armed takes it back to waiting', () => {
    const { book, port, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    at(T0);
    book.tick();
    port.states.set('t1', { bracketed: true, draft: false, lastInputAt: T0 + 1000, lastOutputAt: 0 });
    at(T0 + 2000);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'pending', reason: 'typing' });
    expect(one(book).armedUntil).toBeUndefined();
  });
  test('no change, no event', () => {
    const { book, changes, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    at(T0 - 10 * MIN);
    book.tick();
    book.tick();
    expect(changes).toHaveLength(1);
  });
});

describe('ScheduleBook review fixes', () => {
  test('#1 a countdown that runs out on its own says so: the paste is a change, so the host starts the pump', () => {
    const { book, changes, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    at(T0);
    book.tick();
    const n = changes.length;
    at(T0 + ARM_MS);
    book.tick();
    expect(book.sending()).toBe(true);
    expect(changes.length).toBe(n + 1);
  });
  test('#2 edit, Not Now and delete wait while a prompt is pasted and waits for its Enter', () => {
    const { book, port, at } = setup();
    port.connected = false;
    const a = book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    at(T0);
    book.tick();
    expect(book.sending()).toBe(true);
    expect(() => book.update({ id: a.id, text: 'b' })).toThrow('sending');
    expect(() => book.snooze(a.id, 10)).toThrow('sending');
    expect(() => book.remove(a.id)).toThrow('sending');
    at(T0 + ENTER_CAP_MS);
    book.pump();
    expect(one(book).status).toBe('sent');
  });
  test('#5 a prompt follows its session only within its own project', () => {
    const { book, port, at } = setup();
    port.connected = false;
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    port.terms = [term({ id: 't9', projectRoot: '/other' })];
    at(T0);
    book.tick();
    expect(one(book)).toMatchObject({ terminalId: 't1', status: 'pending', reason: 'closed' });
    expect(port.writes).toEqual([]);
    const gone = book.list()[0]!;
    book.remove(gone.id);
    expect(() => book.restore({ ...gone, terminalId: 'dead' })).toThrow('unknown terminal');
  });
  test('#6 a prompt armed (or held by typing) when the Mac went to sleep is missed after the grace, never sent late', () => {
    const { book, at, port } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    at(T0);
    book.tick();
    expect(one(book).status).toBe('armed');
    at(T0 + 9 * 3600_000);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'missed', reason: 'asleep' });
    expect(port.writes).toEqual([]);
  });
  test('#6 a prompt waiting for a busy Claude keeps waiting across a sleep', () => {
    const { book, port, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    port.terms = [term({}, { state: 'running' })];
    at(T0);
    book.tick();
    at(T0 + 9 * 3600_000);
    book.tick();
    expect(one(book)).toMatchObject({ status: 'pending', reason: 'busy' });
  });
  test('#7 Send Now keeps the scheduled time', () => {
    const { book, port, at } = setup();
    book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    port.terms = [term({}, { state: 'running' })];
    at(T0 - 20 * MIN);
    book.fire('p1');
    expect(one(book)).toMatchObject({ at: T0, fired: true });
  });
  test('restore keeps the cap of live prompts', () => {
    const { book } = setup();
    const first = book.add({ terminalId: 't1', text: 'x', at: T0 - 30 * MIN, ifBusy: 'wait' });
    book.remove(first.id);
    for (let i = 0; i < MAX_ENTRIES; i++) book.add({ terminalId: 't1', text: `p${i}`, at: T0 + i * MIN, ifBusy: 'wait' });
    expect(() => book.restore(first)).toThrow('too many');
  });
});

describe('ScheduleBook on disk', () => {
  test('saved 0600 and loaded back; an armed prompt comes back pending; a broken file is an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atl-sched-'));
    const file = join(dir, 'schedules.json');
    const a = setup({ file });
    a.book.add({ terminalId: 't1', text: 'a', at: T0, ifBusy: 'wait' });
    a.at(T0);
    a.book.tick();
    expect(one(a.book).status).toBe('armed');
    a.book.save();
    expectMode(file, 0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe(1);
    const b = setup({ file });
    expect(one(b.book)).toMatchObject({ id: 'p1', status: 'pending' });
    expect(one(b.book).armedUntil).toBeUndefined();
    writeFileSync(file, '{oops');
    expect(setup({ file }).book.list()).toEqual([]);
  });
});
