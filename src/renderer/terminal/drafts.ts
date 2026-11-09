// What may sit unsent in a program's prompt (Session panel): the panel types `/model …` and Enter, which
// would send a draft along with it. Atelier can't read Claude's prompt, so it follows what goes into each terminal: text
// leaves a draft, the Enter that sends it (or Ctrl+C, which clears Claude's prompt) ends it. Keys and terminal reports
// that type nothing (arrows, focus and mouse reports, Shift+Tab…) change nothing. A terminal that was already running
// when this window started (sessions outlive the app in atelierd) counts as holding one until then. Wrong guesses only
// ever refuse.

import { DraftTracker } from '@shared/drafts';

const tracker = new DraftTracker();

/**
 * When this window started. Terminals live in atelierd and outlive the app and its windows: one created before (an app
 * restart, "Update ready · Restart", a reload) may hold a draft typed where this window never saw it.
 */
const BOOT_AT = Date.now();
/** Terminals this window has seen in a list (each is judged once, when it first shows up). */
const seen = new Set<string>();
/** Input held for a terminal while a Session panel command waits for its Enter (holdInput), in order. */
const held = new Map<string, string[]>();

/**
 * Follows input sent to a terminal (every write but the Session panel's own commands). `inDialog`: Claude shows a
 * permission or question dialog — its Enter and arrows answer it, they neither send nor recall a draft.
 */
export function noteInput(id: string, data: string, inDialog = false): void {
  tracker.note(id, data, inDialog);
}

/** Something may be waiting unsent in that terminal's prompt. */
export function hasDraft(id: string): boolean {
  return tracker.has(id);
}

export function forgetDraft(id: string): void {
  tracker.forget(id);
}

/**
 * The terminal list (atelierd's): a terminal created before this window started may hold a draft nobody here saw, so it
 * counts as one until the user's Enter at Claude's prompt or Ctrl+C there (the rules above). Wrong guesses only refuse.
 */
export function adoptTerminals(list: readonly { id: string; createdAt: number }[], bootAt = BOOT_AT): void {
  for (const x of list) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    if (x.createdAt < bootAt) tracker.assume(x.id);
  }
}

/** Terminals gone: forgotten, with whatever was held for them. */
export function pruneDrafts(alive: ReadonlySet<string>): void {
  for (const id of tracker.ids()) if (!alive.has(id)) tracker.forget(id);
  for (const id of [...seen]) if (!alive.has(id)) seen.delete(id);
  for (const id of [...held.keys()]) if (!alive.has(id)) held.delete(id);
}

/**
 * A Session panel command is typed and its Enter waits (≥ 250 ms): what the user types into that terminal meanwhile
 * (the keyboard is the terminal's at once) waits too — sent before the Enter it would become part of the command.
 */
export function holdInput(id: string): void {
  if (!held.has(id)) held.set(id, []);
}

/** Sends `first` (the command's Enter) past the hold, then what was held, in order; then input goes straight again. */
export function releaseInput(id: string, first = ''): void {
  const parts = held.get(id) ?? [];
  held.delete(id);
  if (first) sendInput(id, first);
  for (const p of parts) sendInput(id, p);
}

/** The command's Enter will never go (its terminal closed): what was held goes with it. */
export function dropHeld(id: string): void {
  held.delete(id);
}

// Whether Claude shows a dialog in that terminal now (the store sets the real probe; this module stays store-free).
let dialogProbe: (id: string) => boolean = () => false;

export function setDialogProbe(fn: (id: string) => boolean): void {
  dialogProbe = fn;
}

/**
 * Every write to a terminal goes through here (but the Session panel's own commands), so drafts are followed; held
 * while a panel command waits for its Enter (holdInput).
 */
export function sendInput(id: string, data: string): void {
  const wait = held.get(id);
  if (wait) { wait.push(data); return; }
  noteInput(id, data, dialogProbe(id));
  window.atelier.terminals.input(id, data);
}
