import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { MAX_NOTICE_BYTES, PUSH_EVERY_MS, PushDecider, collapseKeyOf, noticeJson, type PushNotice } from './push';
import { projectIdOf } from './state';

const session = (o: Partial<SessionInfo>): SessionInfo => ({ sessionId: 's', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...o });
const term = (id: string, title: string, s: Partial<SessionInfo>, root = '/work/atelier'): TerminalInfo => ({ id, projectRoot: root, cwd: root, title, name: null, color: '#B794F6', foreground: 'claude', createdAt: 0, session: session(s) });
const waiting = (id: string, title = `Session ${id}`) => term(id, title, { state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test' });
const done = (id: string, title = `Session ${id}`) => term(id, title, { state: 'done' });
const failed = (id: string, title = `Session ${id}`) => term(id, title, { state: 'error', errorReason: 'overloaded', activity: 'overloaded' });

function setup(o: { settings?: Partial<Settings>; away?: boolean } = {}) {
  let now = 1_000_000;
  let away = o.away ?? true;
  const settings: Settings = { ...DEFAULT_SETTINGS, remoteAccess: true, ...o.settings };
  const d = new PushDecider({ settings: () => settings, away: () => away, now: () => now });
  return { d, tick: (ms: number) => { now += ms; }, setAway: (v: boolean) => { away = v; }, now: () => now };
}

test('a session waiting: title = the session, subtitle = the project, body = the Mac\'s words, its project id and terminal id', () => {
  const { d, now } = setup();
  expect(d.decide({ waiting: [waiting('t1', 'Refactor auth')], done: [], error: [] })).toEqual([
    { v: 1, kind: 'waiting', title: 'Refactor auth', subtitle: 'atelier', body: 'Needs permission · Bash npm test', project: projectIdOf('/work/atelier'), id: 't1', at: now() }
  ]);
});

test('finished and stopped with an error, in the Mac\'s words; three or more finishing together are one notice, like the Mac\'s', () => {
  const { d } = setup();
  expect(d.decide({ waiting: [], done: [done('d1', 'Docs')], error: [failed('e1', 'Build')] }).map((n) => [n.kind, n.title, n.body])).toEqual([
    ['done', 'Docs', 'Finished'], ['error', 'Build', 'Stopped with an error · Overloaded']
  ]);
  const many = d.decide({ waiting: [], done: [done('a', 'A'), done('b', 'B'), done('c', 'C')], error: [] });
  expect(many).toHaveLength(1);
  expect(many[0]).toMatchObject({ kind: 'done', title: '3 sessions finished', body: 'A, B, C', id: 'a' });
  // Waiting sessions stay one notice each: each asks for something.
  expect(d.decide({ waiting: [waiting('w1'), waiting('w2'), waiting('w3')], done: [], error: [] })).toHaveLength(3);
});

test('each kind follows its setting; nothing with iPhone access off', () => {
  const news = { waiting: [waiting('w')], done: [done('d')], error: [failed('e')] };
  expect(setup({ settings: { remoteNotifyWaiting: false } }).d.decide(news).map((n) => n.kind)).toEqual(['done', 'error']);
  expect(setup({ settings: { remoteNotifyDone: false } }).d.decide(news).map((n) => n.kind)).toEqual(['waiting', 'error']);
  expect(setup({ settings: { remoteNotifyError: false } }).d.decide(news).map((n) => n.kind)).toEqual(['waiting', 'done']);
  expect(setup({ settings: { remoteAccess: false } }).d.decide(news)).toEqual([]);
});

test('only while away from this computer, unless that rule is off', () => {
  const news = { waiting: [waiting('w')], done: [], error: [] };
  const here = setup({ away: false });
  expect(here.d.decide(news)).toEqual([]);
  expect(setup({ away: false, settings: { remoteNotifyAway: false } }).d.decide(news)).toHaveLength(1);
  here.setAway(true);
  expect(here.d.decide(news)).toHaveLength(1);
});

test('at most one notice of each kind per session every 30 s: a wait that flaps rings once', () => {
  const { d, tick } = setup();
  expect(d.decide({ waiting: [waiting('w')], done: [], error: [] })).toHaveLength(1);
  tick(PUSH_EVERY_MS - 1);
  expect(d.decide({ waiting: [waiting('w'), waiting('other')], done: [], error: [] }).map((n) => n.id)).toEqual(['other']);
  tick(1);
  expect(d.decide({ waiting: [waiting('w')], done: [], error: [] }).map((n) => n.id)).toEqual(['w']);
});

test('a session that finishes, or stops with an error, right after a waiting notice still says so', () => {
  // Allowed from the phone, the task finishes 20 s later: "Finished" is news, not a repeat of the wait.
  const { d, tick } = setup();
  expect(d.decide({ waiting: [waiting('w')], done: [], error: [] }).map((n) => n.kind)).toEqual(['waiting']);
  tick(20_000);
  expect(d.decide({ waiting: [], done: [done('w')], error: [] }).map((n) => [n.kind, n.id])).toEqual([['done', 'w']]);
  tick(1000);
  expect(d.decide({ waiting: [], done: [], error: [failed('w')] }).map((n) => [n.kind, n.id])).toEqual([['error', 'w']]);
  // Each kind keeps its own 30 s.
  tick(1000);
  expect(d.decide({ waiting: [waiting('w')], done: [done('w')], error: [failed('w')] })).toEqual([]);
});

test('the notice as sent: at most 1024 bytes of UTF-8, the title at most 80 characters and the body 200', () => {
  const n: PushNotice = { v: 1, kind: 'done', title: 'T'.repeat(300), subtitle: 'p'.repeat(200), body: 'é'.repeat(900), project: 'P'.repeat(16), id: 'i'.repeat(36), at: 1 };
  const json = noticeJson(n);
  expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_NOTICE_BYTES);
  const back = JSON.parse(json) as PushNotice;
  expect([...back.title].length).toBeLessThanOrEqual(80);
  expect([...back.body].length).toBeLessThanOrEqual(200);
  expect(back).toMatchObject({ v: 1, kind: 'done', project: n.project, id: n.id, at: 1 });
  // A short one is as it is.
  const small = { ...n, title: 'Docs', subtitle: 'site', body: 'Finished' };
  expect(JSON.parse(noticeJson(small))).toEqual(small);
});

test('a collapse key per session: the same for its notices, at most 64 of [A-Za-z0-9_-], nothing of the id itself', () => {
  expect(collapseKeyOf('0b7e6d1c-4f2a-4c3e-9a8b-1d2e3f4a5b6c')).toBe(collapseKeyOf('0b7e6d1c-4f2a-4c3e-9a8b-1d2e3f4a5b6c'));
  expect(collapseKeyOf('a')).not.toBe(collapseKeyOf('b'));
  expect(collapseKeyOf('x')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
});
