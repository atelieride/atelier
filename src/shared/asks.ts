// What main asks a page: the questions that start in main — restarting atelierd, quitting,
// a window closing with unsaved files or busy sessions — shown as Aurora sheets in the window instead of the OS's dialogs.
import type { CloseSessionsAsk } from './close-sessions';

export type { CloseSessionsAsk };

export interface RestartAsk {
  kind: 'restart-daemon';
  /** Up to four sessions' avatars, the counts that close. */
  sessions: { title: string; color: string }[];
  sessionCount: number;
  working: number;
  terminals: number;
  projects: number;
}
export interface QuitGitAsk { kind: 'quit-git'; title: string; detail: string; ops: { noun: string; repo: string }[] }
/** A window closing (or quitting, or reloading) with unsaved files: the page lists them itself. */
export interface UnsavedCloseAsk { kind: 'unsaved-close'; what: 'close' | 'quit' | 'reload' }

export type AskRequest = RestartAsk | QuitGitAsk | UnsavedCloseAsk | CloseSessionsAsk;
export type AskKind = AskRequest['kind'];

/** Each question's answers; the first is what a window gone while asked counts as (the safe one). */
export const ASK_ANSWERS = {
  'restart-daemon': ['cancel', 'restart'],
  'quit-git': ['wait', 'quit'],
  'unsaved-close': ['cancel', 'go'],
  // A window gone while asking keeps everything as it is.
  'close-sessions': ['cancel', 'keep', 'stop']
} as const satisfies Record<AskKind, readonly string[]>;

export type AskAnswer<K extends AskKind = AskKind> = (typeof ASK_ANSWERS)[K][number];

/** main → page. */
export interface AskMessage { id: string; request: AskRequest }
