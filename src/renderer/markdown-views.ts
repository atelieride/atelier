// Markdown preview: the view of each Markdown file (Source, Split, Preview), kept per
// absolute path in localStorage like the language overrides (a per-viewer convenience: lost storage only means the
// default view from Settings); untitled tabs live in memory only.
import { dropOverrides, effectiveLanguage, renameOverrides } from './lang-overrides';
import type { LanguageId } from '@shared/languages';
import { isAbsPath } from '@shared/paths';

export type MdView = 'source' | 'split' | 'preview';
export type MdViews = Record<string, MdView>;

export const MAX_MD_VIEWS = 200;
export const KEY = 'atelier.markdownViews';
const VIEWS: readonly string[] = ['source', 'split', 'preview'];
const isView = (v: unknown): v is MdView => typeof v === 'string' && VIEWS.includes(v);

/** Whether a tab gets the preview: its effective language (extension or Change Language Mode) is Markdown. */
export const isMarkdownTab = (path: string, overrides: Readonly<Record<string, LanguageId>>): boolean => effectiveLanguage(path, overrides) === 'markdown';

/** JSON navigation: a JSON tab's views are the same three, `preview` being its Tree. */
export const isJsonTab = (path: string, overrides: Readonly<Record<string, LanguageId>>): boolean => {
  const lang = effectiveLanguage(path, overrides);
  return lang === 'json' || lang === 'jsonc';
};

/** CSV viewer: a CSV or TSV tab's views are the same three, `preview` being its Table. */
export const isCsvTab = (path: string, overrides: Readonly<Record<string, LanguageId>>): boolean => {
  const lang = effectiveLanguage(path, overrides);
  return lang === 'csv' || lang === 'tsv';
};

/** Markdown, JSON or CSV: the tab has the Source · Split · Preview (Tree, Table) switch. */
export const isPreviewTab = (path: string, overrides: Readonly<Record<string, LanguageId>>): boolean =>
  isMarkdownTab(path, overrides) || isJsonTab(path, overrides) || isCsvTab(path, overrides);

/** The view a tab opens in without a choice of its own: Settings' Markdown default, or its JSON or CSV one. */
export const defaultView = (path: string, overrides: Readonly<Record<string, LanguageId>>, settings: { markdownView: 'source' | 'preview'; jsonView: 'source' | 'tree'; csvView: 'source' | 'table' }): 'source' | 'preview' =>
  isJsonTab(path, overrides) ? (settings.jsonView === 'tree' ? 'preview' : 'source')
    : isCsvTab(path, overrides) ? (settings.csvView === 'table' ? 'preview' : 'source')
      : settings.markdownView;

/** From the saved value (whatever it contains) to valid views: absolute paths, known views. */
export function parseMdViews(raw: string | null): MdViews {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: none */ }
  const out: MdViews = {};
  for (const [path, view] of Object.entries(o)) if (isAbsPath(path) && isView(view)) out[path] = view;
  return out;
}

/** The view a file shows: its own, otherwise the default from Settings. */
export const mdViewOf = (all: Readonly<MdViews>, path: string, fallback: 'source' | 'preview'): MdView => all[path] ?? fallback;

/** `path` set to `view` (the newest entry); the default view needs no entry. Bounded. */
export function withMdView(all: MdViews, path: string, view: MdView, fallback: 'source' | 'preview'): MdViews {
  const rest = Object.entries(all).filter(([p]) => p !== path);
  if (view !== fallback) rest.push([path, view]);
  return Object.fromEntries(rest.slice(-MAX_MD_VIEWS)) as MdViews;
}

export const renameMdViews = (all: MdViews, from: string, to: string): MdViews => renameOverrides(all, from, to);
export const dropMdViews = (all: MdViews, path: string): MdViews => dropOverrides(all, path);

/** ⇧⌘V: Preview goes back to Source; Source and Split go to Preview. */
export const toggledView = (view: MdView): MdView => (view === 'preview' ? 'source' : 'preview');

export function loadMdViews(): MdViews {
  try { return typeof localStorage === 'undefined' ? {} : parseMdViews(localStorage.getItem(KEY)); } catch { return {}; }
}

/** Saves the real files' views (untitled tabs are not files: their numbers are reused). */
export function saveMdViews(all: MdViews): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(all).filter(([p]) => isAbsPath(p)))));
  } catch { /* not saved: stays for this session */ }
}
