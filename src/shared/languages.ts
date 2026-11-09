/**
 * Every language the editor knows: the worker has a grammar for each (its loaders are typed by these ids), except the
 * ones the editor colors itself (NO_GRAMMAR).
 */
const CATALOG = [
  { id: 'css', label: 'CSS', ext: 'css' }, { id: 'csv', label: 'CSV', ext: 'csv' }, { id: 'diff', label: 'Diff', ext: 'diff' }, { id: 'dockerfile', label: 'Dockerfile', ext: null },
  { id: 'dotenv', label: 'Dotenv', ext: null }, { id: 'go', label: 'Go', ext: 'go' }, { id: 'gosu', label: 'Gosu', ext: 'gs' },
  { id: 'graphql', label: 'GraphQL', ext: 'graphql' },
  { id: 'html', label: 'HTML', ext: 'html' }, { id: 'ini', label: 'INI', ext: 'ini' }, { id: 'java', label: 'Java', ext: 'java' },
  { id: 'javascript', label: 'JavaScript', ext: 'js' }, { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'jsonc', label: 'JSON with Comments', ext: 'jsonc' }, { id: 'jsx', label: 'JSX', ext: 'jsx' }, { id: 'log', label: 'Log', ext: 'log' },
  { id: 'make', label: 'Makefile', ext: null }, { id: 'markdown', label: 'Markdown', ext: 'md' }, { id: 'nginx', label: 'Nginx', ext: 'conf' },
  { id: 'php', label: 'PHP', ext: 'php' }, { id: 'prisma', label: 'Prisma', ext: 'prisma' }, { id: 'python', label: 'Python', ext: 'py' },
  { id: 'ruby', label: 'Ruby', ext: 'rb' }, { id: 'rust', label: 'Rust', ext: 'rs' }, { id: 'scss', label: 'SCSS', ext: 'scss' },
  { id: 'shellscript', label: 'Shell Script', ext: 'sh' }, { id: 'sql', label: 'SQL', ext: 'sql' }, { id: 'svelte', label: 'Svelte', ext: 'svelte' },
  { id: 'swift', label: 'Swift', ext: 'swift' }, { id: 'toml', label: 'TOML', ext: 'toml' }, { id: 'tsv', label: 'TSV', ext: 'tsv' }, { id: 'tsx', label: 'TSX', ext: 'tsx' },
  { id: 'typescript', label: 'TypeScript', ext: 'ts' }, { id: 'vue', label: 'Vue', ext: 'vue' }, { id: 'xml', label: 'XML', ext: 'xml' },
  { id: 'yaml', label: 'YAML', ext: 'yaml' }
] as const;

export type LanguageId = (typeof CATALOG)[number]['id'];
/** CSV viewer: rainbow columns come from the editor, which knows the file's delimiter. */
const NO_GRAMMAR = ['csv', 'tsv'] as const;
/** The languages the highlighter's worker has a grammar for. */
export type GrammarLanguage = Exclude<LanguageId, (typeof NO_GRAMMAR)[number]>;
export const hasGrammar = (id: string | null): id is GrammarLanguage => isLanguage(id) && !(NO_GRAMMAR as readonly string[]).includes(id);
/** id: the highlighter's; label: what the editor shows; ext: the main extension (Save as suggests it), null when files go by name. */
export interface LanguageInfo { id: LanguageId; label: string; ext: string | null }

/** The languages to pick from (Change Language Mode), sorted by label. */
export const LANGUAGES: readonly LanguageInfo[] = [...CATALOG].sort((a, b) => a.label.localeCompare(b.label));
const BY_ID = new Map<string, LanguageInfo>(LANGUAGES.map((l) => [l.id, l]));

export const isLanguage = (x: unknown): x is LanguageId => typeof x === 'string' && BY_ID.has(x);
/** The readable name ("Markdown"), null for plain text or an unknown id. */
export const languageLabel = (id: string | null): string | null => (id ? BY_ID.get(id)?.label ?? null : null);
/** The extension a new file of that language usually has ("md"), null when there is none. */
export const mainExtension = (id: string | null): string | null => (id ? BY_ID.get(id)?.ext ?? null : null);

const BY_EXT: Record<string, LanguageId> = {
  tsx: 'tsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', json: 'json', jsonc: 'jsonc', json5: 'jsonc', css: 'css', scss: 'scss', html: 'html', htm: 'html',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  sql: 'sql', py: 'python', go: 'go', rs: 'rust', xml: 'xml', svg: 'xml', plist: 'xml', graphql: 'graphql', gql: 'graphql',
  prisma: 'prisma', diff: 'diff', patch: 'diff', vue: 'vue', svelte: 'svelte', log: 'log', conf: 'nginx', ini: 'ini', cfg: 'ini',
  swift: 'swift', java: 'java', php: 'php', rb: 'ruby', gs: 'gosu', gsx: 'gosu', gsp: 'gosu', csv: 'csv', tsv: 'tsv', tab: 'tsv'
};
const JSONC_NAMES = new Set(['tsconfig.json', 'jsconfig.json', 'settings.json', 'launch.json', 'tasks.json', 'extensions.json', 'devcontainer.json']);
const SHELL_NAMES = new Set(['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile']);

export function languageFor(path: string): LanguageId | null {
  const name = path.split('/').at(-1) ?? path;
  if (/^Dockerfile(\..+)?$/.test(name)) return 'dockerfile';
  if (name === 'Makefile' || name === 'makefile') return 'make';
  if (/^\.env(\..+)?$/.test(name)) return 'dotenv';
  if (SHELL_NAMES.has(name)) return 'shellscript';
  if (JSONC_NAMES.has(name)) return 'jsonc';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  // Own keys only: a file named a.constructor is not a language.
  return Object.hasOwn(BY_EXT, ext) ? BY_EXT[ext]! : null;
}
