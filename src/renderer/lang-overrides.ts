// Change Language Mode: a language chosen for a file wins over its extension. Kept per absolute path in localStorage
// (a per-viewer convenience: lost storage only means the extension decides again); untitled tabs live in memory only.
import { isLanguage, languageFor, type LanguageId } from '@shared/languages';
import { isAbsPath, isBelow } from '@shared/paths';

/** Path → chosen language, oldest first. */
export type LangOverrides = Record<string, LanguageId>;

/** Files come and go: the least recently chosen ones are forgotten past this many. */
export const MAX_LANG_OVERRIDES = 200;
export const KEY = 'atelier.languageOverrides';

/** The language a tab is highlighted with: the chosen one, otherwise the one its name says (null: plain text). */
export const effectiveLanguage = (path: string, all: Readonly<Record<string, LanguageId>>): LanguageId | null => all[path] ?? languageFor(path);

/** From the saved value (whatever it contains) to valid overrides: absolute paths, known languages. */
export function parseOverrides(raw: string | null): LangOverrides {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: none */ }
  const out: LangOverrides = {};
  for (const [path, lang] of Object.entries(o)) if (isAbsPath(path) && isLanguage(lang)) out[path] = lang;
  return out;
}

/** `path` set to `lang` (it becomes the most recent) or, with null (Auto), removed; bounded. */
export function withOverride(all: LangOverrides, path: string, lang: LanguageId | null): LangOverrides {
  const rest = Object.entries(all).filter(([p]) => p !== path);
  if (lang) rest.push([path, lang]);
  return Object.fromEntries(rest.slice(-MAX_LANG_OVERRIDES)) as LangOverrides;
}

const under = (p: string, path: string) => p === path || isBelow(path, p);

/** A renamed file or folder: the overrides (or any per-path record, e.g. Markdown views) underneath follow the new path (same object when nothing moved). */
export function renameOverrides<T extends Record<string, unknown>>(all: T, from: string, to: string): T {
  if (!Object.keys(all).some((p) => under(p, from))) return all;
  return Object.fromEntries(Object.entries(all).map(([p, l]) => [under(p, from) ? to + p.slice(from.length) : p, l])) as T;
}

/** A file or folder moved to the Trash: its overrides go too (same object when there were none). */
export function dropOverrides<T extends Record<string, unknown>>(all: T, path: string): T {
  if (!Object.keys(all).some((p) => under(p, path))) return all;
  return Object.fromEntries(Object.entries(all).filter(([p]) => !under(p, path))) as T;
}

export function loadOverrides(): LangOverrides {
  try { return typeof localStorage === 'undefined' ? {} : parseOverrides(localStorage.getItem(KEY)); } catch { return {}; }
}

/** Saves the real files' overrides (untitled tabs are not files: their numbers are reused). */
export function saveOverrides(all: LangOverrides): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(all).filter(([p]) => isAbsPath(p)))));
  } catch { /* not saved: stays for this session */ }
}
