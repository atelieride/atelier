import { expect, test } from 'vitest';
import { ALLOW_MS, allowUnload, blocksUnload, hasUnsaved, unsavedReporter } from './unload';

test('dirty files block the unload until an answer lets it through, for a moment only (a quit called off elsewhere asks again)', () => {
  expect(blocksUnload(0, 10)).toBe(false);
  expect(blocksUnload(2, 10)).toBe(true);
  allowUnload(100);
  expect(blocksUnload(2, 150)).toBe(false);
  expect(blocksUnload(2, 100 + ALLOW_MS)).toBe(true);
});

test('main hears whether the window has unsaved files (Windows holds a shutdown for them), once per change', () => {
  const sent: boolean[] = [];
  const report = unsavedReporter((has) => sent.push(has));
  const files = [{ path: '/p/a.ts' }, { path: 'untitled:1' }];
  report(hasUnsaved({ openFiles: files, dirty: {} }));
  report(hasUnsaved({ openFiles: files, dirty: { '/p/a.ts': true } }));
  report(hasUnsaved({ openFiles: files, dirty: { '/p/a.ts': true, 'untitled:1': true } }));
  report(hasUnsaved({ openFiles: files, dirty: { '/p/a.ts': false, 'untitled:1': false } }));
  // A dirty mark left by a tab closed some other way is no unsaved file.
  report(hasUnsaved({ openFiles: [], dirty: { '/p/gone.ts': true } }));
  expect(sent).toEqual([true, false]);
  // A send that throws (the window going away) is not the page's problem.
  expect(() => unsavedReporter(() => { throw new Error('gone'); })(true)).not.toThrow();
});
