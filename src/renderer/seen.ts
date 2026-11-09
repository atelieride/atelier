// Rows already shown: the enter animation runs only the first time an element appears,
// not on every return to the Sessions view.
const seen = new Set<string>();

export function enterClass(id: string): string {
  if (seen.has(id)) return '';
  seen.add(id);
  return 'enter';
}
