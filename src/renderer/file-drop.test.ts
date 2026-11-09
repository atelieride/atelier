import { expect, test } from 'vitest';
import { finderDrag } from './file-drop';

test('only a drag of Finder files counts; drags that start in Atelier (tree rows) never do', () => {
  expect(finderDrag(['Files'])).toBe(true);
  expect(finderDrag(['Files', 'text/uri-list'])).toBe(true);
  expect(finderDrag(['Files', 'text/x-atelier-path'])).toBe(false);
  expect(finderDrag(['text/plain'])).toBe(false);
  expect(finderDrag([])).toBe(false);
});
