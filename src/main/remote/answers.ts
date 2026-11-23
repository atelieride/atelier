// Answers from phones to sessions' permission requests, per terminal: one at a time, and once per wait. Two taps (or
// two phones) both reading the screen before the first key lands would both type it: the second would answer the
// dialog that comes next, or leave a stray key in Claude's prompt. And after "Yes" no hook arrives until the tool has
// run, so the session keeps waiting under the same key all that time: answered again, its Esc would interrupt the
// tool. A wait answered stays answered until the session's wait key changes.

/** Terminals remembered with the wait last answered in them, at most (the oldest go first). */
const REMEMBERED = 256;

export class AnswerBook {
  private readonly busy = new Set<string>();
  /** The wait last answered, by terminal. */
  private readonly answered = new Map<string, string>();

  /** An answer to terminal `id`'s wait `wait` starts: null, or why it can't (one on its way, or answered already). */
  begin(id: string, wait: string): string | null {
    if (this.busy.has(id)) return 'This request is being answered';
    if (this.answered.get(id) === wait) return 'This request was answered already';
    this.busy.add(id);
    return null;
  }

  /** That answer is over: its key was typed (the wait is answered), or nothing was. */
  end(id: string, wait: string, typed: boolean): void {
    this.busy.delete(id);
    if (!typed) return;
    this.answered.delete(id);
    this.answered.set(id, wait);
    if (this.answered.size > REMEMBERED) this.answered.delete(this.answered.keys().next().value!);
  }
}
