// Ask companion: the suggestion chips a Catch me up leads to, and the Why? a choice asks.
// Pure and light (the answer grammar and the strings only), so the live demo's tests check its script against the very
// chips the panel builds (src/demo/engine/ask.test.ts). view.ts re-exports them for the panel.
import { parseInline, plainText } from '@shared/companion/answer';
import type { CatchUp } from '@shared/companion/types';
import { t } from '../i18n/en';

/** A suggestion chip asks its text as is: short enough to read at a glance in one chip. */
const SUGGESTION_MAX = 60;
const fits = (q: string) => q.length <= SUGGESTION_MAX;

/**
 * Why? on a choice: "Why <choice>?" — the choice as it reads (no code ticks, no bold stars, a link by its label), a
 * plain first word lowercased ("Skew window…" → "skew window…"; names, acronyms and "I" kept), the trailing stop dropped.
 */
export function whyQuestion(choice: string): string {
  let s = plainText(parseInline(choice)).replace(/`/g, '').trim().replace(/[\s.…?!]+$/u, '');
  const first = /^\S+/.exec(s)?.[0] ?? '';
  if (/^[A-Z][a-z'’-]*[,;:]?$/.test(first) && first !== 'I' && !/^I['’]/.test(first)) s = s.charAt(0).toLowerCase() + s.slice(1);
  return t.companion.whyQuestion(s);
}

const IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
/** A name worth asking about: camelCase, PascalCase or a call (`TokenStore`, `refresh()`), not a constant or a keyword. */
const NAMED = /[a-z][A-Z]|^[A-Z][a-z]|\(\)$/;
/** A source file's extension (a name with another one, `TokenStore.get` or `v2.9`, is code). */
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|json5?|mdx?|css|scss|sass|less|html?|py|rb|go|rs|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|fs|php|sh|zsh|bash|ps1|ya?ml|toml|ini|cfg|conf|env|sql|graphql|gql|proto|vue|svelte|astro|txt|csv|xml|svg|plist|gradle|lock|dart|ex|exs|erl|lua|r|scala|zig|tf)$/i;
/** A file the summary names: a path, or a name with a source extension. */
const isFile = (code: string) => code.includes('/') || SOURCE_EXT.test(code);

/** A question about the first code the text names: how a name works, what changed in a file; null when none reads well. */
function codeQuestion(text: string): string | null {
  for (const i of parseInline(text)) {
    const code = i.t === 'file' ? i.path : i.t === 'code' ? i.s : null;
    if (code === null) continue;
    const q = isFile(code) ? t.companion.whatChanged(code) : IDENT.test(code) && NAMED.test(code) ? t.companion.howWorks(code) : null;
    if (q && fits(q)) return q;
  }
  return null;
}

/**
 * The chips after a Catch me up: "What's left?", why its first choice that reads well, and one about the
 * code its summary names (what it left open first: a final card shows that); up to three. Nothing when nothing was
 * asked yet ("What's left?" would be a dead end).
 */
export function suggestionsFrom(c: CatchUp): string[] {
  if (c.points.length === 0) return [];
  const out: string[] = [t.companion.whatsLeft];
  const why = c.choices.map(whyQuestion).find(fits);
  if (why) out.push(why);
  const code = (c.leftOpen ? codeQuestion(c.leftOpen) : null) ?? codeQuestion(c.where);
  if (code) out.push(code);
  return out.slice(0, 3);
}
