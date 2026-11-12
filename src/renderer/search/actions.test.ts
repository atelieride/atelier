import { expect, test, vi } from 'vitest';
import type { SearchFile, SearchLine } from '@shared/search';

const app = vi.hoisted(() => ({ openSearchResult: vi.fn(), keepOpen: vi.fn() }));
vi.mock('../store', () => ({ useApp: { getState: () => ({ ...app, project: { root: '/p' } }) } }));
vi.mock('../editor/savers', () => ({ dirtyPaths: () => [], handoffOf: () => undefined }));

import { openFileResult, openResult } from './actions';
import { useSearch } from './store';

const line: SearchLine = { line: 4, text: 'a token', start: 0, ranges: [[2, 7]], cutStart: false, cutEnd: false };
const file: SearchFile = { path: '/p/a.ts', rel: 'a.ts', size: 7, lines: [line] };
const ran = { query: 'token', matchCase: false, wholeWord: false, regex: false };

test('a result opens with the spec its search ran with, even while a newer query is being typed', () => {
  useSearch.setState({ ranSpec: ran, spec: { ...ran, query: 'tokens' } });
  openResult(file, line, 0, { side: false, keepFocus: true });
  expect(app.openSearchResult).toHaveBeenLastCalledWith(file, line, 0, { side: false, keepFocus: true, spec: ran });
  // A file row: its first match.
  openFileResult(file, { side: true, keepFocus: false });
  expect(app.openSearchResult).toHaveBeenLastCalledWith(file, line, 0, { side: true, keepFocus: false, spec: ran });
});
