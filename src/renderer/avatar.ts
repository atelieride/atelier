const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** A session's initial: the first grapheme (an emoji stays whole), uppercased. */
export function initialOf(title: string): string {
  const s = title.trim();
  if (!s) return '?';
  const first = seg ? seg.segment(s)[Symbol.iterator]().next().value?.segment ?? s[0]! : [...s][0]!;
  return first.toUpperCase();
}

/**
 * A session's identity color as an element style: only --id, so one CSS rule decides what it paints (the text and the
 * ring), and a theme can override it (Minimal's monochrome avatars).
 */
export function idStyle(color: string): Record<string, string> {
  return { '--id': color };
}
