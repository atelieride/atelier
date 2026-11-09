export interface TokenSpans { colors: string[]; spans: number[] }
export interface RawToken { content: string; color?: string }

/** Shiki tokens → compact spans [from, to, color index] with offsets over the whole document. */
/** Hex colors compare in upper case; a CSS variable stays as written (custom property names are case-sensitive). */
const norm = (c: string | undefined) => (c?.startsWith('#') ? c.toUpperCase() : c);

export function compressTokens(lines: RawToken[][], defaultFg: string): TokenSpans {
  const colors: string[] = [];
  const index = new Map<string, number>();
  const spans: number[] = [];
  let offset = 0;
  for (const line of lines) {
    for (const tok of line) {
      const from = offset;
      offset += tok.content.length;
      const c = norm(tok.color);
      if (!c || c === norm(defaultFg) || tok.content.trim() === '') continue;
      let i = index.get(c);
      if (i === undefined) { i = colors.length; colors.push(c); index.set(c, i); }
      spans.push(from, offset, i);
    }
    offset += 1; // \n
  }
  return { colors, spans };
}
