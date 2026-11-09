/** A listener that ignores a value equal to the previous one (no store update, no render). */
export function sameAsLast<T>(fn: (v: T) => void, key: (v: T) => string = (v) => JSON.stringify(v)): (v: T) => void {
  let last: string | undefined;
  return (v) => {
    const k = key(v);
    if (k === last) return;
    last = k;
    fn(v);
  };
}
