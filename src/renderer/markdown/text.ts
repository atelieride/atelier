// Small text rules of the Markdown preview: heading slugs, code fence languages,
// front matter pills, reading stats.
import { isLanguage, languageFor, type LanguageId } from '@shared/languages';

/** GitHub's heading slugs (github-slugger): lowercase, punctuation removed, each space a dash, repeats numbered. */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    let slug = base;
    let n = seen.get(base) ?? 0;
    while (seen.has(slug)) slug = `${base}-${++n}`;
    seen.set(base, n);
    seen.set(slug, 0);
    return slug;
  };
}

const FENCE_ALIASES: Record<string, LanguageId> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript', shellsession: 'shellscript',
  py: 'python', python3: 'python', rb: 'ruby', rs: 'rust', yml: 'yaml', md: 'markdown', golang: 'go', htm: 'html', svg: 'xml',
  json5: 'jsonc', env: 'dotenv', docker: 'dockerfile', makefile: 'make', patch: 'diff', gql: 'graphql'
};

/** The editor language of a code fence's info string (`ts {1,3}` → typescript); null for unknown ones (plain). */
export function fenceLanguage(info: string | null | undefined): LanguageId | null {
  const word = (info ?? '').trim().split(/[\s{]/)[0]?.toLowerCase() ?? '';
  if (!word) return null;
  if (isLanguage(word)) return word;
  // Own keys only: a fence named constructor is not a language.
  return Object.hasOwn(FENCE_ALIASES, word) ? FENCE_ALIASES[word]! : languageFor(`x.${word}`);
}

export interface FrontPair { key: string; value: string }
const MAX_PAIRS = 12;

/** Flat `key: value` front matter as pills; null when anything is nested, multi-line or not a pair. */
export function parseFrontMatter(yaml: string): FrontPair[] | null {
  const out: FrontPair[] = [];
  for (const line of yaml.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_.-]+):[ \t]*(.*?)\s*$/.exec(line);
    if (!m || !m[2] || /^[|>]/.test(m[2])) return null;
    const v = m[2];
    const quoted = /^(["'])(.*)\1$/.exec(v);
    out.push({ key: m[1]!, value: quoted ? quoted[2]! : v });
  }
  return out.length && out.length <= MAX_PAIRS ? out : null;
}

/** A status pill's tone: amber while in progress, green when done, rose when blocked. */
export function statusTone(key: string, value: string): 'waiting' | 'done' | 'error' | null {
  if (key.toLowerCase() !== 'status') return null;
  const v = value.trim().toLowerCase();
  if (/^(draft|wip|in[ -]progress|proposed|todo|open|review|in review)$/.test(v)) return 'waiting';
  if (/^(done|approved|accepted|shipped|merged|complete|completed|final|stable)$/.test(v)) return 'done';
  if (/^(blocked|rejected|abandoned|deprecated)$/.test(v)) return 'error';
  return null;
}

/** Words of the rendered text and reading minutes (230 a minute, at least 1 when there is text). */
export function readingStats(text: string): { words: number; minutes: number } {
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return { words, minutes: words ? Math.max(1, Math.round(words / 230)) : 0 };
}
