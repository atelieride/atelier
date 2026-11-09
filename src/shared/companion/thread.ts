// A saved Ask thread: the pure rules. The file itself is read and written by main/companion/store.ts.

import { parseCatchUp } from './catchup';
import { ACCOUNT_ID } from '../claude-accounts';
import { LIMIT_WINDOWS, UUID, type CompanionErrorKind, type CompanionModel, type LimitWindow, type Thread, type ThreadItem } from './types';

export const THREAD_CAP = 200;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * At most this many threads are kept on disk: past it the least recently used go, even
 * a session's under Resume (which has no age limit), never one open in a terminal or with a run going.
 */
export const THREADS_KEPT = 100;
const CATCHUP_REFRESH_MS = 10 * 60 * 1000;
const MODELS: readonly string[] = ['haiku', 'sonnet', 'opus'];
const REASONS: readonly string[] = ['limit', 'not-found', 'timeout', 'exit', 'stopped', 'quit', 'invalid-catchup', 'chat-unreadable'];

export function newThread(sessionId: string, uuid: string, now: number): Thread {
  return { v: 1, sessionId, claudeUuid: uuid, started: false, convDir: null, model: null, account: null, items: [], lastCatchUpAt: null, lastUsedAt: now, unseen: false, costUsd: 0 };
}

/** The item a question in flight ends with when Atelier quits: the one source of its id and text. */
export function quitError(questionId: string, now: number): ThreadItem {
  return { kind: 'error', id: `quit-${questionId}`.slice(0, 64), at: now, questionId, reason: 'quit', message: 'Stopped when Atelier quit' };
}

export function appendItems(t: Thread, items: ThreadItem[], now: number): Thread {
  return { ...t, items: [...t.items, ...items].slice(-THREAD_CAP), lastUsedAt: now };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const model = (v: unknown): v is CompanionModel => typeof v === 'string' && MODELS.includes(v);
const costOrNull = (v: unknown): v is number | null => v === null || num(v);
/** An account choice as Settings › Ask takes it: 'session' (the session's own) or an account's id. */
const accountChoice = (v: unknown): v is string => v === 'session' || (typeof v === 'string' && ACCOUNT_ID.test(v));

function parseItem(v: unknown): ThreadItem | null {
  if (!isRec(v) || !id(v.id) || !num(v.at)) return null;
  switch (v.kind) {
    case 'question':
      return typeof v.text === 'string' ? { kind: 'question', id: v.id, at: v.at, text: v.text } : null;
    case 'answer': {
      if (!id(v.questionId) || typeof v.markdown !== 'string' || !strs(v.read) || !model(v.model) || !costOrNull(v.costUsd)) return null;
      const a: ThreadItem = { kind: 'answer', id: v.id, at: v.at, questionId: v.questionId, markdown: v.markdown, read: v.read, model: v.model, costUsd: v.costUsd };
      return v.stopped === true ? { ...a, stopped: true } : a;
    }
    case 'catchup': {
      const data = parseCatchUp(v.data);
      if (!data || !strs(v.read) || !model(v.model) || typeof v.final !== 'boolean') return null;
      return { kind: 'catchup', id: v.id, at: v.at, data, read: v.read, model: v.model, final: v.final };
    }
    case 'error': {
      if (!(v.questionId === null || id(v.questionId)) || typeof v.reason !== 'string' || !REASONS.includes(v.reason) || typeof v.message !== 'string') return null;
      if (v.resetsAt !== undefined && !num(v.resetsAt)) return null;
      if (v.window !== undefined && !LIMIT_WINDOWS.includes(v.window as LimitWindow)) return null;
      if (v.account !== undefined && !accountChoice(v.account)) return null;
      return {
        kind: 'error', id: v.id, at: v.at, questionId: v.questionId, reason: v.reason as CompanionErrorKind, message: v.message,
        ...(v.resetsAt !== undefined ? { resetsAt: v.resetsAt as number } : {}), ...(v.window !== undefined ? { window: v.window as LimitWindow } : {}),
        ...(v.account !== undefined ? { account: v.account as string } : {})
      };
    }
    default:
      return null;
  }
}

/** Validates a thread read from disk; null for anything unexpected (the whole thread, never a partial one). */
export function parseThread(raw: unknown, sessionId: string): Thread | null {
  if (!isRec(raw) || raw.v !== 1 || raw.sessionId !== sessionId) return null;
  if (typeof raw.claudeUuid !== 'string' || !UUID.test(raw.claudeUuid)) return null;
  if (typeof raw.started !== 'boolean' || typeof raw.unseen !== 'boolean') return null;
  if (!(raw.model === null || model(raw.model))) return null;
  if (!(raw.account === null || accountChoice(raw.account))) return null;
  // Missing in a file from before convDir: where its conversation lives is unknown, so the next run starts afresh.
  const known = raw.convDir !== undefined;
  if (known && !(raw.convDir === null || typeof raw.convDir === 'string')) return null;
  if (!(raw.lastCatchUpAt === null || num(raw.lastCatchUpAt)) || !num(raw.lastUsedAt) || !num(raw.costUsd)) return null;
  if (!Array.isArray(raw.items)) return null;
  const items: ThreadItem[] = [];
  for (const it of raw.items) {
    const p = parseItem(it);
    if (!p) return null;
    items.push(p);
  }
  return {
    v: 1, sessionId, claudeUuid: raw.claudeUuid, started: known && raw.started, convDir: known ? (raw.convDir as string | null) : null,
    model: raw.model as CompanionModel | null,
    account: raw.account as string | null, items: items.slice(-THREAD_CAP), lastCatchUpAt: raw.lastCatchUpAt as number | null,
    lastUsedAt: raw.lastUsedAt, unseen: raw.unseen, costUsd: raw.costUsd,
  };
}

/** After a quit: a question with no answer or error and no run in flight ends as "Stopped when Atelier quit". */
export function settleOrphans(t: Thread, active: ReadonlySet<string>, now: number): Thread {
  const settled = new Set<string>();
  for (const it of t.items) {
    if (it.kind === 'answer') settled.add(it.questionId);
    else if (it.kind === 'error' && it.questionId) settled.add(it.questionId);
  }
  const added: ThreadItem[] = [];
  for (const it of t.items) {
    if (it.kind !== 'question' || settled.has(it.id) || active.has(it.id)) continue;
    added.push(quitError(it.id, now));
  }
  return added.length ? { ...t, items: [...t.items, ...added] } : t;
}

export function expired(t: Thread, live: boolean, now: number): boolean {
  return !live && now - t.lastUsedAt > RETENTION_MS;
}

/** Catch me up on open: none yet, or at least 10 minutes old and the session moved since. */
export function shouldCatchUp(t: Thread | null, o: { onOpen: boolean; lastActivityAt: number | null; now: number }): boolean {
  if (!o.onOpen) return false;
  const last = t?.lastCatchUpAt ?? null;
  if (last === null) return true;
  return o.now - last >= CATCHUP_REFRESH_MS && o.lastActivityAt !== null && o.lastActivityAt > last;
}
