// Main asks a page: sent with an id, answered once, by that page only, with one of that
// question's answers. A page that isn't listening isn't asked (null: the caller shows its native dialog); one that goes
// while asked answers the safe choice. A question asked with `shownMs` falls back to the native dialog too (null) when
// the page doesn't say it got it in time, or stops responding: a hung page must not keep the app from quitting.
import { ASK_ANSWERS, type AskAnswer, type AskKind, type AskMessage, type AskRequest, type RestartAsk } from '@shared/asks';
import type { TerminalInfo } from '@shared/protocol';
import { effectiveState } from '@shared/background';

/** Restart atelierd's question: every project's sessions (four avatars) and terminals, as atelierd lists them. */
export function restartAsk(list: readonly TerminalInfo[]): RestartAsk {
  const sessions = list.filter((t) => t.session);
  return {
    kind: 'restart-daemon',
    sessions: sessions.slice(0, 4).map((t) => ({ title: t.title, color: t.color })),
    sessionCount: sessions.length,
    working: sessions.filter((t) => effectiveState(t) === 'running').length,
    terminals: list.length - sessions.length,
    projects: new Set(list.map((t) => t.projectRoot)).size
  };
}

interface Timer { clear(): void }
interface Pending { wcId: number; kind: AskKind; resolve(a: string | null): void; fallback: boolean; timer: Timer | null }

export class AskBroker {
  private readonly listening = new Set<number>();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  /**
   * send: false when the page can't be reached any more. withdraw: main gave up on a question it sent (the native dialog
   * asks instead): the page drops its sheet, so the user never answers two prompts.
   */
  constructor(
    private readonly send: (wcId: number, m: AskMessage) => boolean,
    private readonly setTimer: (fn: () => void, ms: number) => Timer = (fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; },
    private readonly withdraw: (wcId: number, id: string) => void = () => {}
  ) {}

  /** The page listens (it said so after mounting its listener). */
  ready(wcId: number): void { this.listening.add(wcId); }

  isReady(wcId: number): boolean { return this.listening.has(wcId); }

  /** The page closed, crashed or is reloading: its questions get their safe answer, nothing more is sent to it. */
  gone(wcId: number): void {
    this.listening.delete(wcId);
    for (const [id, p] of this.pending) {
      if (p.wcId !== wcId) continue;
      this.settle(id, ASK_ANSWERS[p.kind][0]);
    }
  }

  /**
   * shownMs: how long the page has to say it got the question (shown) before main falls back (null); such a question
   * falls back too when the page stops responding (unresponsive). Without it the question waits for the page.
   */
  ask<R extends AskRequest>(wcId: number, request: R, o: { shownMs?: number } = {}): Promise<AskAnswer<R['kind']> | null> {
    if (!this.listening.has(wcId)) return Promise.resolve(null);
    const id = `ask-${++this.seq}`;
    return new Promise((resolve) => {
      const fallback = o.shownMs !== undefined;
      this.pending.set(id, { wcId, kind: request.kind, resolve: resolve as (a: string | null) => void, fallback, timer: null });
      if (!this.send(wcId, { id, request })) {
        this.pending.delete(id);
        resolve(null);
        return;
      }
      if (fallback) this.pending.get(id)!.timer = this.setTimer(() => this.giveUp(id), o.shownMs!);
    });
  }

  /** The page got its question: it waits for the answer now (true when it was that page's open question). */
  shown(wcId: number, id: string): boolean {
    const p = this.pending.get(id);
    if (!p || p.wcId !== wcId) return false;
    p.timer?.clear();
    p.timer = null;
    return true;
  }

  /** The page stopped responding: its questions that can fall back to the native dialog do (null). */
  unresponsive(wcId: number): void {
    for (const [id, p] of this.pending) if (p.wcId === wcId && p.fallback) this.giveUp(id);
  }

  /** The native dialog asks instead (null); the page is told to drop the question. */
  private giveUp(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.settle(id, null);
    this.withdraw(p.wcId, id);
  }

  private settle(id: string, answer: string | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.timer?.clear();
    p.resolve(answer);
  }

  /** The page's answer: true when it was that page's open question and an answer it has. */
  answer(wcId: number, id: string, answer: string): boolean {
    const p = this.pending.get(id);
    if (!p || p.wcId !== wcId || !(ASK_ANSWERS[p.kind] as readonly string[]).includes(answer)) return false;
    this.settle(id, answer);
    return true;
  }
}
