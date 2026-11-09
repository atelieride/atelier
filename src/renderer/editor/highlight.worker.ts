/// <reference lib="webworker" />
import { createHighlighterCore, type HighlighterCore, type LanguageInput } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { atelierTheme, DEFAULT_FG } from './theme';
import { compressTokens } from './tokens';
import { hasGrammar, type GrammarLanguage } from '@shared/languages';

// Each language is a separate chunk: loaded only when needed, from the local bundle. Typed by the catalog's ids:
// a language listed in Change Language Mode has a grammar here unless the editor colors it itself (CSV), and every
// grammar here is listed.
const LOADERS: Record<GrammarLanguage, () => LanguageInput> = {
  tsx: () => import('@shikijs/langs/tsx'), typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'), jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'), jsonc: () => import('@shikijs/langs/jsonc'), css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'), html: () => import('@shikijs/langs/html'), markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'), toml: () => import('@shikijs/langs/toml'), shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'), dockerfile: () => import('@shikijs/langs/dockerfile'), dotenv: () => import('@shikijs/langs/dotenv'),
  python: () => import('@shikijs/langs/python'), go: () => import('@shikijs/langs/go'), rust: () => import('@shikijs/langs/rust'),
  xml: () => import('@shikijs/langs/xml'), graphql: () => import('@shikijs/langs/graphql'), prisma: () => import('@shikijs/langs/prisma'),
  make: () => import('@shikijs/langs/make'), diff: () => import('@shikijs/langs/diff'), vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'), log: () => import('@shikijs/langs/log'), nginx: () => import('@shikijs/langs/nginx'),
  ini: () => import('@shikijs/langs/ini'), swift: () => import('@shikijs/langs/swift'), java: () => import('@shikijs/langs/java'),
  php: () => import('@shikijs/langs/php'), ruby: () => import('@shikijs/langs/ruby'),
  gosu: () => import('./grammars/gosu')
};

let hl: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

async function highlighter(): Promise<HighlighterCore> {
  hl ??= createHighlighterCore({ themes: [atelierTheme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  return hl;
}

self.onmessage = async (e: MessageEvent<{ id: number; code: string; lang: string }>) => {
  const { id, code, lang } = e.data;
  try {
    const h = await highlighter();
    const load = hasGrammar(lang) ? LOADERS[lang] : undefined;
    if (!load) { self.postMessage({ id, result: null }); return; }
    if (!loaded.has(lang)) { await h.loadLanguage(load()); loaded.add(lang); }
    const r = h.codeToTokens(code, { lang, theme: 'atelier' });
    self.postMessage({ id, result: compressTokens(r.tokens, DEFAULT_FG) });
  } catch {
    self.postMessage({ id, result: null });
  }
};
