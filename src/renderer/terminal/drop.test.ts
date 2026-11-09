import { expect, test } from 'vitest';
import { dropText, endTreeDrag, startTreeDrag, treeDragPath } from './drop';

test('files dragged onto the terminal: escaped paths as in macOS Terminal, separated by spaces', () => {
  expect(dropText(['/Users/me/a.png'])).toBe('/Users/me/a.png ');
  expect(dropText(['/Users/me/My Shots/b c.png', '/tmp/x'])).toBe('/Users/me/My\\ Shots/b\\ c.png /tmp/x ');
  expect(dropText(["/p/it's (1)&$x.md"])).toBe("/p/it\\'s\\ \\(1\\)\\&\\$x.md ");
  expect(dropText([])).toBe('');
});

test('paths with control characters (e.g. a newline in the name) are not pasted: they would run the rest as a command', () => {
  expect(dropText(['/tmp/a\nrm -rf ~', '/tmp/ok.png'])).toBe('/tmp/ok.png ');
  expect(dropText(['/tmp/x\r'])).toBe('');
});

test('the path from the tree counts only if the drag started from the tree (not from a web page)', () => {
  expect(treeDragPath()).toBeNull();
  startTreeDrag('/p/a.ts');
  expect(treeDragPath()).toBe('/p/a.ts');
  endTreeDrag();
  expect(treeDragPath()).toBeNull();
});
