// Answers from phones to sessions' requests (a row's Allow/Deny, an option chosen in a dialog), per terminal: one at a
// time, and once per wait. Two taps (or two phones) both reading the screen before the first key lands would both type
// it: the second would answer the dialog that comes next, or leave a stray key in Claude's prompt. And after "Yes" no
// hook arrives until the tool has run, so the session keeps waiting under the same key all that time: answered again,
// its Esc would interrupt the tool. A wait answered stays answered until the session's wait key changes, whichever
// way it was answered: the row answers a wait as a whole, an option chosen answers one page of its dialog (a question
// asked in several pages takes one answer per page).
// Other typing from a phone (a prompt, an interrupt, a menu closed) holds the terminal the same way, so it never goes
// in between an answer's keys, nor an answer in between its own.

/** Terminals remembered with the wait last answered in them, at most (the oldest go first). */
const REMEMBERED = 256;
/** Pages of one wait remembered as answered, at most (a question's pages, its review page). */
const PAGES = 16;
const BUSY = 'This request is being answered';

/** What an answer goes to: the session's wait (its `ask`), and for an option chosen in its dialog, the dialog's page. */
export interface AnswerTo { ask: string; page?: string }

/** How a terminal's wait was answered so far: by the row, and the pages of its dialog chosen in. */
interface Answered { ask: string; row: boolean; pages: Set<string> }

export class AnswerBook {
  /** Terminals an answer or other typing is on its way to, and which of the two. */
  private readonly busy = new Map<string, 'answer' | 'typing'>();
  /** The wait last answered, by terminal. */
  private readonly answered = new Map<string, Answered>();

  /**
   * An answer to terminal `id`'s wait starts: null, or why it can't (one on its way, or answered already: the whole
   * wait once anything answered it, a page once the row or that page did).
   */
  begin(id: string, to: AnswerTo): string | null {
    if (this.busy.has(id)) return BUSY;
    const a = this.answered.get(id);
    if (a?.ask === to.ask && (to.page === undefined || a.row || a.pages.has(to.page))) return 'This request was answered already';
    this.busy.set(id, 'answer');
    return null;
  }

  /** That answer is over: a key of it was typed (it counts as given), or none was. */
  end(id: string, to: AnswerTo, typed: boolean): void {
    if (this.busy.get(id) === 'answer') this.busy.delete(id);
    if (!typed) return;
    const known = this.answered.get(id);
    const a = known?.ask === to.ask ? known : { ask: to.ask, row: false, pages: new Set<string>() };
    if (to.page === undefined) a.row = true;
    else a.pages.add(to.page);
    if (a.pages.size > PAGES) a.pages.delete(a.pages.values().next().value!);
    this.answered.delete(id);
    this.answered.set(id, a);
    if (this.answered.size > REMEMBERED) this.answered.delete(this.answered.keys().next().value!);
  }

  /** Typing into terminal `id` that answers no wait starts: null, or why it can't (an answer or typing on its way). */
  hold(id: string): string | null {
    if (this.busy.has(id)) return BUSY;
    this.busy.set(id, 'typing');
    return null;
  }

  /** That typing is over. It frees the terminal only from a `hold`, never from an answer still typing. */
  release(id: string): void {
    if (this.busy.get(id) === 'typing') this.busy.delete(id);
  }
}
