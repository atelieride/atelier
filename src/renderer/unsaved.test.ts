import { afterEach, beforeEach, expect, test } from 'vitest';
import { useApp } from './store';
import { registerSaver } from './editor/savers';
import { answerUnsaved } from './confirms/answer-for-tests';
import type { UnsavedAnswer } from './confirms/slice';

// Unsaved files when closing tabs: asked in the window, never by main.
let answer: 'save' | 'discard' | 'cancel' | UnsavedAnswer = 'cancel';
let q: ReturnType<typeof answerUnsaved>;
const saved: string[] = [];

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { atelier: { terminals: { close: async () => {} } } };
  saved.length = 0;
  useApp.setState({ openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, dirty: {}, unsavedAsk: null });
  const s = useApp.getState();
  s.openFile('/p/a.ts', 'a.ts');
  s.openFile('/p/b.ts', 'b.ts');
  useApp.getState().setDirty('/p/a.ts', true);
  q = answerUnsaved(() => answer);
});
afterEach(() => { q.stop(); delete (globalThis as unknown as { window?: unknown }).window; });

const paths = () => useApp.getState().openFiles.map((f) => f.path);

test('Cancel closes nothing', async () => {
  answer = 'cancel';
  await useApp.getState().closeTabs(['f:/p/a.ts', 'f:/p/b.ts']);
  // Several tabs closing: the sheet (no tab to hang from), about the unsaved one only.
  expect(q.asked).toEqual([{ paths: ['/p/a.ts'], how: 'close', tab: null }]);
  expect(paths()).toEqual(['/p/a.ts', '/p/b.ts']);
});

test("Don't Save closes without saving", async () => {
  answer = 'discard';
  const off = registerSaver('/p/a.ts', async () => { saved.push('a'); return true; });
  await useApp.getState().closeTabs(['f:/p/a.ts']);
  expect(paths()).toEqual(['/p/b.ts']);
  expect(saved).toEqual([]);
  expect(useApp.getState().dirty['/p/a.ts']).toBeFalsy();
  off();
});

test('Save saves and then closes; if saving fails the tab stays', async () => {
  answer = 'save';
  let ok = false;
  const off = registerSaver('/p/a.ts', async () => { saved.push('a'); return ok; });
  await useApp.getState().closeTabs(['f:/p/a.ts']);
  expect(paths()).toEqual(['/p/a.ts', '/p/b.ts']);
  ok = true;
  await useApp.getState().closeTabs(['f:/p/a.ts']);
  expect(saved).toEqual(['a', 'a']);
  expect(paths()).toEqual(['/p/b.ts']);
  off();
});

test('one file closing from its tab: asked under that tab', async () => {
  answer = 'cancel';
  useApp.getState().closeTab('/p/a.ts');
  await new Promise((r) => setTimeout(r, 0));
  expect(q.asked).toEqual([{ paths: ['/p/a.ts'], how: 'close', tab: 'f:/p/a.ts' }]);
  expect(paths()).toContain('/p/a.ts');
});

test('the sheet\'s checkboxes: the checked files are saved, the others discarded, then all close', async () => {
  useApp.getState().setDirty('/p/b.ts', true);
  answer = { save: ['/p/b.ts'] };
  const offA = registerSaver('/p/a.ts', async () => { saved.push('a'); return true; });
  const offB = registerSaver('/p/b.ts', async () => { saved.push('b'); return true; });
  await useApp.getState().closeTabs(['f:/p/a.ts', 'f:/p/b.ts']);
  expect(q.asked[0]!.paths).toEqual(['/p/a.ts', '/p/b.ts']);
  expect(saved).toEqual(['b']);
  expect(paths()).toEqual([]);
  expect(useApp.getState().dirty['/p/a.ts']).toBeFalsy();
  offA(); offB();
});

test('just typed (before the 150 ms) the file already counts as unsaved', async () => {
  answer = 'cancel';
  useApp.getState().setDirty('/p/a.ts', false);
  const off = registerSaver('/p/b.ts', async () => true, () => true);
  await useApp.getState().closeTabs(['f:/p/b.ts']);
  expect(q.asked[0]!.paths).toEqual(['/p/b.ts']);
  expect(paths()).toContain('/p/b.ts');
  off();
});

test("Don't Save with a terminal tab among them: the file closes, the terminal's tab only hides", async () => {
  answer = 'discard';
  await useApp.getState().closeTabs(['f:/p/a.ts', 't:x']);
  expect(paths()).not.toContain('/p/a.ts');
  expect(useApp.getState().dirty['/p/a.ts']).toBeFalsy();
});

test('renaming or trashing a folder with unsaved files asks first (the sheet: no tab)', async () => {
  useApp.getState().openFile('/p/src/c.ts', 'src/c.ts');
  useApp.getState().setDirty('/p/src/c.ts', true);
  answer = 'cancel';
  expect(await useApp.getState().confirmUnsavedUnder('/p/src', 'rename')).toBe(false);
  expect(q.asked).toEqual([{ paths: ['/p/src/c.ts'], how: 'rename', tab: null }]);
  answer = 'discard';
  expect(await useApp.getState().confirmUnsavedUnder('/p/src', 'trash')).toBe(true);
  expect(q.asked[1]!.how).toBe('trash');
  expect(useApp.getState().dirty['/p/src/c.ts']).toBeFalsy();
  expect(await useApp.getState().confirmUnsavedUnder('/p/other', 'rename')).toBe(true);
  expect(q.asked).toHaveLength(2);
});

test('a second question cancels the first one still open; a tab gone meanwhile drops it', async () => {
  q.stop();
  const first = useApp.getState().askUnsaved(['/p/a.ts'], 'close', 'f:/p/a.ts');
  const second = useApp.getState().askUnsaved(['/p/a.ts'], 'close', null);
  expect(await first).toBe('cancel');
  useApp.setState({ openFiles: useApp.getState().openFiles.filter((f) => f.path !== '/p/a.ts') });
  expect(await second).toBe('cancel');
  expect(useApp.getState().unsavedAsk).toBeNull();
});
