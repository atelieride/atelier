import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useApp } from '../store';

// Move to Trash: unsaved files first, then the question in the tree row, then main trashes
// (main no longer asks).
const trashInfo = vi.fn(async (_p: string): Promise<{ kind: 'file' | 'folder'; files: number } | { error: string }> => ({ kind: 'folder', files: 14 }));
const trash = vi.fn(async (_p: string): Promise<{ ok: true } | { error: string }> => ({ ok: true }));

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { atelier: { files: { trashInfo, trash } } };
  trashInfo.mockClear(); trash.mockClear();
  useApp.setState({ openFiles: [], tabOrder: [], dirty: {}, trashAsk: null, toast: null, unsavedAsk: null });
});
afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window; });

test('asked in the row with what main counted; Cancel trashes nothing, Move to Trash trashes and drops its tabs', async () => {
  useApp.getState().openFile('/p/src/tests/a.ts', 'src/tests/a.ts');
  await useApp.getState().askTrash('/p/src/tests');
  expect(trashInfo).toHaveBeenCalledWith('/p/src/tests');
  expect(useApp.getState().trashAsk).toEqual({ path: '/p/src/tests', name: 'tests', kind: 'folder', files: 14 });
  useApp.getState().cancelTrash();
  expect(useApp.getState().trashAsk).toBeNull();
  expect(trash).not.toHaveBeenCalled();
  await useApp.getState().askTrash('/p/src/tests');
  const tree = useApp.getState().treeNonce;
  await useApp.getState().confirmTrash();
  expect(trash).toHaveBeenCalledWith('/p/src/tests');
  expect(useApp.getState().trashAsk).toBeNull();
  expect(useApp.getState().openFiles).toEqual([]);
  expect(useApp.getState().treeNonce).not.toBe(tree);
});

test('unsaved files under it: Cancel there asks nothing more; main\'s refusal is a toast', async () => {
  useApp.getState().openFile('/p/src/c.ts', 'src/c.ts');
  useApp.getState().setDirty('/p/src/c.ts', true);
  const asking = useApp.getState().askTrash('/p/src');
  await Promise.resolve();
  expect(useApp.getState().unsavedAsk?.how).toBe('trash');
  useApp.getState().answerUnsaved('cancel');
  await asking;
  expect(trashInfo).not.toHaveBeenCalled();
  expect(useApp.getState().trashAsk).toBeNull();

  trashInfo.mockResolvedValueOnce({ error: 'missing' });
  await useApp.getState().askTrash('/p/gone.ts');
  expect(useApp.getState().trashAsk).toBeNull();
  expect(useApp.getState().toast?.text).toMatch(/./);
});

test('its row gone (folder collapsed, file deleted, the tree closed): the question goes with it, never back stale', async () => {
  await useApp.getState().askTrash('/p/src/tests');
  // Another row going changes nothing.
  useApp.getState().trashRowGone('/p/src/other');
  expect(useApp.getState().trashAsk?.path).toBe('/p/src/tests');
  useApp.getState().trashRowGone('/p/src/tests');
  expect(useApp.getState().trashAsk).toBeNull();
  expect(trash).not.toHaveBeenCalled();
});
