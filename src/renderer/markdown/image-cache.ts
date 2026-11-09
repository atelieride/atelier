// Images of the Markdown preview: kept per absolute path as data URLs, so switching views or
// a Claude write to the Markdown file doesn't send every image back to a loading box. Bounded by count and size.
export function createImageCache(maxEntries: number, maxChars: number) {
  const map = new Map<string, string>();
  let size = 0;
  const drop = (k: string) => { const v = map.get(k); if (v !== undefined) { size -= v.length; map.delete(k); } };
  return {
    get(path: string): string | undefined {
      const v = map.get(path);
      if (v === undefined) return undefined;
      map.delete(path);
      map.set(path, v);
      return v;
    },
    set(path: string, src: string): void {
      drop(path);
      if (src.length > maxChars) return;
      map.set(path, src);
      size += src.length;
      while (map.size > maxEntries || size > maxChars) drop(map.keys().next().value!);
    }
  };
}

/** The window's cache: 60 images, about 120 MB of data URLs. */
export const imageCache = createImageCache(60, 120 * 1024 * 1024);
