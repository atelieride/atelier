/** Radio group (role="radiogroup"): arrows wrap around, Home and End go to the ends; null for other keys. */
export function radioNext<V>(values: readonly V[], current: V, key: string): V | null {
  const i = values.indexOf(current);
  const n = values.length;
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return values[(i + 1) % n]!;
    case 'ArrowLeft': case 'ArrowUp': return values[(i - 1 + n) % n]!;
    case 'Home': return values[0]!;
    case 'End': return values[n - 1]!;
    default: return null;
  }
}
