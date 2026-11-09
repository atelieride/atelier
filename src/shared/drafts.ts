// What may sit unsent in a program's prompt, followed from what goes into each terminal (the
// renderer and atelierd both follow it). Atelier can't read Claude's prompt: text leaves a
// draft, the Enter that sends it (or Ctrl+C, which clears Claude's prompt) ends it. Keys and terminal reports that type
// nothing (arrows, focus and mouse reports, Shift+Tab…) change nothing. Wrong guesses only ever refuse.

const ESC = 27;
const CR = 13;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

interface State { draft: boolean; pasting: boolean }

/** Where an escape sequence that starts at `i` ends (the index after it). */
function skipEscape(data: string, i: number): number {
  const next = data[i + 1];
  if (next === '[') {
    // CSI: parameters and intermediates, then one final byte in @…~.
    let j = i + 2;
    while (j < data.length) { const c = data.charCodeAt(j); j++; if (c >= 0x40 && c <= 0x7e) break; }
    return j;
  }
  if (next === 'O') return Math.min(data.length, i + 3);
  if (next === ']' || next === 'P' || next === '_') {
    // OSC / DCS / APC: up to BEL or ST.
    let j = i + 2;
    while (j < data.length) {
      if (data.charCodeAt(j) === 7) return j + 1;
      if (data.charCodeAt(j) === ESC && data[j + 1] === '\\') return j + 2;
      j++;
    }
    return j;
  }
  // ESC alone, or ESC + one key (Alt+key): no text.
  return Math.min(data.length, i + (next === undefined ? 1 : 2));
}

/** Up or Down (CSI or SS3, with or without modifiers): at Claude's prompt they recall its history into the prompt. */
const HISTORY_KEY = /^\x1b(?:\[[0-9;]*|O)[AB]$/;

/**
 * Input that types into the prompt (scheduled prompts' typing gate): text, a paste, Enter, Shift+Enter,
 * Backspace, Ctrl+C. Terminal reports (cursor position, colors, device attributes), focus and mouse events (wheel
 * scrolls over Claude) and navigation keys don't.
 */
export function typesSomething(data: string): boolean {
  let i = 0;
  while (i < data.length) {
    const c = data.charCodeAt(i);
    if (c === ESC) {
      if (data.startsWith(PASTE_START, i) || data.charCodeAt(i + 1) === CR) return true;
      i = skipEscape(data, i);
      continue;
    }
    if (c === CR || c === 3 || c === 8 || c === 0x7f || (c >= 0x20 && !(c >= 0x80 && c <= 0x9f))) return true;
    i++;
  }
  return false;
}

export class DraftTracker {
  private states = new Map<string, State>();

  /**
   * Follows input sent to a terminal. `inDialog`: Claude shows a permission or question dialog — its Enter and arrows
   * answer it, they neither send nor recall a draft.
   */
  note(id: string, data: string, inDialog = false): void {
    const s = this.states.get(id) ?? { draft: false, pasting: false };
    let i = 0;
    while (i < data.length) {
      const c = data.charCodeAt(i);
      if (c === ESC) {
        if (data.startsWith(PASTE_START, i)) { s.pasting = true; s.draft = true; i += PASTE_START.length; continue; }
        if (data.startsWith(PASTE_END, i)) { s.pasting = false; i += PASTE_END.length; continue; }
        // Shift+Enter (ESC CR): a new line in the prompt.
        if (data.charCodeAt(i + 1) === CR) { s.draft = true; i += 2; continue; }
        const end = skipEscape(data, i);
        if (!inDialog && HISTORY_KEY.test(data.slice(i, end))) s.draft = true;
        i = end;
        continue;
      }
      if (s.pasting) s.draft = true;
      else if (c === CR) { if (!inDialog) s.draft = false; }
      else if (c === 3) s.draft = false;
      else if (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)) s.draft = true;
      i++;
    }
    if (s.draft || s.pasting) this.states.set(id, s); else this.states.delete(id);
  }

  /** Something may be waiting unsent in that terminal's prompt. */
  has(id: string): boolean {
    return this.states.get(id)?.draft ?? false;
  }

  /** Counts that terminal as holding a draft (one created where nobody saw what was typed). */
  assume(id: string): void {
    this.states.set(id, { draft: true, pasting: false });
  }

  forget(id: string): void {
    this.states.delete(id);
  }

  ids(): string[] {
    return [...this.states.keys()];
  }
}
