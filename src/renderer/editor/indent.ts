// Rules of the open file, detected from its text: indentation, line endings, comments.

/** Indentation: tabs if most indented lines use tabs; otherwise 2 or 4 spaces; default 2 spaces. */
export function detectIndent(text: string): { unit: string; tabSize: number } {
  let tabs = 0; let spaces = 0; let two = 0; let four = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) { tabs++; continue; }
    const n = /^ */.exec(line)![0].length;
    // A whitespace-only line, or an indent of 1 (e.g. " * " in JSDoc comments), says nothing.
    if (n < 2 || n === line.length) continue;
    spaces++;
    if (n % 4 === 0) four++; else if (n % 2 === 0) two++;
  }
  if (tabs > spaces) return { unit: '\t', tabSize: 4 };
  if (spaces === 0) return { unit: '  ', tabSize: 2 };
  return two > 0 && two >= four * 0.2 ? { unit: '  ', tabSize: 2 } : four > 0 ? { unit: '    ', tabSize: 4 } : { unit: '  ', tabSize: 2 };
}

/** The ending most lines have: CRLF if more lines end with CRLF than with LF alone (a tie stays LF). */
export function detectEol(text: string): 'lf' | 'crlf' {
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > lf - crlf ? 'crlf' : 'lf';
}

/**
 * Lines ending with both LF and CRLF, or a lone CR (not part of a CRLF, which the editor reads as a line break): on save
 * they all become as detectEol says, and the editor tells the user.
 */
export function hasMixedEol(text: string): boolean {
  if (/\r(?!\n)/.test(text)) return true;
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > 0 && crlf < lf;
}

type Tokens = { line?: string; block?: { open: string; close: string } };
const C_LIKE: Tokens = { line: '//', block: { open: '/*', close: '*/' } };
const HASH: Tokens = { line: '#' };
const MARKUP: Tokens = { block: { open: '<!--', close: '-->' } };
const BY_LANG: Record<string, Tokens> = {
  typescript: C_LIKE, tsx: C_LIKE, javascript: C_LIKE, jsx: C_LIKE, jsonc: C_LIKE, go: C_LIKE, rust: C_LIKE, swift: C_LIKE, java: C_LIKE, php: C_LIKE,
  scss: C_LIKE, prisma: { line: '//' }, graphql: HASH, css: { block: { open: '/*', close: '*/' } },
  python: HASH, shellscript: HASH, yaml: HASH, toml: HASH, dotenv: HASH, dockerfile: HASH, make: HASH, ruby: HASH, nginx: HASH, ini: { line: ';' },
  sql: { line: '--', block: { open: '/*', close: '*/' } },
  html: MARKUP, xml: MARKUP, markdown: MARKUP, vue: MARKUP, svelte: MARKUP
};

/** Comment symbols for ⌘/ (null if the language is unknown or has no comments). */
export function commentTokens(lang: string | null): Tokens | null {
  return lang ? BY_LANG[lang] ?? null : null;
}
