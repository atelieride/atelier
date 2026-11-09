import { compareVersions } from './limit-pause';
import { costOf } from './session';

/**
 * The Claude Code signals notebook's pure part: what one hook or status-line
 * payload carries that Atelier doesn't recognize. Privacy is the point: a finding holds a kind, the hook event name
 * and a code (or `<other>`), never any other part of a payload (no prompt, path, title or message).
 */

export type SignalKind = 'field' | 'event' | 'notification' | 'stop-error' | 'session-source' | 'permission-mode' | 'status';

export interface Finding { kind: SignalKind; event: string | null; value: string }
export interface SignalEntry extends Finding { version: string | null; first: number; last: number; count: number }
export interface SignalBookView { lastVersion: string | null; since: number; entries: SignalEntry[] }

export const MAX_SIGNALS = 100;

const KINDS: readonly SignalKind[] = ['field', 'event', 'notification', 'stop-error', 'session-source', 'permission-mode', 'status'];

const NOTIFICATION_TYPES = new Set([
  'permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'elicitation_url_dialog', 'elicitation_complete',
  'elicitation_response', 'agent_needs_input', 'agent_completed', 'quota_auto_resume_fired', 'quota_auto_resume_stale',
  'quota_auto_resume_disabled', 'plugin_notification'
]);
// The 12 documented codes, plus `api_error` and `auth`, which notifications.ts already labels.
const STOP_ERRORS = new Set([
  'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'invalid_request',
  'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown', 'api_error', 'auth'
]);
const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);

const CODE = /^[A-Za-z0-9_.:-]{1,40}$/;
const OTHER = '<other>';

/** A code as is, anything else (spaces, long text, a non-string) as `<other>`: nothing free-form is ever kept. */
const code = (v: unknown): string => (typeof v === 'string' && CODE.test(v) ? v : OTHER);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/** The findings of one hook payload; `installed` is the set of events Atelier's hooks cover (HOOK_EVENTS). */
export function noteHook(payload: unknown, installed: ReadonlySet<string>): Finding[] {
  const p = isObj(payload) ? payload : {};
  const out: Finding[] = [];
  const name = typeof p.hook_event_name === 'string' ? p.hook_event_name : null;
  const event = name === null ? null : code(name);
  for (const field of ['hook_event_name', 'session_id']) {
    if (typeof p[field] !== 'string') out.push({ kind: 'field', event, value: field });
  }
  if (name !== null && !installed.has(name)) out.push({ kind: 'event', event, value: code(name) });
  if (name === 'Notification' && p.notification_type !== undefined && !(typeof p.notification_type === 'string' && NOTIFICATION_TYPES.has(p.notification_type))) {
    out.push({ kind: 'notification', event, value: code(p.notification_type) });
  }
  if (name === 'StopFailure' && p.error !== undefined && !(typeof p.error === 'string' && STOP_ERRORS.has(p.error))) {
    out.push({ kind: 'stop-error', event, value: code(p.error) });
  }
  if (name === 'SessionStart' && p.source !== undefined && !(typeof p.source === 'string' && SESSION_SOURCES.has(p.source))) {
    out.push({ kind: 'session-source', event, value: code(p.source) });
  }
  if (p.permission_mode !== undefined && !(typeof p.permission_mode === 'string' && PERMISSION_MODES.has(p.permission_mode))) {
    out.push({ kind: 'permission-mode', event, value: code(p.permission_mode) });
  }
  return out;
}

/** The findings of one status-line payload: a limits window or a cost block the parser can't read. */
export function noteStatus(payload: unknown): Finding[] {
  if (!isObj(payload)) return [];
  const out: Finding[] = [];
  // API-key accounts send no rate_limits at all: not a finding.
  if (isObj(payload.rate_limits)) {
    for (const w of ['five_hour', 'seven_day'] as const) {
      const win = payload.rate_limits[w];
      if (win !== undefined && !(isObj(win) && finite(win.used_percentage) && finite(win.resets_at))) {
        out.push({ kind: 'status', event: null, value: `rate_limits.${w}` });
      }
    }
  }
  if (payload.cost !== undefined && payload.cost !== null && costOf(payload.cost) === null) {
    out.push({ kind: 'status', event: null, value: 'cost' });
  }
  return out;
}

/**
 * The highest of two versions. lastVersion only climbs: after an update, old sessions keep the old binary, and
 * following each payload's version would rewrite and broadcast the book every debounce all day.
 */
const higher = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null || compareVersions(b, a) <= 0 ? a : b;

/** Merges findings into the book by kind+event+value+version; at most MAX_SIGNALS, the oldest `last` goes first. */
export function recordFindings(book: SignalBookView, found: readonly Finding[], version: string | null, now: number): SignalBookView {
  const lastVersion = higher(book.lastVersion, version);
  if (found.length === 0 && lastVersion === book.lastVersion) return book;
  let entries = book.entries;
  let since = book.since;
  if (found.length > 0) {
    if (entries.length === 0) since = now;
    entries = entries.slice();
    for (const f of found) {
      const i = entries.findIndex((e) => e.kind === f.kind && e.event === f.event && e.value === f.value && e.version === version);
      const old = entries[i];
      if (old) entries[i] = { ...old, last: now, count: old.count + 1 };
      else entries.push({ kind: f.kind, event: f.event, value: f.value, version, first: now, last: now, count: 1 });
    }
    if (entries.length > MAX_SIGNALS) {
      entries = entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.last - a.e.last || b.i - a.i).slice(0, MAX_SIGNALS)
        .sort((a, b) => a.i - b.i).map((x) => x.e);
    }
  }
  return { lastVersion, since, entries };
}

const emptyBook = (now: number): SignalBookView => ({ lastVersion: null, since: now, entries: [] });
const strOrNull = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && v.length <= 40 ? v : undefined);

/** The saved file as a book; never throws, anything invalid is an empty book. */
export function parseBook(raw: unknown, now: number): SignalBookView {
  if (!isObj(raw) || !Array.isArray(raw.entries) || raw.entries.length > MAX_SIGNALS || !finite(raw.since)) return emptyBook(now);
  const lastVersion = raw.lastVersion === undefined ? null : strOrNull(raw.lastVersion);
  if (lastVersion === undefined) return emptyBook(now);
  const entries: SignalEntry[] = [];
  for (const e of raw.entries) {
    if (!isObj(e) || !KINDS.includes(e.kind as SignalKind)) return emptyBook(now);
    const event = strOrNull(e.event);
    const version = strOrNull(e.version);
    if (event === undefined || version === undefined || typeof e.value !== 'string' || !(CODE.test(e.value) || e.value === OTHER)) return emptyBook(now);
    if (!finite(e.first) || !finite(e.last) || !finite(e.count) || (e.count as number) < 1) return emptyBook(now);
    entries.push({ kind: e.kind as SignalKind, event, value: e.value, version, first: e.first as number, last: e.last as number, count: e.count as number });
  }
  return { lastVersion, since: raw.since as number, entries };
}
