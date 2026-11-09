import { expect, test } from 'vitest';
import { caretBeforeSuffix, completeFolder, folderQuery, isUntitled, missingName, nextUntitled, outsideName, suggestedSuffix } from './untitled';

test('Save as with a chosen language: its extension is suggested, never for plain text or a name-only language', () => {
  expect(suggestedSuffix('markdown')).toBe('.md');
  expect(suggestedSuffix('json')).toBe('.json');
  expect(suggestedSuffix(null)).toBe('');
  expect(suggestedSuffix('dockerfile')).toBe('');
});

test('the suggested extension does not search the folders, and the caret stays before it', () => {
  expect(folderQuery('.md', '.md')).toBe('');
  expect(folderQuery('no.md', '.md')).toBe('no');
  expect(folderQuery('notes/x.md', '.md')).toBe('notes');
  expect(folderQuery('no.md', '')).toBe('no.md');
  expect(caretBeforeSuffix('notes/.md', '.md')).toBe(6);
  expect(caretBeforeSuffix('notes/x.txt', '.md')).toBe(11);
  expect(caretBeforeSuffix('notes/', '')).toBe(6);
  // Tab on a folder keeps the suggested extension after it.
  expect(completeFolder('no.md', 'notes', '.md')).toBe('notes/.md');
  expect(completeFolder('.md', '', '.md')).toBe('.md');
  expect(completeFolder('nts/x.md', 'notes', '.md')).toBe('notes/x.md');
  expect(completeFolder('no.txt', 'notes', '.md')).toBe('notes/');
});

test('Save as needs a name: an empty field, a folder, or only the suggested extension is not one', () => {
  expect(missingName('', '')).toBe(true);
  expect(missingName('notes/', '')).toBe(true);
  expect(missingName('.md', '.md')).toBe(true);
  expect(missingName('notes/.md', '.md')).toBe(true);
  expect(missingName('notes/a.md', '.md')).toBe(false);
  expect(missingName('.env', '')).toBe(false);
  expect(missingName('.md', '')).toBe(false);
});

test('untitled keys never look like a real (absolute) path', () => {
  expect(isUntitled('untitled:1')).toBe(true);
  expect(isUntitled('/p/untitled:1')).toBe(false);
  expect(isUntitled('/p/a.ts')).toBe(false);
});

test('Untitled-N takes the lowest free number', () => {
  expect(nextUntitled([])).toEqual({ path: 'untitled:1', rel: 'Untitled-1' });
  expect(nextUntitled(['untitled:1', '/p/a.ts', 'untitled:3'])).toEqual({ path: 'untitled:2', rel: 'Untitled-2' });
  expect(nextUntitled(['untitled:2'])).toEqual({ path: 'untitled:1', rel: 'Untitled-1' });
});

test('folder completion: what is typed before the last slash searches the folders', () => {
  expect(folderQuery('no')).toBe('no');
  expect(folderQuery('notes/to')).toBe('notes');
  expect(folderQuery('./src/a.ts')).toBe('src');
  expect(folderQuery('')).toBe('');
});

test('completing a folder keeps the file name typed after the last slash', () => {
  expect(completeFolder('no', 'notes')).toBe('notes/');
  expect(completeFolder('nts/todo.md', 'notes')).toBe('notes/todo.md');
  expect(completeFolder('src/x.ts', '')).toBe('x.ts');
  expect(completeFolder('', 'apps/web')).toBe('apps/web/');
});

test('Save Outside the Project…: the save panel offers the name typed after the last slash, else the tab\'s name with the suggested extension', () => {
  expect(outsideName('notes/todo.md', '', 'Untitled-1')).toBe('todo.md');
  expect(outsideName('./todo.md', '.md', 'Untitled-1')).toBe('todo.md');
  expect(outsideName('', '', 'Untitled-1')).toBe('Untitled-1');
  expect(outsideName('.md', '.md', 'Untitled-2')).toBe('Untitled-2.md');
  expect(outsideName('notes/', '.md', 'Untitled-1')).toBe('Untitled-1.md');
  expect(outsideName('notes/.md', '.md', 'Untitled-1')).toBe('Untitled-1.md');
  expect(outsideName('  draft.txt ', '', 'Untitled-1')).toBe('draft.txt');
});
