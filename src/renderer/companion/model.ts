// Ask companion: the renderer's pure rules. The store slice (slice.ts) only holds
// their results and talks to main.
import type { TerminalInfo } from '@shared/protocol';
import { isUnsure, type Attribution } from '@shared/attribution';
import type { Inline } from '@shared/companion/answer';
import type { Binding, CompanionEvent, Thread } from '@shared/companion/types';
import { isAbsPath } from '@shared/paths';
import { sendAvailability } from '../comments';
import { remoteReason } from '../remote';
import { t } from '../i18n/en';

/** The Ask dock's width and the least width the terminal keeps beside it; narrower panes show Ask as a sheet. */
export const ASK_WIDTH = 404;
export const TERM_MIN = 480;

/** One run of the companion (an answer or a Catch me up), several per session possible: one running, the rest queued. */
export interface RunView {
  runId: string;
  sessionId: string;
  queued: boolean;
  trace: string[];
  /** How much text had arrived when the last trace line did: text after it means that step is done. */
  traceAt: number;
  text: string;
  /** Null for a Catch me up. */
  questionId: string | null;
  /** When this window saw it start (queued, then again when it started). */
  startedAt: number;
}

export interface AskModelState {
  askThreads: Record<string, Thread>;
  /** Keyed by runId. */
  askRuns: Record<string, RunView>;
  /** The text of a question that is not in the thread yet (waiting its turn), keyed by the runId `ask()` returned. */
  askTexts: Record<string, string>;
}

/** The terminal's Ask binding; null for a plain terminal. Kept by the slice until Ask closes, even after Claude exits. */
export function bindingOf(term: TerminalInfo): Binding | null {
  const s = term.session;
  if (!s) return null;
  return { terminalId: term.id, sessionId: s.sessionId, cwd: s.cwd ?? term.cwd, configDir: term.configDir ?? null, title: term.title };
}

/** Events from main folded into the state. Only `ended` (main's explicit run end) removes a run view: `thread` events arrive several times in a run and never clear it. */
export function reduceEvent(s: AskModelState, e: CompanionEvent, now: number = Date.now()): AskModelState {
  switch (e.kind) {
    case 'queued':
    case 'started': {
      const old = s.askRuns[e.runId];
      const run: RunView = {
        runId: e.runId, sessionId: e.sessionId, queued: e.kind === 'queued', trace: old?.trace ?? [], traceAt: old?.traceAt ?? 0, text: old?.text ?? '',
        questionId: e.questionId, startedAt: now
      };
      return { ...s, askRuns: { ...s.askRuns, [e.runId]: run } };
    }
    case 'trace':
    case 'delta': {
      const run = s.askRuns[e.runId];
      if (!run) return s;
      const next = e.kind === 'trace' ? { ...run, trace: [...run.trace, e.line], traceAt: run.text.length } : { ...run, text: run.text + e.text };
      return { ...s, askRuns: { ...s.askRuns, [e.runId]: next } };
    }
    case 'thread':
      return { ...s, askThreads: { ...s.askThreads, [e.sessionId]: e.thread } };
    case 'ended': {
      if (!s.askRuns[e.runId] && s.askTexts[e.runId] === undefined) return s;
      const { [e.runId]: _r, ...askRuns } = s.askRuns;
      const { [e.runId]: _t, ...askTexts } = s.askTexts;
      return { ...s, askRuns, askTexts };
    }
  }
}

/** 'sheet' when the terminal would drop under its minimum width beside the dock. */
export function dockMode(paneWidth: number): 'dock' | 'sheet' {
  return paneWidth - ASK_WIDTH < TERM_MIN ? 'sheet' : 'dock';
}

/** An IPC rejection arrives as "Error invoking remote method 'companion:…': Error: <msg>": only <msg> is for the panel. */
export function stripIpcError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

/** When the session last moved: its last message (while it is still the terminal's session) or the latest file it surely changed. */
export function lastActivityOf(term: TerminalInfo, sessionId: string, attributions: readonly (Pick<Attribution, 'sessionId' | 'at'> & { unclear?: unknown; maybe?: unknown })[]): number | null {
  let last: number | null = term.session?.sessionId === sessionId ? (term.session.lastMessageAt ?? null) : null;
  for (const a of attributions) if (a.sessionId === sessionId && !isUnsure(a) && (last === null || a.at > last)) last = a.at;
  return last;
}

/** Where a file chip opens: what `openFile` takes. */
export interface ChipTarget { path: string; rel: string; line: number | null }

/**
 * A file reference in an answer → the project file it opens, or null: it stays plain code and never opens
 * (Review Focus 5). Only a clean relative path is asked of main, which checks it is a regular file inside the project
 * (`files.resolve`: the session's folder, then the root); a folder, a missing file, a lookup that fails or an answer
 * outside the project is null. Clean: `/`-separated (answer.ts turned a Windows reference's backslashes), no drive or
 * NTFS stream (a colon).
 */
export async function resolveChip(inline: Inline, cwd: string, resolve: (candidate: string, cwd: string) => Promise<{ path: string; rel: string } | null>): Promise<ChipTarget | null> {
  if (inline.t !== 'file') return null;
  const p = inline.path;
  if (!p || p.startsWith('/') || p.startsWith('~') || p.includes('\\') || p.includes(':') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  let found: { path: string; rel: string } | null;
  try { found = await resolve(p, cwd); } catch { return null; }
  if (!found || !isAbsPath(found.path) || !found.rel || found.rel.split(/[\\/]/).includes('..') || isAbsPath(found.rel)) return null;
  return { path: found.path, rel: found.rel, line: inline.from };
}

/**
 * An answer view's file-chip lookups: each path asked once (`known`: already answered), every result landing while the
 * view is there — also when newer paths arrived meanwhile (a streamed answer grows), never after `dispose` (unmounted).
 * A lookup that fails lands nothing (the chip stays code).
 */
export function chipLookups<V>(lookup: (path: string) => Promise<V>, land: (path: string, v: V) => void, known: Iterable<string> = []): { ask(paths: readonly string[]): void; dispose(): void } {
  const asked = new Set(known);
  let alive = true;
  return {
    ask(paths) {
      for (const path of paths) {
        if (asked.has(path)) continue;
        asked.add(path);
        void lookup(path).then((v) => { if (alive) land(path, v); }, () => {});
      }
    },
    dispose() { alive = false; }
  };
}

/**
 * Why Use as prompt is off for this answer's `text` (promptText's) in this terminal, or null when Claude is
 * at its prompt: Review's Send to session rule (`sendAvailability`, its tooltips; paused at a usage limit included). An
 * ended session's panel stays bound, but there is no Claude to paste into.
 */
export function askPromptReason(term: TerminalInfo | undefined, bracketed: boolean, text: string): string | null {
  // A verdict-only answer has nothing to paste (promptText leaves the verdict out).
  if (!text) return t.companion.onlyVerdict;
  const a = sendAvailability(term, bracketed);
  return a === 'not-claude' ? t.companion.notRunning : remoteReason(a);
}

/**
 * What this window keeps per session (threads, pickers, drafts): its terminals' sessions and the open bindings'. The
 * same object when nothing goes.
 */
export function pruneThreads<T>(threads: Record<string, T>, terms: readonly TerminalInfo[], open: Record<string, Binding>): Record<string, T> {
  const keep = new Set<string>(Object.values(open).map((b) => b.sessionId));
  for (const t of terms) if (t.session) keep.add(t.session.sessionId);
  const ids = Object.keys(threads);
  if (ids.every((id) => keep.has(id))) return threads;
  return Object.fromEntries(ids.filter((id) => keep.has(id)).map((id) => [id, threads[id]!]));
}
