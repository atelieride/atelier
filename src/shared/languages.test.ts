import { expect, test } from 'vitest';
import { LANGUAGES, hasGrammar, isLanguage, languageFor, languageLabel, mainExtension } from './languages';

test('the catalog lists every highlightable language once, sorted by label, with a readable name', () => {
  const ids = LANGUAGES.map((l) => l.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining(['markdown', 'json', 'typescript', 'tsx', 'python', 'dockerfile', 'make', 'dotenv']));
  const labels = LANGUAGES.map((l) => l.label);
  expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  expect(languageLabel('markdown')).toBe('Markdown');
  expect(languageLabel('json')).toBe('JSON');
  expect(languageLabel('shellscript')).toBe('Shell Script');
  expect(languageLabel('gosu')).toBe('Gosu');
  expect(languageLabel('csv')).toBe('CSV');
  expect(languageLabel('tsv')).toBe('TSV');
  expect(languageLabel(null)).toBeNull();
  expect(languageLabel('cobol')).toBeNull();
  expect(isLanguage('yaml')).toBe(true);
  expect(isLanguage('cobol')).toBe(false);
  expect(isLanguage(42)).toBe(false);
});

test('a language main extension maps back to that language (Save as suggests it)', () => {
  expect(mainExtension('markdown')).toBe('md');
  expect(mainExtension('typescript')).toBe('ts');
  expect(mainExtension('dockerfile')).toBeNull();
  expect(mainExtension(null)).toBeNull();
  for (const l of LANGUAGES) if (l.ext) expect(languageFor(`/p/x.${l.ext}`), l.id).toBe(l.id);
});

test.each([
  ['/p/a.tsx', 'tsx'], ['/p/a.ts', 'typescript'], ['/p/a.mts', 'typescript'], ['/p/a.js', 'javascript'], ['/p/a.cjs', 'javascript'],
  ['/p/a.jsx', 'jsx'], ['/p/package.json', 'json'], ['/p/tsconfig.json', 'jsonc'], ['/p/.vscode/settings.json', 'jsonc'],
  ['/p/a.css', 'css'], ['/p/a.scss', 'scss'], ['/p/a.html', 'html'], ['/p/README.md', 'markdown'], ['/p/a.yml', 'yaml'],
  ['/p/a.yaml', 'yaml'], ['/p/a.toml', 'toml'], ['/p/dev.sh', 'shellscript'], ['/p/.zshrc', 'shellscript'], ['/p/q.sql', 'sql'],
  ['/p/Dockerfile', 'dockerfile'], ['/p/Dockerfile.dev', 'dockerfile'], ['/p/.env', 'dotenv'], ['/p/.env.local', 'dotenv'],
  ['/p/a.py', 'python'], ['/p/a.go', 'go'], ['/p/a.rs', 'rust'], ['/p/a.xml', 'xml'], ['/p/a.svg', 'xml'], ['/p/a.graphql', 'graphql'],
  ['/p/schema.prisma', 'prisma'], ['/p/Makefile', 'make'], ['/p/a.diff', 'diff'], ['/p/a.vue', 'vue'], ['/p/a.log', 'log'],
  ['/p/nginx.conf', 'nginx'], ['/p/a.ini', 'ini'], ['/p/Claim.gs', 'gosu'], ['/p/ClaimEnhancement.gsx', 'gosu'],
  ['/p/run.gsp', 'gosu'], ['/p/orders.csv', 'csv'], ['/p/ORDERS.CSV', 'csv'], ['/p/export.tsv', 'tsv'], ['/p/export.tab', 'tsv'],
  ['/p/LICENSE', null], ['/p/a.sconosciuta', null]
])('%s → %s', (p, lang) => expect(languageFor(p)).toBe(lang));

test('CSV and TSV: colored by the editor, not by a grammar', () => {
  expect(hasGrammar('csv')).toBe(false);
  expect(hasGrammar('tsv')).toBe(false);
  expect(hasGrammar('json')).toBe(true);
  expect(hasGrammar(null)).toBe(false);
  expect(mainExtension('csv')).toBe('csv');
  expect(mainExtension('tsv')).toBe('tsv');
});
