import { expect, test } from 'vitest';
import { nameTip, renameTo, syncTip, titleTip } from './names';
import type { TerminalInfo } from '@shared/protocol';

const term = (extra: Partial<TerminalInfo> = {}) => ({ id: 't', title: 'Login bug', name: 'Login bug', ...extra }) as TerminalInfo;

test('the session title\'s tooltip says where Claude stands on the name, only when it isn\'t synced', () => {
  expect(titleTip(term())).toBe('Rename');
  expect(titleTip(term({ nameSync: 'pending' }))).toBe('Rename · Claude gets this name with your next message');
  expect(titleTip(term({ nameSync: 'kept' }))).toBe('Rename · Claude didn\'t take this name: it shows only in Atelier');
});

test('the tab says where Claude stands on the name, alone (a click there selects the tab, it doesn\'t rename)', () => {
  expect(syncTip(term())).toBeNull();
  expect(syncTip(term({ nameSync: 'pending' }))).toBe('Claude gets this name with your next message');
  expect(syncTip(term({ nameSync: 'kept' }))).toBe('Claude didn\'t take this name: it shows only in Atelier');
});

test('a rename left as it was does nothing (the shown title, maybe Claude\'s or a label, must not become a name)', () => {
  expect(renameTo(term({ title: 'Fix the login flow', name: null }), 'Fix the login flow')).toBeUndefined();
  expect(renameTo(term({ title: 'Fix the login flow', name: null }), '  Fix the login flow ')).toBeUndefined();
  expect(renameTo(term({ title: 'Fix the login flow', name: null }), 'Login bug')).toBe('Login bug');
  // Emptied: the given name goes (Claude's own shows again).
  expect(renameTo(term(), '   ')).toBeNull();
});

test('a name\'s tooltip leads with the full name (an ellipsis may cut it), then what the element says besides', () => {
  const long = 'Fix the login flow on the settings page after the OAuth migration';
  expect(nameTip(long, '~/repo/app')).toBe(`${long}\n~/repo/app`);
  expect(nameTip(long)).toBe(long);
  expect(nameTip(long, '')).toBe(long);
  expect(nameTip('', '~/repo')).toBe('~/repo');
  expect(nameTip('')).toBeUndefined();
});
