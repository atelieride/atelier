// Untrusted text from a task source as it may be shown, saved or typed into a prompt. One cleaner, used
// by main (mapping ClickUp's replies, connectors/clickup/map.ts) and by the renderer (the prompt, saved task links), so
// the two can't drift. The sets are Unicode categories, never literal characters:
// - controls (Cc): C0 but tab and newline, DEL, C1;
// - format characters (Cf): bidi marks, embeddings, overrides and isolates (U+061C, U+200E/F, U+202A–E, U+2066–9),
//   zero-width characters (U+200B–D, U+2060–4), the soft hyphen (U+00AD), the Mongolian vowel separator (U+180E), BOM;
// - line breaks: CRLF, CR, VT, FF and the line and paragraph separators (Zl, Zp: U+2028, U+2029).

const LINE_BREAKS = /\r\n?|[\v\f\p{Zl}\p{Zp}]/gu;
const CONTROL = /(?![\t\n])\p{Cc}/gu;
const INVISIBLE = /\p{Cf}/gu;

/** Multi-line text: line breaks as \n, tabs kept, every other control and every format character removed. */
export function cleanText(s: string): string {
  return s.replace(LINE_BREAKS, '\n').replace(CONTROL, '').replace(INVISIBLE, '');
}

/** One line: cleaned, every run of whitespace (line breaks and tabs included) one space, trimmed. */
export function cleanLine(s: string): string {
  return cleanText(s).replace(/\s+/g, ' ').trim();
}
