// Ask companion: the types shared by main, preload and renderer.

export type CompanionModel = 'haiku' | 'sonnet' | 'opus';
/** A Claude session id (a thread's Ask conversation, `--session-id`/`--resume`): here, light, for the thread rules too. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest question main takes (characters): the panel's field stops there too. */
export const COMPANION_QUESTION_MAX = 8000;
export type AnswerStyle = 'short' | 'detailed';
export type PointStatus = 'done' | 'in_progress' | 'not_started' | 'unclear';
export interface CatchPoint { n: number; text: string; status: PointStatus; at: string | null; note: string | null }
export interface CatchUp { points: CatchPoint[]; where: string; choices: string[]; leftOpen: string | null }
export type CompanionErrorKind = 'limit' | 'not-found' | 'timeout' | 'exit' | 'stopped' | 'quit' | 'invalid-catchup' | 'chat-unreadable';
/** Which usage window a refused run hit (Claude's `rateLimitType`): the 5-hour one or a weekly one. */
export type LimitWindow = 'five-hour' | 'weekly';
export const LIMIT_WINDOWS: readonly LimitWindow[] = ['five-hour', 'weekly'];
export type ThreadItem =
  | { kind: 'question'; id: string; at: number; text: string }
  | { kind: 'answer'; id: string; at: number; questionId: string; markdown: string; read: string[]; model: CompanionModel; costUsd: number | null; stopped?: true }
  | { kind: 'catchup'; id: string; at: number; data: CatchUp; read: string[]; model: CompanionModel; final: boolean }
  /**
   * A limit's: resetsAt, its reset (epoch seconds); window, which limit it was (when Claude said); account, the run's
   * account choice ('session' or an account id) — the item names it after the thread moves to another account.
   */
  | { kind: 'error'; id: string; at: number; questionId: string | null; reason: CompanionErrorKind; message: string; resetsAt?: number; window?: LimitWindow; account?: string };
export interface Thread {
  v: 1;
  sessionId: string;
  claudeUuid: string;
  started: boolean;
  /** The config dir the Ask conversation was started in (null: the default account); another dir starts a fresh one. */
  convDir: string | null;
  model: CompanionModel | null;
  account: string | null;
  items: ThreadItem[];
  lastCatchUpAt: number | null;
  lastUsedAt: number;
  unseen: boolean;
  costUsd: number;
}
export interface Binding { terminalId: string; sessionId: string; cwd: string; configDir: string | null; title: string }
export type CompanionEvent =
  | { sessionId: string; kind: 'queued' | 'started'; runId: string; questionId: string | null }
  | { sessionId: string; kind: 'trace'; runId: string; line: string }
  | { sessionId: string; kind: 'delta'; runId: string; text: string }
  | { sessionId: string; kind: 'thread'; thread: Thread }
  /** The run is over (finished, failed, stopped or dropped), sent after the thread event that closes it. */
  | { sessionId: string; kind: 'ended'; runId: string };
