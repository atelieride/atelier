import { expect, test } from 'vitest';
import { lastFindSpec, rememberFindQuery, rememberFindSpec } from './find-ext';

test('a read-only card (terminal, preview) remembers its query and options but keeps the editor’s replace text', () => {
  rememberFindSpec({ search: 'old', caseSensitive: false, wholeWord: false, regexp: false, replace: 'new' });
  rememberFindQuery({ search: 'needle', caseSensitive: true, wholeWord: false, regexp: true, replace: '' });
  expect(lastFindSpec()).toEqual({ search: 'needle', caseSensitive: true, wholeWord: false, regexp: true, replace: 'new' });
});
