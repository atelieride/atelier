// A terminal gone from this window's list: ended, or moved to another project's window. Its xterm goes (App.tsx), as on
// exit, so if it comes back it attaches anew; one that was never
// listed (a create reply ahead of atelierd's list) is never among them.

/** The ids the previous list had that this one hasn't (none before a first list). */
export function leftTheList(prev: ReadonlySet<string> | null, next: readonly { id: string }[]): string[] {
  if (!prev) return [];
  const now = new Set(next.map((x) => x.id));
  return [...prev].filter((id) => !now.has(id));
}
