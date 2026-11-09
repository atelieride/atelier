import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Wiring the editor's unit tests can't see (bug hunt 2026-10-22): the guards and helpers they test are really used.
const ROOT = join(__dirname, '../..');

test('FileView asks these: its saver\'s isDirty and its save', () => {
  const src = readFileSync(join(ROOT, 'src/renderer/editor/FileView.tsx'), 'utf8');
  expect(src).toMatch(/registerSaver\(file\.path, \(\) => saveRef\.current\(\), \(\) => unsaved\(/);
  expect(src).toMatch(/saveGate\(\{/);
});

test('FileView: the preview, the tree, the table and the file bar\'s JSON and CSV crumbs each have their own boundary, so a throw there never unmounts the editor and its unsaved buffer', () => {
  const src = readFileSync(join(ROOT, 'src/renderer/editor/FileView.tsx'), 'utf8');
  for (const [id, tag] of [['md-preview', 'MarkdownPreview'], ['json-tree', 'JsonPane'], ['csv-table', 'CsvPane'], ['json-path', 'JsonPath'], ['csv-address', 'CsvAddress']]) {
    expect(src, tag).toMatch(new RegExp(`<ErrorBoundary id="${id}"[^\\n]*>\\n\\s*<${tag}\\b`));
  }
});

test('every editor that has keymaps installs the AltGr guard', () => {
  for (const f of ['src/renderer/editor/FileView.tsx', 'src/renderer/scm/RevFileView.tsx']) {
    expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/\baltGrTyping\b/);
  }
});

test('the Markdown preview, its find card and the CSV table leave Ctrl+Shift+G to the menu', () => {
  for (const f of ['src/renderer/markdown/Preview.tsx', 'src/renderer/markdown/PreviewFind.tsx', 'src/renderer/csv/CsvPane.tsx']) {
    expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/!isSourceControlKey\((e|e\.nativeEvent)\)/);
  }
});

// Word wrap: ⌥Z switches it in every editor that wraps.
test('every editor that follows word wrap binds ⌥Z to it', () => {
  for (const f of ['src/renderer/editor/FileView.tsx', 'src/renderer/components/ReviewView.tsx', 'src/renderer/scm/CommitDiff.tsx', 'src/renderer/scm/RevFileView.tsx']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    expect(src, f).toMatch(/EditorView\.lineWrapping/);
    expect(src, f).toMatch(/keymap\.of\(wordWrapKeys\(\)\)/);
  }
});

// ⌥Z is pressed inside these editors: a wrap change remade as a new editor lost the place, the focus and the next ⌥Z.
test('every editor that follows word wrap reconfigures it in place, never in the deps of the effect that makes it', () => {
  for (const f of ['src/renderer/editor/FileView.tsx', 'src/renderer/components/ReviewView.tsx', 'src/renderer/scm/CommitDiff.tsx', 'src/renderer/scm/RevFileView.tsx']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    expect(src, f).toMatch(/\.reconfigure\(wordWrap \? EditorView\.lineWrapping : \[\]\)/);
    expect(src, f).not.toMatch(/\[[^\]\n]+,\s*wordWrap\]\)|\[wordWrap,[^\]\n]+\]\)/);
  }
});

test('Keep Mine also recreates a file deleted since the band showed (as before): it saves with create, against the band', () => {
  const src = readFileSync(join(ROOT, 'src/renderer/editor/FileView.tsx'), 'utf8');
  expect(src).toMatch(/window\.atelier\.files\.save\(file\.path, doc, how\.keep \?\? stamp\.current, eol\.current, !!\(how\.create \|\| how\.keep\)\)/);
});
