// Project vocabulary for dictation: Whisper's initial prompt and the polish context, so the project's names
// (files, folders, branches, sessions, symbols) come out spelled right. whisper.cpp keeps only the last
// ~223 tokens of the prompt: the most relevant terms go last, and past the limit the least relevant are dropped.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{3,}$/;
const ALWAYS = ['Claude', 'CLAUDE.md', 'Atelier'];

export function buildVocabulary(
  o: { project: string | null; branch: string | null; sessions: string[]; files: string[]; identifiers: string[] },
  max = 600
): string {
  const words: string[] = [];
  const seen = new Set<string>();
  const add = (w: string | null | undefined) => {
    const t = (w ?? '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    words.push(t);
  };
  // Always present and the very last ones: dictated "Claude" came out as "cloud" without them.
  for (const w of ALWAYS) add(w);
  add(o.project);
  if (o.branch && o.branch !== 'HEAD') add(o.branch);
  for (const s of o.sessions) add(s);
  for (const f of o.files) {
    const parts = f.split('/').filter(Boolean);
    add(parts.at(-1));
    for (const dir of parts.slice(0, -1)) add(dir);
  }
  for (const id of o.identifiers) if (IDENT.test(id)) add(id);
  // From the most relevant: kept while they fit, then written in reverse (the most relevant last).
  const kept: string[] = [];
  let len = 0;
  for (const w of words) {
    const add = (kept.length ? 2 : 0) + w.length;
    if (len + add > max) break;
    kept.push(w);
    len += add;
  }
  return kept.reverse().join(', ');
}
