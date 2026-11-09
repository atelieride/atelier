// The store's confirms slice, spread into useApp: the questions Atelier asks inside the window
// instead of the OS's dialogs. Closing a terminal is asked here, in the row or the popover where it was asked.
import { closeStops, keepsSession, type CloseStops } from '@shared/close-plan';
import { pendingPrompt } from '@shared/scheduled-prompts';
import { ASK_ANSWERS, type AskAnswer, type AskMessage } from '@shared/asks';
import { neverSent } from '@shared/daemon-errors';
import type { AppState } from '../store';
import { t } from '../i18n/en';

/** Where a close was asked: the sidebar row (inline), or the element a popover hangs from. */
export type CloseAt = 'row' | 'tab' | 'popout';

/**
 * Where a closed session comes back from: Claude Code's history (⌘K › Resume a
 * session…, as before), or the sidebar's Resume — with its scheduled prompt, sent once resumed.
 */
export type CloseNote = 'history' | 'resume' | 'resume-scheduled';

/** `promptAt`: with 'resume-scheduled', the time of the session's first prompt still to send. */
export interface CloseAsk { id: string; at: CloseAt; stops: CloseStops; note: CloseNote; promptAt?: number }

/** The unsaved-files question's answer: save these (the checked ones; the others are discarded), or all, or none. */
export type UnsavedAnswer = { save: string[] } | 'discard' | 'cancel';
/** Why it is asked: tabs closing, or a rename or trash of what holds the files. */
export type UnsavedHow = 'close' | 'rename' | 'trash';
export interface UnsavedAsk {
  paths: string[];
  how: UnsavedHow;
  /** The tab it hangs from (one file closing from its tab), else the sheet. */
  tab: string | null;
  done(a: UnsavedAnswer): void;
}

/** Move to Trash asked in the tree row: what main counted. */
export interface TrashAsk { path: string; name: string; kind: 'file' | 'folder'; files: number }

export interface ConfirmsSlice {
  /** The question main is asking this window (restart atelierd, quitting). */
  mainAsk: AskMessage | null;
  /** main asked: shown (one still open gets its safe answer first). */
  receiveAsk(m: AskMessage): void;
  /** Main gave up on its question (its native dialog asks instead): the sheet goes. */
  withdrawAsk(id: string): void;
  /** This window's answer to main's open question. */
  answerMain(answer: AskAnswer): void;
  trashAsk: TrashAsk | null;
  /** The tree's Move to Trash…: unsaved files under it first, then the question in its row. */
  askTrash(path: string): Promise<void>;
  cancelTrash(): void;
  /** Its row went (folder collapsed, file deleted, the tree closed): the question goes too, never back stale. */
  trashRowGone(path: string): void;
  /** The question's Move to Trash: main trashes (it no longer asks); its tabs close, the tree reads again. */
  confirmTrash(): Promise<void>;
  /** Files with unsaved changes about to close (one question at a time; a second one cancels the first). */
  unsavedAsk: UnsavedAsk | null;
  askUnsaved(paths: string[], how: UnsavedHow, tab: string | null): Promise<UnsavedAnswer>;
  answerUnsaved(a: UnsavedAnswer): void;
  /** A busy terminal's close being asked (one at a time). */
  closeAsk: CloseAsk | null;
  /**
   * Terminals whose close was sent, until they leave the list: never closed again (on Windows a second kill while
   * ConPTY is closing frees its console twice and atelierd dies), drawn as closing meanwhile.
   */
  closing: Readonly<Record<string, true>>;
  /** Close a terminal: at once when only a shell would stop, else ask where it was asked. */
  askClose(id: string, at: CloseAt): void;
  cancelClose(): void;
  /** The question's Close: the terminal closes (main kills it; the page asked). */
  confirmClose(): void;
}

export function createConfirmsSlice(set: (p: Partial<AppState>) => void, get: () => AppState): ConfirmsSlice {
  const close = (id: string) => {
    if (get().closing[id]) return;
    set({ closing: { ...get().closing, [id]: true } });
    // Never sent (no atelierd): it can be tried again. Sent and answered late: it is still closing.
    void window.atelier.terminals.close(id).catch((err: unknown) => {
      if (!neverSent(err)) return;
      const { [id]: _, ...rest } = get().closing;
      set({ closing: rest });
    });
  };
  const failed = (error: string) => get().showToast(t.fileOpFailed(t.fileErrors[error as keyof typeof t.fileErrors] ?? error));
  const reply = (id: string, answer: string) => { void window.atelier.asks.answer(id, answer).catch(() => false); };
  return {
    mainAsk: null,
    receiveAsk: (m) => {
      const open = get().mainAsk;
      if (open) reply(open.id, ASK_ANSWERS[open.request.kind][0]);
      // As every sheet does: the palette, a context menu and the background popover give way (they keep the keys).
      set({ mainAsk: m, menu: null, paletteOpen: false, bgPopover: null });
      // Got it: main waits for the answer now (a hung page never says so, and main asks with its native dialog). Too
      // late (main's native dialog already asks): the sheet goes, never two prompts.
      void window.atelier.asks.shown(m.id).then((ok) => { if (!ok) get().withdrawAsk(m.id); }, () => false);
    },
    withdrawAsk: (id) => {
      if (get().mainAsk?.id === id) set({ mainAsk: null });
    },
    answerMain: (answer) => {
      const open = get().mainAsk;
      if (!open) return;
      set({ mainAsk: null });
      reply(open.id, answer);
    },
    trashAsk: null,
    askTrash: async (path) => {
      if (!(await get().confirmUnsavedUnder(path, 'trash'))) return;
      const info = await window.atelier.files.trashInfo(path).catch((e: Error) => ({ error: e.message }));
      if ('error' in info) { failed(info.error); return; }
      set({ trashAsk: { path, name: path.split(/[\\/]/).at(-1) ?? path, kind: info.kind, files: info.files } });
    },
    cancelTrash: () => set({ trashAsk: null }),
    trashRowGone: (path) => { if (get().trashAsk?.path === path) set({ trashAsk: null }); },
    confirmTrash: async () => {
      const ask = get().trashAsk;
      if (!ask) return;
      set({ trashAsk: null });
      const r = await window.atelier.files.trash(ask.path).catch((e: Error) => ({ error: e.message }));
      if ('error' in r) { failed(r.error); return; }
      get().dropOpenFiles(ask.path);
      get().bumpTree();
    },
    unsavedAsk: null,
    askUnsaved: (paths, how, tab) => new Promise<UnsavedAnswer>((done) => {
      get().unsavedAsk?.done('cancel');
      set({ unsavedAsk: { paths, how, tab, done } });
    }),
    answerUnsaved: (a) => {
      const q = get().unsavedAsk;
      if (!q) return;
      set({ unsavedAsk: null });
      q.done(a);
    },
    closeAsk: null,
    closing: {},
    askClose: (id, at) => {
      const term = get().terminals.find((t) => t.id === id);
      if (!term || get().closing[id]) return;
      const stops = closeStops(term);
      if (!stops) { set({ closeAsk: null }); close(id); return; }
      // Kept under Resume: an idle session loses nothing, so it closes at once; a turn in
      // flight, a question, a usage-limit pause or a
      // prompt still to send asks first. Main decides the request on its own.
      const st = get();
      const kept = keepsSession(term, st.settings.keepClosedSessions && st.daemon.closeStopAvailable === true);
      const prompts = kept ? st.schedules.filter((p) => p.terminalId === id && pendingPrompt(p)) : [];
      if (kept && stops.kind === 'claude' && stops.doing === 'idle' && prompts.length === 0) { set({ closeAsk: null }); close(id); return; }
      if (prompts.length > 0) { set({ closeAsk: { id, at, stops, note: 'resume-scheduled', promptAt: Math.min(...prompts.map((p) => p.at)) } }); return; }
      set({ closeAsk: { id, at, stops, note: kept ? 'resume' : 'history' } });
    },
    cancelClose: () => set({ closeAsk: null }),
    confirmClose: () => {
      const ask = get().closeAsk;
      if (!ask) return;
      set({ closeAsk: null });
      close(ask.id);
    }
  };
}

/** Questions about something that went away are dropped (a terminal that exited while its close was asked). */
export function staleConfirms(s: AppState): Partial<AppState> | null {
  if (s.closeAsk && !s.terminals.some((t) => t.id === s.closeAsk!.id)) return { closeAsk: null };
  // Closed terminals that left the list are no longer closing.
  const ids = Object.keys(s.closing);
  if (ids.some((id) => !s.terminals.some((t) => t.id === id))) {
    return { closing: Object.fromEntries(ids.filter((id) => s.terminals.some((t) => t.id === id)).map((id) => [id, true as const])) };
  }
  // Unsaved files none of which is open any more (their tabs closed some other way): nothing left to ask about.
  const q = s.unsavedAsk;
  if (q && !q.paths.some((p) => s.openFiles.some((f) => f.path === p))) {
    queueMicrotask(() => q.done('cancel'));
    return { unsavedAsk: null };
  }
  return null;
}
