// Notification center: the history of sessions that needed you or finished, per project.
// Entries are made by the main process (attention.ts) and kept by the window (memory + localStorage).
import { waitTarget } from './session-view';
import type { DockerNote } from './docker';
import type { RedisNote } from './redis';

/**
 * 'trigger': an output trigger matched in a terminal; 'container': a Docker container failed (its
 * one "session" is the container, id `docker:<id>`); 'job': a queue job failed (its
 * one "session" is the queue, id `redis:<hash>:<name>`); the others are session states.
 */
export type NoteKind = 'waiting' | 'done' | 'error' | 'trigger' | 'container' | 'job';
export type StateNoteKind = Exclude<NoteKind, 'trigger' | 'container' | 'job'>;
export interface NoteJob { queue: string; name: string; job: string; lib: string }
export interface NoteContainer { id: string; project: string | null; reason: DockerNote['reason']; exitCode: number | null }
export interface NoteSession { id: string; title: string; color: string }
/**
 * One entry: a session waiting, finished or stopped by an error, or several that finished (kind 'done') or stopped
 * (kind 'error', `activity` = their reason when they share one) together. `unseen`: its sessions not viewed since;
 * the entry is unread while any is left.
 */
export interface NoteEntry {
  id: string; at: number; kind: NoteKind; sessions: NoteSession[]; activity: string | null; unseen: string[];
  /** A 'waiting' entry from an atelierd with states2: what the session waited for (absent otherwise). */
  wait?: NoteWait;
  /**
   * In transit only (main → window, never stored): sessions shown in a focused pop-out when the entry was made.
   * Someone is looking at them: they never chime.
   */
  quiet?: string[];
  /** A 'trigger' entry: the rule that matched (its pattern); `activity` holds the matching line. */
  trigger?: string;
  /** A 'trigger' entry that joined earlier unread matches of its rule in that terminal: how many (absent: one). */
  count?: number;
  /** A 'container' entry: which container, why. */
  container?: NoteContainer;
  /** A 'job' entry: which queue and job. */
  job?: NoteJob;
}
export type NoteWait = 'permission' | 'question';

export const MAX_NOTES = 100;
const KINDS = new Set<string>(['waiting', 'done', 'error', 'trigger', 'container', 'job']);
/** A queue as a notification subject: a short hash of its id (ids can be long) and its name. */
export function redisSubject(queueId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < queueId.length; i++) { h ^= queueId.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const name = queueId.split('|').at(-1) ?? '';
  return `redis:${h.toString(16).padStart(8, '0')}:${name}`.slice(0, 80);
}

function parseJob(v: unknown): NoteJob | null {
  if (!isObj(v)) return null;
  const queue = str(v.queue, 600); const name = str(v.name); const job = str(v.job, 256); const lib = str(v.lib, 32);
  return queue && name && job && lib ? { queue, name, job, lib } : null;
}
const REASONS_DOCKER = new Set(['crash', 'oom', 'unhealthy']);
export const dockerSubject = (containerId: string) => `docker:${containerId}`;

function parseContainer(v: unknown): NoteContainer | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 64);
  if (!id || !/^[0-9a-f]{12,64}$/.test(id) || typeof v.reason !== 'string' || !REASONS_DOCKER.has(v.reason)) return null;
  const project = v.project === null ? null : str(v.project);
  if (project === null && v.project !== null) return null;
  const exitCode = typeof v.exitCode === 'number' && Number.isInteger(v.exitCode) ? v.exitCode : null;
  return { id, project, reason: v.reason as NoteContainer['reason'], exitCode };
}
const MAX_TEXT = 200;
const MAX_SESSIONS = 64;

const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseSession(v: unknown): NoteSession | null {
  if (!isObj(v)) return null;
  // 80: a container's subject is "docker:" and its 64-hex id.
  const id = str(v.id, 80); const title = str(v.title); const color = str(v.color, 64);
  return id && title && color ? { id, title, color } : null;
}

function parseEntry(v: unknown): NoteEntry | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 64);
  if (!id || typeof v.at !== 'number' || !Number.isFinite(v.at) || typeof v.kind !== 'string' || !KINDS.has(v.kind) || !Array.isArray(v.sessions)) return null;
  const sessions = v.sessions.slice(0, MAX_SESSIONS).map(parseSession).filter((s): s is NoteSession => s !== null);
  if (sessions.length === 0) return null;
  const mine = new Set(sessions.map((s) => s.id));
  const unseen = Array.isArray(v.unseen) ? [...new Set(v.unseen.filter((x): x is string => typeof x === 'string' && mine.has(x)))] : [];
  const entry: NoteEntry = { id, at: v.at, kind: v.kind as NoteKind, sessions, activity: str(v.activity), unseen };
  if (v.wait === 'permission' || v.wait === 'question') entry.wait = v.wait;
  const quiet = Array.isArray(v.quiet) ? [...new Set(v.quiet.filter((x): x is string => typeof x === 'string' && mine.has(x)))] : [];
  if (quiet.length) entry.quiet = quiet;
  if (entry.kind === 'container') {
    const c = parseContainer(v.container);
    if (!c || sessions.length !== 1 || sessions[0]!.id !== dockerSubject(c.id)) return null;
    entry.container = c;
    if (typeof v.count === 'number' && Number.isInteger(v.count) && v.count > 1) entry.count = Math.min(v.count, MAX_COUNT);
  }
  if (entry.kind === 'job') {
    const j = parseJob(v.job);
    if (!j || sessions.length !== 1 || sessions[0]!.id !== redisSubject(j.queue)) return null;
    entry.job = j;
    if (typeof v.count === 'number' && Number.isInteger(v.count) && v.count > 1) entry.count = Math.min(v.count, MAX_COUNT);
  }
  if (entry.kind === 'trigger') {
    const rule = str(v.trigger);
    if (!rule) return null;
    entry.trigger = rule;
    if (typeof v.count === 'number' && Number.isInteger(v.count) && v.count > 1) entry.count = Math.min(v.count, MAX_COUNT);
  }
  return entry;
}

/** The entry for a trigger match in a terminal: unread unless that terminal is the one you are looking at. */
export function triggerNote(term: NoteSession, rule: string, line: string, at: number, id: string, viewing: string | null): NoteEntry {
  return {
    id, at, kind: 'trigger', sessions: [{ id: term.id, title: term.title, color: term.color }], activity: line.slice(0, MAX_TEXT),
    unseen: viewing === term.id ? [] : [term.id], trigger: rule.slice(0, MAX_TEXT)
  };
}

/** A failed container's entry (from main's DockerNote): unread until its container is looked at. */
export function containerNote(n: DockerNote): NoteEntry {
  const subject = dockerSubject(n.container.id);
  return {
    id: n.id, at: n.at, kind: 'container', sessions: [{ id: subject, title: n.container.name, color: 'docker' }], activity: n.line ? n.line.slice(0, MAX_TEXT) : null,
    unseen: [subject], container: { id: n.container.id, project: n.container.project, reason: n.reason, exitCode: n.exitCode }
  };
}

/** A failed job's entry (from main's RedisNote): unread until its queue is looked at. */
export function jobNote(n: RedisNote): NoteEntry {
  const subject = redisSubject(n.queue.id);
  const what = [n.job.name, n.job.reason].filter(Boolean).join(' · ');
  return {
    id: n.id, at: n.at, kind: 'job', sessions: [{ id: subject, title: n.queue.name, color: 'redis' }], activity: what ? what.slice(0, MAX_TEXT) : null,
    unseen: [subject], job: { queue: n.queue.id, name: n.queue.name, job: n.job.id || '?', lib: n.queue.lib }
  };
}

/** From whatever was saved or received to valid entries: newest first, each id once (the newest), at most MAX_NOTES. */
export function parseNotes(raw: unknown): NoteEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.map(parseEntry).filter((e): e is NoteEntry => e !== null).sort((a, b) => b.at - a.at)
    .filter((e) => !seen.has(e.id) && (seen.add(e.id), true)).slice(0, MAX_NOTES);
}

const unreadWaiting = (e: NoteEntry): string | null => (e.kind === 'waiting' && e.sessions.length === 1 && e.unseen.length > 0 ? e.sessions[0]!.id : null);
// Entries that join an unread one of the same key (×N): a trigger per terminal and rule, a container per container.
const unreadTrigger = (e: NoteEntry): string | null => (e.unseen.length === 0 ? null
  : e.kind === 'trigger' ? `${e.sessions[0]!.id}\u0000${e.trigger}` : e.kind === 'container' || e.kind === 'job' ? e.sessions[0]!.id : null);
const MAX_COUNT = 9999;

/**
 * New entries in (an id already there is ignored), newest first, capped. A session asking again while its previous
 * entry is still an unread "waiting" replaces that entry, and a trigger matching again while its entry for that
 * terminal and rule is unread joins it (the newest line, count ×N): one noisy session or rule can't push the others
 * out of the cap.
 */
export function addNotes(list: NoteEntry[], incoming: NoteEntry[]): NoteEntry[] {
  const known = new Set(list.map((e) => e.id));
  const fresh = incoming.filter((e) => !known.has(e.id) && (known.add(e.id), true));
  if (fresh.length === 0) return list;
  // Newest first; for each session, the nearest newer entry kept so far; for each unread trigger, where it is.
  const newer = new Map<string, NoteEntry>();
  const triggers = new Map<string, number>();
  const out: NoteEntry[] = [];
  for (const e of [...fresh, ...list].sort((a, b) => b.at - a.at)) {
    const sid = unreadWaiting(e);
    const next = sid ? newer.get(sid) : undefined;
    if (sid && next && unreadWaiting(next) === sid) continue;
    const tkey = unreadTrigger(e);
    const at = tkey ? triggers.get(tkey) : undefined;
    if (tkey && at !== undefined) {
      const kept = out[at]!;
      out[at] = { ...kept, count: Math.min(MAX_COUNT, (kept.count ?? 1) + (e.count ?? 1)) };
      continue;
    }
    if (tkey) triggers.set(tkey, out.length);
    out.push(e);
    for (const s of e.sessions) newer.set(s.id, e);
  }
  return out.slice(0, MAX_NOTES);
}

/** Sessions that no longer exist are no longer unseen (the same list if nothing changes). */
export function pruneUnseen(list: NoteEntry[], alive: Set<string>): NoteEntry[] {
  // A container is not a terminal: its entry stays unread until the container is looked at.
  const live = (id: string) => alive.has(id) || id.startsWith('docker:') || id.startsWith('redis:');
  if (!list.some((e) => e.unseen.some((id) => !live(id)))) return list;
  return list.map((e) => (e.unseen.some((id) => !live(id)) ? { ...e, unseen: e.unseen.filter(live) } : e));
}

/** The session was viewed: it is read in every entry that names it (the same list if nothing changes). */
export function markSessionSeen(list: NoteEntry[], sessionId: string): NoteEntry[] {
  if (!list.some((e) => e.unseen.includes(sessionId))) return list;
  return list.map((e) => (e.unseen.includes(sessionId) ? { ...e, unseen: e.unseen.filter((x) => x !== sessionId) } : e));
}

export function markEntryRead(list: NoteEntry[], id: string): NoteEntry[] {
  if (!list.some((e) => e.id === id && e.unseen.length > 0)) return list;
  return list.map((e) => (e.id === id ? { ...e, unseen: [] } : e));
}

export function markAllRead(list: NoteEntry[]): NoteEntry[] {
  if (!list.some((e) => e.unseen.length > 0)) return list;
  return list.map((e) => (e.unseen.length ? { ...e, unseen: [] } : e));
}

export function unreadNotes(list: NoteEntry[]): number {
  return list.reduce((n, e) => n + (e.unseen.length > 0 ? 1 : 0), 0);
}

// Reasons Claude Code gives for a turn that stopped on an error (StopFailure `error`), in words.
const REASONS: Record<string, string> = {
  rate_limit: 'Rate limit', overloaded: 'Overloaded', api_error: 'API error', server_error: 'API error',
  auth: 'Sign-in needed', authentication_failed: 'Sign-in needed', oauth_org_not_allowed: 'Organization not allowed',
  account_on_hold: 'Account on hold', billing_error: 'Billing issue', invalid_request: 'Invalid request',
  model_not_found: 'Model not found', max_output_tokens: 'Output limit reached', cloud_credential_error: 'Cloud credentials error',
  unknown: 'Unknown error'
};

const WAITS: Record<NoteWait, string> = { permission: 'Needs permission', question: 'Has a question' };

/** "rate_limit" → "Rate limit"; an unknown code still reads as words ("some_new-reason" → "Some new reason"). */
export function reasonLabel(reason: string): string {
  const known = REASONS[reason];
  if (known) return known;
  const words = reason.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : reason;
}

/**
 * One line for an entry or a banner: the kind (sentence case), then what the session was doing — "waiting: " is not
 * said twice, and a stop gives its reason in words ("Stopped with an error · Rate limit"). Knowing what a waiting
 * session asks for (states2), it says so: "Needs permission · Bash npm test", "Has a question".
 */
export function noteText(kind: StateNoteKind, activity: string | null, kinds: Record<StateNoteKind, string>, wait?: NoteWait): string {
  if (kind === 'waiting' && wait) {
    const target = wait === 'permission' ? waitTarget(activity) : null;
    return target ? `${WAITS[wait]} · ${target}` : WAITS[wait];
  }
  let what = activity ?? '';
  if (kind === 'waiting') what = what.replace(/^waiting(:\s*|\s+for you$)/, '');
  else if (kind === 'error') what = what === 'error' ? '' : what && reasonLabel(what);
  else what = '';
  return what ? `${kinds[kind]} · ${what}` : kinds[kind];
}

const MONTHS =['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Entries grouped by local day: "Today", "Yesterday", then "Oct 3" ("Oct 3, 2025" in another year). */
export function noteDays(list: NoteEntry[], now: number, words = { today: 'Today', yesterday: 'Yesterday' }): { label: string; items: NoteEntry[] }[] {
  const dayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = dayStart(now);
  const yesterday = dayStart(today - 12 * 3600 * 1000);
  const label = (start: number) => {
    if (start === today) return words.today;
    if (start === yesterday) return words.yesterday;
    const d = new Date(start);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === new Date(now).getFullYear() ? '' : `, ${d.getFullYear()}`}`;
  };
  const out: { label: string; items: NoteEntry[]; start: number }[] = [];
  for (const e of [...list].sort((a, b) => b.at - a.at)) {
    const start = dayStart(e.at);
    const last = out.at(-1);
    if (last && last.start === start) last.items.push(e);
    else out.push({ label: label(start), items: [e], start });
  }
  return out.map(({ label, items }) => ({ label, items }));
}
