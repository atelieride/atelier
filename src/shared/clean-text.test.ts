import { describe, expect, test } from 'vitest';
import { cleanLine, cleanText } from './clean-text';

// Untrusted text from a task source, cleaned the same way in main (mapping ClickUp's replies) and in the
// renderer (the prompt, saved task links). Invisible characters are built from code points, never written literally.
const C = (...n: number[]) => String.fromCodePoint(...n);

/** Format characters that hide or reorder text: bidi marks, embeddings, overrides, isolates; zero-width; others. */
const INVISIBLES: [string, number][] = [
  ['soft hyphen', 0xad], ['Arabic letter mark', 0x61c], ['Mongolian vowel separator', 0x180e],
  ['zero-width space', 0x200b], ['zero-width non-joiner', 0x200c], ['zero-width joiner', 0x200d], ['LRM', 0x200e], ['RLM', 0x200f],
  ['LRE', 0x202a], ['RLE', 0x202b], ['PDF', 0x202c], ['LRO', 0x202d], ['RLO', 0x202e],
  ['word joiner', 0x2060], ['invisible times', 0x2062], ['LRI', 0x2066], ['RLI', 0x2067], ['FSI', 0x2068], ['PDI', 0x2069],
  ['BOM', 0xfeff]
];

describe('cleanText: multi-line text', () => {
  test.each(INVISIBLES)('%s goes', (_name, cp) => {
    expect(cleanText(`a${C(cp)}b`)).toBe('ab');
  });

  test('line and paragraph separators, CRLF, CR, VT and FF become newlines; tabs and newlines stay', () => {
    expect(cleanText(`a${C(0x2028)}b${C(0x2029)}c\r\nd\re\vf\fg\th\ni`)).toBe('a\nb\nc\nd\ne\nf\ng\th\ni');
  });

  test('C0 controls (but tab and newline), DEL and C1 controls go', () => {
    expect(cleanText(`a\x00\x07\x1b[31mb\x7f${C(0x85)}${C(0x9f)}c`)).toBe('a[31mbc');
  });

  test('printable text, emoji and accents are untouched', () => {
    const s = `Caf${C(0xe9)} ${C(0x1f600)} \`code\` ## title`;
    expect(cleanText(s)).toBe(s);
  });
});

describe('cleanLine: one line', () => {
  test.each(INVISIBLES)('%s goes', (_name, cp) => {
    expect(cleanLine(`a${C(cp)}b`)).toBe('ab');
  });

  test('every line break (U+2028/U+2029 included) and tab is one space; runs collapse; trimmed', () => {
    expect(cleanLine(`  one${C(0x2028)}two${C(0x2029)}three\r\nfour\tfive\v\fsix  `)).toBe('one two three four five six');
  });

  test('controls go', () => {
    expect(cleanLine('ENG-\x077\x1b')).toBe('ENG-7');
  });
});
