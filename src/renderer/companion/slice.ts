// Ask companion: the store's slice. Which sessions have Ask open (bound to their
// conversation even after Claude exits), the threads, the live runs and the dock/sheet inputs. The rules are in model.ts.
import type { Binding, CompanionEvent, CompanionModel, Thread } from '@shared/companion/types';
import type { TerminalInfo } from '@shared/protocol';
import { shouldCatchUp } from '@shared/companion/thread';
import type { AppState } from '../store';
import { onScreen } from '../on-screen';
import { bindingOf, lastActivityOf, reduceEvent, stripIpcError, type AskModelState, type RunView } from './model';
import { askAtDelay, livesElsewhere, shownIn, wakeIn } from './attention';
import { forgetEntrance } from './view';

export interface CompanionSlice {
  /** terminalId → binding; kept from open to close, even after the session ended. */
  askOpen: Record<string, Binding>;
  /** sessionId → thread (a cache of main's). */
  askThreads: Record<string, Thread>;
  /** runId → live run (several per session: one running, the rest queued). */
  askRuns: Record<string, RunView>;
  /** runId → text of a question still waiting for its turn (not in the thread yet). */
  askTexts: Record<string, string>;
  /** terminalId → what main refused with, for the panel to show. */
  askNotice: Record<string, string | null>;
  /**
   * terminalId → how its panel shows (its host decides from the pane's width): a docked one narrows the terminal. Kept
   * from open to close, also while its tab isn't shown, so the terminal comes back at its docked size at once.
   */
  askDock: Record<string, 'dock' | 'sheet'>;
  /** sessionId → the thread's model and account pickers, sent with its next question (main keeps them in the thread). */
  askPick: Record<string, { model?: CompanionModel; account?: string }>;
  /** sessionId → the half-typed question, kept across closing the panel and switching tabs. */
  askDrafts: Record<string, string>;
  /** A pop-out that brought its session's Ask along: opened once its terminal is listed with a live session. */
  askWanted: string | null;
  /**
   * sessionId → Ask at: the limit item whose question asks again when its account resets (`at`, ms). A timer
   * in this window while the app runs, one per thread; a new ask, Catch me up, New Thread or closing the panel cancel it.
   */
  askAt: Record<string, { itemId: string; at: number }>;
  askAtReset(terminalId: string, itemId: string): void;
  cancelAskAt(sessionId: string): void;
  /** Ask with <account>: the thread's account picker on it, and the limited question (or Catch me up) asked again now. */
  askWith(terminalId: string, itemId: string, account: string): void;
  /**
   * The terminals listed: each Claude session's saved thread is asked for once (unless this window has it), so an
   * answer left unseen before a restart marks its row and its pill again.
   */
  loadAskThreads(terminals: readonly TerminalInfo[]): void;
  /**
   * Opens (or closes) the terminal's Ask. catchUp: a Catch me up once the thread has loaded (the palette's Catch Me
   * Up), unless a run of the thread is on; never a second one with "when opened" on.
   */
  toggleAsk(terminalId: string, o?: { catchUp?: boolean }): void;
  /** Opens the terminal's Ask now, or as soon as it is listed with a live session (never closes an open one). */
  openAskWhenListed(terminalId: string): void;
  /** The store's terminals changed: a wanted Ask opens if its terminal is here now. */
  takeAskWanted(): void;
  setAskDraft(sessionId: string, text: string): void;
  closeAskPanel(terminalId: string): void;
  /** Resolves true when a run started (or waits its turn); false when nothing was asked (the composer keeps the text). */
  askQuestion(terminalId: string, text: string): Promise<boolean>;
  setAskDock(terminalId: string, mode: 'dock' | 'sheet' | null): void;
  setAskPick(sessionId: string, pick: { model?: CompanionModel; account?: string }): void;
  /**
   * Catch me up on demand (the empty state's button, the card's refresh, the composer's button, the ⋯ menu, the
   * palette), with the thread's pickers; nothing while a run of the thread is on (one at a time).
   */
  askCatchUp(terminalId: string): void;
  stopAsk(terminalId: string): void;
  /** New Thread: empties the thread; its run views go with it. */
  newAskThread(terminalId: string): void;
  clearAskNotice(terminalId: string): void;
  /** The panel's terminal is on screen and its thread has an unseen outcome: main is told it was looked at. */
  markAskSeen(terminalId: string): void;
  applyCompanionEvent(e: CompanionEvent): void;
}

export function createCompanionSlice(set: (p: Partial<AppState>) => void, get: () => AppState): CompanionSlice {
  const api = () => window.atelier.companion;
  const notice = (terminalId: string, askNotice: string | null) => set({ askNotice: { ...get().askNotice, [terminalId]: askNotice } });
  const failed = (terminalId: string) => (err: unknown) => notice(terminalId, stripIpcError(err));
  const modelState = (): AskModelState => ({ askThreads: get().askThreads, askRuns: get().askRuns, askTexts: get().askTexts });
  const bindingFor = (terminalId: string): Binding | null => get().askOpen[terminalId] ?? null;
  const visible = (terminalId: string) => onScreen(get(), null).has(terminalId);
  /** A run of the session's thread is on (a question or a Catch me up): main takes one at a time. */
  const busyThread = (sessionId: string) => Object.values(get().askRuns).some((r) => r.sessionId === sessionId);

  // With the thread's pickers, as its questions go: the thread's model and account are the panel's choice.
  const catchUp = (b: Binding, final: boolean) => {
    void api().catchUp({ binding: b, final, ...get().askPick[b.sessionId] }).then((r) => { if ('error' in r) notice(b.terminalId, r.error); }, failed(b.terminalId));
  };
  // Ask at: one wait per thread, in this window. Checked in steps of at most a minute and again when the
  // window comes back (focus, visible): a sleeping Mac runs a long timer late, and a reset passed in sleep must still ask.
  const waits = new Map<string, { timer: ReturnType<typeof setTimeout> | null; fireAt: number; terminalId: string; itemId: string }>();
  const cancelAt = (sessionId: string) => {
    const w = waits.get(sessionId);
    if (w) { if (w.timer !== null) clearTimeout(w.timer); waits.delete(sessionId); }
    if (get().askAt[sessionId]) {
      const { [sessionId]: _a, ...askAt } = get().askAt;
      set({ askAt });
    }
  };
  const check = (sessionId: string) => {
    const w = waits.get(sessionId);
    if (!w) return;
    if (w.timer !== null) clearTimeout(w.timer);
    const wait = wakeIn(w.fireAt, Date.now());
    if (wait === null) { cancelAt(sessionId); again(w.terminalId, w.itemId); return; }
    w.timer = setTimeout(() => { w.timer = null; check(sessionId); }, wait);
  };
  // Sessions whose saved thread this window already asked for (loadAskThreads): never twice.
  const loaded = new Set<string>();
  let wakeOn: unknown = null;
  const listenWake = () => {
    if (typeof window === 'undefined' || wakeOn === window || typeof window.addEventListener !== 'function') return;
    wakeOn = window;
    const all = () => { for (const sid of [...waits.keys()]) check(sid); };
    window.addEventListener('focus', all);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', all);
  };
  /** The limit item of the open panel's thread, with the question it failed (null: a Catch me up). */
  const limitItem = (terminalId: string, itemId: string) => {
    const b = bindingFor(terminalId);
    const items = b ? get().askThreads[b.sessionId]?.items ?? [] : [];
    const item = items.find((i) => i.id === itemId);
    if (!b || item?.kind !== 'error') return null;
    const question = item.questionId === null ? null : items.find((i) => i.id === item.questionId);
    return { b, item, text: question?.kind === 'question' ? question.text : null };
  };
  /** The limited run again: its question (still in the thread), or Catch me up. */
  const again = (terminalId: string, itemId: string) => {
    const found = limitItem(terminalId, itemId);
    if (!found) return;
    if (found.item.questionId === null) get().askCatchUp(terminalId);
    else if (found.text !== null) void get().askQuestion(terminalId, found.text);
  };

  return {
    askOpen: {},
    askThreads: {},
    askRuns: {},
    askTexts: {},
    askNotice: {},
    askDock: {},
    askPick: {},
    askDrafts: {},
    askWanted: null,
    askAt: {},

    toggleAsk: (terminalId, o) => {
      if (get().askOpen[terminalId]) { get().closeAskPanel(terminalId); return; }
      // Its tab lives in another window: its Ask is that window's (a panel here would be hidden, and could catch up unseen).
      if (livesElsewhere(get(), terminalId)) return;
      const term = get().terminals.find((x) => x.id === terminalId);
      const b = term ? bindingOf(term) : null;
      if (!term || !b) return;
      set({ askOpen: { ...get().askOpen, [terminalId]: b }, askNotice: { ...get().askNotice, [terminalId]: null } });
      void api().thread(b.sessionId).then((thread) => {
        if (get().askOpen[terminalId] !== b) return;
        if (thread) set({ askThreads: { ...get().askThreads, [b.sessionId]: thread } });
        if (thread?.unseen && visible(terminalId)) void api().seen(b.sessionId).catch(() => {});
        const cur = get().terminals.find((x) => x.id === terminalId);
        const known = get().askThreads[b.sessionId] ?? null;
        const running = Object.values(get().askRuns).some((r) => r.sessionId === b.sessionId && r.questionId === null);
        const wanted = o?.catchUp ? !busyThread(b.sessionId)
          : !running && shouldCatchUp(known, { onOpen: get().settings.askCatchUpOnOpen, lastActivityAt: cur ? lastActivityOf(cur, b.sessionId, get().attributions) : null, now: Date.now() });
        // Never a paid Catch me up for a panel nobody sees (its tab not in front): it runs when shown and opened.
        if (wanted && shownIn(get()).has(terminalId)) {
          catchUp(b, cur?.session?.sessionId !== b.sessionId);
        }
      }, failed(terminalId));
    },

    closeAskPanel: (terminalId) => {
      const b = get().askOpen[terminalId];
      if (b) cancelAt(b.sessionId);
      forgetEntrance(terminalId);
      const { [terminalId]: _b, ...askOpen } = get().askOpen;
      const { [terminalId]: _n, ...askNotice } = get().askNotice;
      const { [terminalId]: _d, ...askDock } = get().askDock;
      set({ askOpen, askNotice, askDock });
    },

    openAskWhenListed: (terminalId) => {
      set({ askWanted: terminalId });
      get().takeAskWanted();
    },

    takeAskWanted: () => {
      const id = get().askWanted;
      if (!id || !get().terminals.some((x) => x.id === id && x.session)) return;
      set({ askWanted: null });
      if (!get().askOpen[id]) get().toggleAsk(id);
    },

    setAskDraft: (sessionId, text) => {
      const { [sessionId]: _old, ...rest } = get().askDrafts;
      if (!text && _old === undefined) return;
      set({ askDrafts: text ? { ...rest, [sessionId]: text } : rest });
    },

    askQuestion: (terminalId, text) => {
      const b = bindingFor(terminalId);
      const q = text.trim();
      if (!b || !q) return Promise.resolve(false);
      notice(terminalId, null);
      cancelAt(b.sessionId);
      return api().ask({ binding: b, text: q, ...get().askPick[b.sessionId] }).then((r) => {
        if ('error' in r) { notice(terminalId, r.error); return false; }
        // A run that already ended has nothing left to wait for: its text would never be cleared.
        if (get().askRuns[r.runId]) set({ askTexts: { ...get().askTexts, [r.runId]: q } });
        return true;
      }, (err: unknown) => { failed(terminalId)(err); return false; });
    },

    setAskDock: (terminalId, mode) => {
      const cur = get().askDock;
      if ((cur[terminalId] ?? null) === mode) return;
      const { [terminalId]: _m, ...rest } = cur;
      set({ askDock: mode ? { ...rest, [terminalId]: mode } : rest });
    },

    setAskPick: (sessionId, pick) => set({ askPick: { ...get().askPick, [sessionId]: { ...get().askPick[sessionId], ...pick } } }),

    askCatchUp: (terminalId) => {
      const b = bindingFor(terminalId);
      if (!b || busyThread(b.sessionId)) return;
      const term = get().terminals.find((x) => x.id === terminalId);
      notice(terminalId, null);
      cancelAt(b.sessionId);
      catchUp(b, term?.session?.sessionId !== b.sessionId);
    },

    askAtReset: (terminalId, itemId) => {
      const found = limitItem(terminalId, itemId);
      const delay = found ? askAtDelay(found.item.resetsAt, Date.now()) : null;
      if (!found || delay === null) return;
      const sid = found.b.sessionId;
      cancelAt(sid);
      listenWake();
      waits.set(sid, { timer: null, fireAt: Date.now() + delay, terminalId, itemId });
      set({ askAt: { ...get().askAt, [sid]: { itemId, at: found.item.resetsAt! * 1000 } } });
      check(sid);
    },

    cancelAskAt: (sessionId) => cancelAt(sessionId),

    loadAskThreads: (terminals) => {
      const companion = typeof window !== 'undefined' ? window.atelier?.companion : undefined;
      if (!companion?.thread) return;
      for (const term of terminals) {
        const sid = term.session?.sessionId;
        if (!sid || loaded.has(sid) || get().askThreads[sid]) continue;
        loaded.add(sid);
        // An event that brought it meanwhile is newer: kept.
        void companion.thread(sid).then((thread) => { if (thread && !get().askThreads[sid]) set({ askThreads: { ...get().askThreads, [sid]: thread } }); }, () => {});
      }
    },

    askWith: (terminalId, itemId, account) => {
      const b = bindingFor(terminalId);
      if (!b) return;
      get().setAskPick(b.sessionId, { account });
      again(terminalId, itemId);
    },

    stopAsk: (terminalId) => {
      const b = bindingFor(terminalId);
      if (b) void api().stop(b.sessionId).catch(failed(terminalId));
    },

    newAskThread: (terminalId) => {
      const b = bindingFor(terminalId);
      if (!b) return;
      cancelAt(b.sessionId);
      void api().newThread(b.sessionId).then((thread) => set({ askThreads: { ...get().askThreads, [b.sessionId]: thread } }), failed(terminalId));
    },

    clearAskNotice: (terminalId) => notice(terminalId, null),

    markAskSeen: (terminalId) => {
      const b = bindingFor(terminalId);
      if (b && get().askThreads[b.sessionId]?.unseen && visible(terminalId)) void api().seen(b.sessionId).catch(() => {});
    },

    applyCompanionEvent: (e) => {
      set(reduceEvent(modelState(), e));
      if (e.kind !== 'thread' || !e.thread.unseen) return;
      // A panel that is open and on screen has looked at the outcome as it landed.
      const shown = Object.values(get().askOpen).some((b) => b.sessionId === e.sessionId && visible(b.terminalId));
      if (shown) void api().seen(e.sessionId).catch(() => {});
    }
  };
}
