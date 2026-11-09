import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from './store';
import { registerSaver } from './editor/savers';
import { answerUnsaved } from './confirms/answer-for-tests';

const saveAs = vi.fn(async (rel: string, _text: string): Promise<{ path: string } | { error: string }> => (rel === 'taken.md' ? { error: 'exists' } : { path: `/real/p/${rel}` }));
let answer: 'save' | 'discard' | 'cancel' = 'save';
let answering: ReturnType<typeof answerUnsaved>;

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { atelier: { files: { saveAs }, terminals: { close: async () => {} } } };
  answering = answerUnsaved(() => answer);
  saveAs.mockClear();
  answer = 'save';
  useApp.setState({ openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, dirty: {}, preview: null, recentFiles: [], saveAs: null, settings: DEFAULT_SETTINGS,
    project: { root: '/p', realRoot: '/real/p', name: 'p' } });
});
afterEach(() => { answering.stop(); delete (globalThis as unknown as { window?: unknown }).window; });

const st = () => useApp.getState();
const paths = () => st().openFiles.map((f) => f.path);

test('New File: Untitled-N with the lowest free N, a normal active tab, not among the recents', () => {
  st().openFile('/p/a.ts', 'a.ts', null, undefined, { preview: true });
  st().newUntitled();
  st().newUntitled();
  expect(st().openFiles.map((f) => [f.path, f.rel])).toEqual([['/p/a.ts', 'a.ts'], ['untitled:1', 'Untitled-1'], ['untitled:2', 'Untitled-2']]);
  expect(st().activeTab).toBe('untitled:2');
  expect(st().preview).toBe('/p/a.ts');
  st().closeTab('untitled:1');
  st().newUntitled();
  expect(st().activeTab).toBe('untitled:1');
  expect(st().recentFiles.map((f) => f.path)).toEqual(['/p/a.ts']);
  // Go to line on an untitled tab: still not a recent file.
  st().openFile('untitled:1', 'Untitled-1', 3, undefined, { preview: true });
  expect(st().recentFiles.map((f) => f.path)).toEqual(['/p/a.ts']);
});

test('Save as: the sheet asks, the main process writes, the tab becomes the real file in the same position', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  st().newUntitled();
  st().openFile('/p/b.ts', 'b.ts');
  st().activate('f:untitled:1');
  st().setDirty('untitled:1', true);
  const tree = st().treeNonce;
  const done = st().requestSaveAs('untitled:1', () => 'hello\n');
  expect(st().saveAs?.path).toBe('untitled:1');
  expect(await st().submitSaveAs('taken.md')).toEqual({ error: 'exists' });
  expect(st().saveAs).not.toBeNull();
  expect(await st().submitSaveAs('notes/todo.md')).toEqual({ path: '/real/p/notes/todo.md' });
  expect(saveAs).toHaveBeenLastCalledWith('notes/todo.md', 'hello\n');
  expect(await done).toBe(true);
  expect(st().saveAs).toBeNull();
  expect(st().tabOrder).toEqual(['f:/p/a.ts', 'f:/real/p/notes/todo.md', 'f:/p/b.ts']);
  expect(st().openFiles.find((f) => f.path === '/real/p/notes/todo.md')?.rel).toBe('notes/todo.md');
  expect(st().activeTab).toBe('/real/p/notes/todo.md');
  expect(st().dirty['untitled:1']).toBeUndefined();
  expect(st().recentFiles[0]).toEqual({ path: '/real/p/notes/todo.md', rel: 'notes/todo.md' });
  expect(st().treeNonce).toBe(tree + 1);
});

test('Save as outside the project: main\'s panel picks the place; the tab becomes that outside file, labelled as Open File… labels it; Cancel in the panel keeps the sheet', async () => {
  let reply: { path: string; rel: string } | { error: string } | { canceled: true } = { canceled: true };
  const saveAsOutside = vi.fn(async (_name: string, _text: string, _unsaved: string[]) => reply);
  (window as unknown as { atelier: { files: object } }).atelier.files = { saveAs, saveAsOutside };
  st().openFile('/Users/x/Desktop/todo.md', '~/Desktop/todo.md');
  st().openFile('/p/clean.ts', 'clean.ts');
  st().setDirty('/Users/x/Desktop/todo.md', true);
  st().newUntitled();
  st().setDirty('untitled:1', true);
  const done = st().requestSaveAs('untitled:1', () => '# notes\n');
  // The panel canceled: nothing changes, the sheet stays for another try. Main hears which files have unsaved edits
  // (never replaced), the untitled buffer itself left out.
  expect(await st().submitSaveAsOutside('notes.md')).toEqual({ canceled: true });
  expect(saveAsOutside).toHaveBeenLastCalledWith('notes.md', '# notes\n', ['/Users/x/Desktop/todo.md']);
  expect(st().saveAs).not.toBeNull();
  expect(paths()).toEqual(['/Users/x/Desktop/todo.md', '/p/clean.ts', 'untitled:1']);
  // Refused: the reason, the sheet still open.
  reply = { error: 'trash-failed' };
  expect(await st().submitSaveAsOutside('notes.md')).toEqual({ error: 'trash-failed' });
  expect(st().saveAs).not.toBeNull();
  // Saved: the tab is the outside file, as main labels it (~ for the home).
  reply = { path: '/Users/x/Desktop/notes.md', rel: '~/Desktop/notes.md' };
  expect(await st().submitSaveAsOutside('notes.md')).toEqual(reply);
  expect(await done).toBe(true);
  expect(st().saveAs).toBeNull();
  expect(st().openFiles.map((f) => [f.path, f.rel])).toEqual([['/Users/x/Desktop/todo.md', '~/Desktop/todo.md'], ['/p/clean.ts', 'clean.ts'], ['/Users/x/Desktop/notes.md', '~/Desktop/notes.md']]);
  expect(st().activeTab).toBe('/Users/x/Desktop/notes.md');
  expect(st().dirty['untitled:1']).toBeUndefined();
  expect(st().recentFiles[0]).toEqual({ path: '/Users/x/Desktop/notes.md', rel: '~/Desktop/notes.md' });
});

test('Esc on the sheet: nothing is written and the save answers false', async () => {
  st().newUntitled();
  const done = st().requestSaveAs('untitled:1', () => 'x');
  st().cancelSaveAs();
  expect(await done).toBe(false);
  expect(saveAs).not.toHaveBeenCalled();
  expect(paths()).toEqual(['untitled:1']);
});

test('closing a dirty untitled tab: Save goes through the sheet, then the (now real) tab closes; Cancel on the sheet keeps it', async () => {
  st().newUntitled();
  st().setDirty('untitled:1', true);
  const off = registerSaver('untitled:1', () => st().requestSaveAs('untitled:1', () => 'text'), () => true);
  try {
    answer = 'save';
    const closing = st().closeTabs(['f:untitled:1']);
    await vi.waitFor(() => expect(st().saveAs).not.toBeNull());
    st().cancelSaveAs();
    await closing;
    expect(paths()).toEqual(['untitled:1']);

    const again = st().closeTabs(['f:untitled:1']);
    await vi.waitFor(() => expect(st().saveAs).not.toBeNull());
    await st().submitSaveAs('kept.md');
    await again;
    expect(paths()).toEqual([]);
    expect(st().tabOrder).toEqual([]);
  } finally { off(); }
});

test('untitled tabs are ignored by what assumes a real path: renames, disk changes', () => {
  st().newUntitled();
  st().renameOpenFiles('/p', '/q', '/p');
  st().filesChanged(['untitled:1']);
  expect(paths()).toEqual(['untitled:1']);
  expect(st().diskNonce['untitled:1']).toBeUndefined();
});

test('the unsaved-changes question asks about the untitled tab by its key; the sheet names it as its tab does ("Untitled-1")', async () => {
  st().openFile('/p/src/a.ts', 'src/a.ts');
  st().newUntitled();
  st().setDirty('/p/src/a.ts', true);
  st().setDirty('untitled:1', true);
  answer = 'cancel';
  await st().closeTabs(['f:/p/src/a.ts', 'f:untitled:1']);
  expect(answering.asked.at(-1)!.paths).toEqual(['/p/src/a.ts', 'untitled:1']);
  const { unsavedFiles } = await import('./confirms/UnsavedHost');
  expect(unsavedFiles(['/p/src/a.ts', 'untitled:1'], st().openFiles).map((f) => [f.name, f.dir])).toEqual([['a.ts', 'src'], ['Untitled-1', '']]);
});

test('Close Others → Save after an earlier Save as: a new tab reusing the untitled number is not mistaken for the saved file', async () => {
  st().newUntitled();
  const first = st().requestSaveAs('untitled:1', () => 'notes\n');
  await st().submitSaveAs('notes.md');
  expect(await first).toBe(true);
  // ⌘⌥N again: the lowest free number is 1 again.
  st().newUntitled();
  st().openFile('/p/b.ts', 'b.ts');
  st().setDirty('/real/p/notes.md', true);
  st().setDirty('/p/b.ts', true);
  const saved: string[] = [];
  const offB = registerSaver('/p/b.ts', async () => { saved.push('b'); return true; });
  try {
    answer = 'save';
    // Close Others on notes.md: the new (clean) untitled tab and b.ts close, notes.md stays.
    await st().closeTabs(['f:untitled:1', 'f:/p/b.ts']);
    expect(saved).toEqual(['b']);
    expect(paths()).toEqual(['/real/p/notes.md']);
  } finally { offB(); }
});

test('while the Save as write is in flight, Esc / a click outside cannot cancel it: the tab still becomes the file', async () => {
  st().newUntitled();
  st().setDirty('untitled:1', true);
  let finish: (r: { path: string }) => void = () => {};
  saveAs.mockImplementationOnce(() => new Promise((res) => { finish = res; }));
  const done = st().requestSaveAs('untitled:1', () => 'x');
  const writing = st().submitSaveAs('slow.md');
  st().cancelSaveAs();
  expect(st().saveAs).not.toBeNull();
  finish({ path: '/real/p/slow.md' });
  expect(await writing).toEqual({ path: '/real/p/slow.md' });
  expect(await done).toBe(true);
  expect(paths()).toEqual(['/real/p/slow.md']);
  expect(st().dirty['untitled:1']).toBeUndefined();
});

test('closing the untitled tab ("Don\'t Save") while its Save as sheet is open closes the sheet: Enter afterwards writes nothing', async () => {
  st().newUntitled();
  st().setDirty('untitled:1', true);
  const done = st().requestSaveAs('untitled:1', () => '');
  answer = 'discard';
  await st().closeTabs(['f:untitled:1']);
  expect(paths()).toEqual([]);
  expect(st().saveAs).toBeNull();
  expect(await done).toBe(false);
  expect(await st().submitSaveAs('empty.md')).toEqual({ error: 'cancelled' });
  expect(saveAs).not.toHaveBeenCalled();
});

describe('Change Language Mode', () => {
  const mem = new Map<string, string>();
  const saved = () => JSON.parse(mem.get('atelier.languageOverrides') ?? '{}') as Record<string, string>;
  beforeEach(() => {
    mem.clear();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) };
    useApp.setState({ langOverrides: {}, languageSheet: null, paletteOpen: false });
  });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  test('the sheet opens for a tab (closing the palette and any menu) and closes', () => {
    useApp.setState({ paletteOpen: true });
    st().setLanguageSheet('/p/a.txt');
    expect(st().languageSheet).toBe('/p/a.txt');
    expect(st().paletteOpen).toBe(false);
    st().setLanguageSheet(null);
    expect(st().languageSheet).toBeNull();
  });

  test('a real file remembers its language (saved); an untitled tab only in memory; Auto removes it', () => {
    st().newUntitled();
    st().setLanguage('untitled:1', 'markdown');
    st().setLanguage('/p/a.txt', 'json');
    expect(st().langOverrides).toEqual({ 'untitled:1': 'markdown', '/p/a.txt': 'json' });
    expect(saved()).toEqual({ '/p/a.txt': 'json' });
    st().setLanguage('/p/a.txt', null);
    expect(st().langOverrides).toEqual({ 'untitled:1': 'markdown' });
    expect(saved()).toEqual({});
    // Picking what the extension already says is the same as Auto: nothing to remember.
    st().setLanguage('/p/b.md', 'json');
    st().setLanguage('/p/b.md', 'markdown');
    expect(saved()).toEqual({});
  });

  test('a new untitled tab reusing a number starts as plain text', () => {
    st().newUntitled();
    st().setLanguage('untitled:1', 'markdown');
    st().closeTab('untitled:1');
    st().newUntitled();
    expect(st().langOverrides['untitled:1']).toBeUndefined();
  });

  test('Save as keeps the chosen language when the new name does not already say it', async () => {
    st().newUntitled();
    st().setLanguage('untitled:1', 'markdown');
    void st().requestSaveAs('untitled:1', () => '# hi');
    await st().submitSaveAs('notes');
    expect(st().langOverrides).toEqual({ '/real/p/notes': 'markdown' });
    expect(saved()).toEqual({ '/real/p/notes': 'markdown' });
    st().newUntitled();
    st().setLanguage('untitled:1', 'markdown');
    void st().requestSaveAs('untitled:1', () => '# hi');
    await st().submitSaveAs('todo.md');
    expect(st().langOverrides['/real/p/todo.md']).toBeUndefined();
    expect(st().langOverrides['untitled:1']).toBeUndefined();
  });

  test('overrides follow renames (open or not) and go with trashed files', () => {
    st().setLanguage('/p/src/a.txt', 'json');
    st().setLanguage('/p/b', 'yaml');
    st().renameOpenFiles('/p/src', '/p/lib', '/p');
    expect(st().langOverrides).toEqual({ '/p/lib/a.txt': 'json', '/p/b': 'yaml' });
    expect(saved()).toEqual({ '/p/lib/a.txt': 'json', '/p/b': 'yaml' });
    st().dropOpenFiles('/p/lib');
    expect(st().langOverrides).toEqual({ '/p/b': 'yaml' });
    expect(saved()).toEqual({ '/p/b': 'yaml' });
  });
});
