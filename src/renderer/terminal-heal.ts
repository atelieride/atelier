/** How long after a terminal is opened its presence is checked against main's list. */
export const HEAL_AFTER_MS = 1500;

interface Deps<T extends { id: string }> {
  list(): Promise<T[]>;
  current(): T[];
  apply(list: T[]): void;
  later(fn: () => void, ms: number): void;
}

/**
 * A terminal that exits while it is being created: its list without it may reach the window before the create reply,
 * which then adds it back. Equal lists are no longer re-sent, so nothing would remove it: a moment
 * later main's list is asked for and, if it no longer has the terminal, applied.
 */
export function healAfterOpen<T extends { id: string }>(id: string, d: Deps<T>): void {
  d.later(() => {
    // Through a promise: a list call that throws at once fails like one that rejects.
    void Promise.resolve().then(() => d.list()).then((list) => {
      if (!list.some((x) => x.id === id) && d.current().some((x) => x.id === id)) d.apply(list);
    }).catch(() => { /* main busy or gone: the next real change brings the list */ });
  }, HEAL_AFTER_MS);
}
