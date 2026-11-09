import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useApp } from '../store';
import { Avatar } from './Avatar';
import { Shelf } from './Shelf';

// Fewer marks on the sidebar's rows: a finished session's avatar
// without the green check, a shelved file without its folder (its tooltip has the path).

// A server render reads the store's initial state: it is given the current one (this file's own store instance).
const render = (el: ReturnType<typeof createElement>) => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(el);
};

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, openFiles: [], dirty: {}, shelfCollapsed: false, tabDrag: null,
    shelf: [{ path: '/p/src/auth/session.ts', rel: 'src/auth/session.ts' }, { path: '/Users/me/Documents/todo.md', rel: '/Users/me/Documents/todo.md' }]
  });
});

test('a finished session\'s avatar: no green check', () => {
  const html = render(createElement(Avatar, { title: 'docs', color: '#B794F6', state: 'done', size: 28 }));
  expect(html).not.toContain('av-check');
  expect(html).not.toContain('✓');
});

test('a shelved file: its name, no folder beside it; the path is in its tooltip', () => {
  const html = render(createElement(Shelf));
  expect(html).toContain('>session.ts<');
  expect(html).toContain('>todo.md<');
  expect(html).not.toContain('shelf-dir');
  expect(html).not.toContain('>src/auth<');
  expect(html).not.toContain('>Documents<');
  expect(html).toContain('data-tip="src/auth/session.ts"');
  expect(html).toContain('/Users/me/Documents/todo.md');
});
