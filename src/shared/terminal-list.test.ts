import { expect, test } from 'vitest';
import type { TerminalInfo } from './protocol';
import { withTerminal } from './terminal-list';

const term = (id: string, title = id): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title, name: null, color: '#B794F6', foreground: 'zsh', createdAt: 0, session: null });

test('a terminal just created joins the list at the end', () => {
  const list = [term('a')];
  expect(withTerminal(list, term('b')).map((t) => t.id)).toEqual(['a', 'b']);
  expect(list.map((t) => t.id)).toEqual(['a']);
});

test('a terminal already listed (the list came first) keeps the listed entry and the same array', () => {
  const list = [term('a'), term('b', 'from the list')];
  expect(withTerminal(list, term('b', 'from the reply'))).toBe(list);
});

import { wellFormedTerminal } from './terminal-list';

test('no foreground process name (a pipeline whose first command already exited): an empty name, never undefined', () => {
  // node-pty's `process` is undefined on macOS while the foreground process group's leader is gone
  // (`base64 -i missing | gh secret set …`); JSON then drops the field and the window used to crash on it.
  const raw = { ...term('a') } as Partial<TerminalInfo>;
  delete raw.foreground;
  expect(wellFormedTerminal(raw as TerminalInfo).foreground).toBe('');
  expect(wellFormedTerminal({ ...term('b'), foreground: null as unknown as string }).foreground).toBe('');
  expect(wellFormedTerminal({ ...term('c'), foreground: 42 as unknown as string }).foreground).toBe('');
});

test('a well-formed terminal comes back as the same object (nothing re-renders)', () => {
  const t = term('a');
  expect(wellFormedTerminal(t)).toBe(t);
});
