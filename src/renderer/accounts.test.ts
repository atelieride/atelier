import { expect, test } from 'vitest';
import { normalizeAccounts } from '@shared/claude-accounts';
import { accountArrow, accountChoices, accountFolder, accountFormError, accountStep, accountTag, canAddAccount, accountUsage, cycleAccount, detectedDirs, dismissDir, expandDir, meterAccounts, paletteAccountCommands, removeAccount, saveAccount } from './accounts';
import { useApp } from './store';

const two = normalizeAccounts({ list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'ops', name: 'Ops', dir: '/Users/x/.claude_ops', color: 5 }] })!;
const one = normalizeAccounts({})!;

test('palette: "New session as <account>" for every account, only with two or more', () => {
  expect(paletteAccountCommands(two).map((c) => [c.key, c.label, c.account, c.color])).toEqual([
    ['new-session-account:default', 'New session as Claude', 'default', 1],
    ['new-session-account:ops', 'New session as Ops', 'ops', 5]
  ]);
  expect(paletteAccountCommands(one)).toEqual([]);
});

test('accountFolder: the folder as Settings writes it, ~ for the home whatever it is; the default\'s once known', () => {
  const short = (acc: Parameters<typeof accountFolder>[0], d: string | null, h: string | null) => accountFolder(acc, d, h)?.short;
  expect(short(two.list[1]!, '/Users/x/.claude', '/Users/x')).toBe('~/.claude_ops');
  expect(short(two.list[0]!, '/Users/x/.claude', '/Users/x')).toBe('~/.claude');
  expect(short({ ...two.list[1]!, dir: '/home/ada/.claude-work' }, '/home/ada/.claude', '/home/ada')).toBe('~/.claude-work');
  expect(short({ ...two.list[1]!, dir: '/Volumes/claude' }, '/Users/x/.claude', '/Users/x')).toBe('/Volumes/claude');
  expect(accountFolder(two.list[0]!, null, '/Users/x')).toBeNull();
});

test('accountFolder: a deep folder keeps its last two parts on the card (what tells accounts apart), the whole of it in the tooltip', () => {
  const deep = { ...two.list[1]!, dir: '/Users/x/Library/Application Support/Claude/work' };
  expect(accountFolder(deep, '/Users/x/.claude', '/Users/x')).toEqual({ short: '~/…/Claude/work', full: '~/Library/Application Support/Claude/work' });
  expect(accountFolder({ ...deep, dir: '/home/ada/a/b/c' }, null, '/home/ada')).toEqual({ short: '~/…/b/c', full: '~/a/b/c' });
  expect(accountFolder({ ...deep, dir: '/Volumes/team/claude/work' }, null, '/Users/x')).toEqual({ short: '/…/claude/work', full: '/Volumes/team/claude/work' });
});

test('cycleAccount: Tab and Shift+Tab go round the accounts', () => {
  expect(cycleAccount(two, 'default', 1)).toBe('ops');
  expect(cycleAccount(two, 'ops', 1)).toBe('default');
  expect(cycleAccount(two, 'default', -1)).toBe('ops');
  expect(cycleAccount(two, 'gone', 1)).toBe('default');
});

test('accountUsage: an account\'s last known limits by its dir (the default\'s by the default dir); none when unseen or over', () => {
  const now = 1_000_000;
  const u = (configDir: string, pct: number, resetsAt = now + 3600) => ({ configDir, usage: { fiveHour: { pct, resetsAt }, sevenDay: { pct: 9, resetsAt: now + 86400 }, updatedAt: now } });
  const usage = [u('/Users/x/.claude', 91), u('/Users/x/.claude_ops', 8)];
  expect(accountUsage(usage, two.list[1]!, '/Users/x/.claude', now).map((p) => [p.key, p.pct])).toEqual([['5h', 8], ['7d', 9]]);
  expect(accountUsage(usage, two.list[0]!, '/Users/x/.claude', now).map((p) => p.pct)).toEqual([91, 9]);
  expect(accountUsage(usage, two.list[0]!, null, now)).toEqual([]);
  expect(accountUsage([], two.list[1]!, '/Users/x/.claude', now)).toEqual([]);
  expect(accountUsage([u('/Users/x/.claude_ops', 8, now - 1)], two.list[1]!, '/Users/x/.claude', now).map((p) => p.key)).toEqual(['7d']);
});

test('accountTag: the account a session runs as; the default marked; an unknown dir by its folder; nothing until the default dir is known', () => {
  const D = '/Users/x/.claude';
  expect(accountTag(D, two, D)).toEqual({ name: 'Claude', color: 1, isDefault: true });
  expect(accountTag('/Users/x/.claude_ops', two, D)).toEqual({ name: 'Ops', color: 5, isDefault: false });
  expect(accountTag('/Users/x/.claude_qa', two, D)).toEqual({ name: '.claude_qa', color: null, isDefault: false });
  expect(accountTag(undefined, two, D)).toBeNull();
  expect(accountTag('/Users/x/.claude_ops', two, null)).toBeNull();
});

test('meterAccounts: every account with live limits, in the accounts\' order, the selected one marked', () => {
  const now = 1_000_000;
  const D = '/Users/x/.claude';
  const u = (configDir: string, pct: number, resetsAt = now + 3600) => ({ configDir, usage: { fiveHour: { pct, resetsAt }, sevenDay: null, updatedAt: now } });
  const usage = [u('/Users/x/.claude_qa', 50), u('/Users/x/.claude_ops', 8), u(D, 91), u('/Users/x/.old', 3, now - 1)];
  const rows = meterAccounts(usage, two, D, '/Users/x/.claude_ops', now);
  expect(rows.map((r) => [r.name, r.current, r.parts.map((p) => p.pct)])).toEqual([['Claude', false, [91]], ['Ops', true, [8]], ['.claude_qa', false, [50]]]);
  expect(meterAccounts(usage, two, null, undefined, now)).toEqual([]);
});

const D = '/Users/x/.claude';
const term = (id: string, title: string, configDir?: string) => ({ id, title, ...(configDir ? { configDir } : {}) }) as never;

test('detectedDirs: config dirs seen in sessions that no account has, not dismissed, once each, with the first session', () => {
  const terms = [term('1', 'Hero', '/Users/x/.claude_qa'), term('2', 'Other', '/Users/x/.claude_qa'), term('3', 'Main', D), term('4', 'Ops work', '/Users/x/.claude_ops'), term('5', 'Shell'), term('6', 'Gone', '/Users/x/.c2')];
  expect(detectedDirs(terms, normalizeAccounts({ ...two, dismissed: ['/Users/x/.c2'] })!, D)).toEqual([{ dir: '/Users/x/.claude_qa', session: 'Hero' }]);
  expect(detectedDirs(terms, two, null)).toEqual([]);
});

test('expandDir: ~ and ~/… from the home; anything else as typed, trimmed', () => {
  expect(expandDir(' ~/.claude_ops ', '/Users/x')).toBe('/Users/x/.claude_ops');
  expect(expandDir('~', '/Users/x')).toBe('/Users/x');
  expect(expandDir('/abs/dir', '/Users/x')).toBe('/abs/dir');
  expect(expandDir('~/x', null)).toBe('~/x');
});

test('accountFormError: a name, a clean absolute folder, not the default one, not another account\'s', () => {
  expect(accountFormError({ name: 'QA', dir: '/Users/x/.claude_qa' }, two, D)).toBeNull();
  expect(accountFormError({ name: ' ', dir: '/Users/x/.claude_qa' }, two, D)).toBe('name');
  expect(accountFormError({ name: 'x'.repeat(41), dir: '/Users/x/.claude_qa' }, two, D)).toBe('name');
  expect(accountFormError({ name: 'QA', dir: 'rel' }, two, D)).toBe('dir');
  expect(accountFormError({ name: 'QA', dir: '/a/../b' }, two, D)).toBe('dir');
  expect(accountFormError({ name: 'QA', dir: D }, two, D)).toBe('default');
  expect(accountFormError({ name: 'QA', dir: '/Users/x/.claude_ops' }, two, D)).toBe('taken');
  // Editing an account keeps its own folder.
  expect(accountFormError({ name: 'Operations', dir: '/Users/x/.claude_ops' }, two, D, 'ops')).toBeNull();
  // The default account has no folder to check.
  expect(accountFormError({ name: 'Me', dir: '' }, two, D, 'default')).toBeNull();
});

test('saveAccount, removeAccount and dismissDir: always a normal value', () => {
  const added = saveAccount(two, { name: 'QA', dir: '/Users/x/.claude_qa', color: 3 });
  expect(added.list.at(-1)).toEqual({ id: 'qa', name: 'QA', dir: '/Users/x/.claude_qa', color: 3 });
  const edited = saveAccount(added, { name: 'Operations', dir: '/Users/x/.claude_ops', color: 4 }, 'ops');
  expect(edited.list.find((a) => a.id === 'ops')).toEqual({ id: 'ops', name: 'Operations', dir: '/Users/x/.claude_ops', color: 4 });
  expect(saveAccount(two, { name: 'Me', dir: 'ignored', color: 2 }, 'default').list[0]).toEqual({ id: 'default', name: 'Me', dir: '', color: 2 });
  const gone = removeAccount({ ...edited, newSession: 'ops' }, 'ops');
  expect(gone.list.map((a) => a.id)).toEqual(['default', 'qa']);
  expect(gone.newSession).toBe('default');
  expect(removeAccount(two, 'default').list).toHaveLength(2);
  expect(dismissDir(two, '/Users/x/.c9').dismissed).toEqual(['/Users/x/.c9']);
});

test('a removed account\'s folder is not offered back at once: it counts as dismissed', () => {
  expect(removeAccount(two, 'ops').dismissed).toEqual(['/Users/x/.claude_ops']);
});

test('accountStep: plain Tab and Shift+Tab only (Ctrl+Tab and friends stay app shortcuts)', () => {
  const k = (key: string, m: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => accountStep({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...m });
  expect(k('Tab')).toBe(1);
  expect(k('Tab', { shiftKey: true })).toBe(-1);
  for (const m of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }]) expect(k('Tab', m), JSON.stringify(m)).toBeNull();
  expect(k('a')).toBeNull();
});

test('canAddAccount: up to the cap (the default and 8 others)', () => {
  const many = normalizeAccounts({ list: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, dir: `/d/${i}`, color: 1 })) })!;
  expect(many.list).toHaveLength(9);
  expect(canAddAccount(many)).toBe(false);
  expect(canAddAccount(two)).toBe(true);
});

test('the New Session sheet opens on the account it is asked for, and forgets it when it closes', () => {
  useApp.getState().setNewSessionOpen(true, 'ops');
  expect(useApp.getState()).toMatchObject({ newSessionOpen: true, newSessionAccount: 'ops' });
  useApp.getState().setNewSessionOpen(false);
  expect(useApp.getState()).toMatchObject({ newSessionOpen: false, newSessionAccount: null });
  useApp.getState().setNewSessionOpen(true);
  expect(useApp.getState().newSessionAccount).toBeNull();
});

test('accountArrow: ←/→ previous and next (wrapping, as Tab), ↑/↓ the card above and below in the grid', () => {
  // Two accounts, one row of two.
  expect(accountArrow('ArrowRight', 0, 2, 2)).toBe(1);
  expect(accountArrow('ArrowRight', 1, 2, 2)).toBe(0);
  expect(accountArrow('ArrowLeft', 0, 2, 2)).toBe(1);
  expect(accountArrow('ArrowDown', 0, 2, 2)).toBeNull();
  expect(accountArrow('ArrowUp', 1, 2, 2)).toBeNull();
  // Five accounts in two columns: [0 1] [2 3] [4].
  expect(accountArrow('ArrowDown', 1, 5, 2)).toBe(3);
  expect(accountArrow('ArrowDown', 3, 5, 2)).toBe(4);
  expect(accountArrow('ArrowDown', 4, 5, 2)).toBeNull();
  expect(accountArrow('ArrowUp', 4, 5, 2)).toBe(2);
  expect(accountArrow('ArrowUp', 0, 5, 2)).toBeNull();
  expect(accountArrow('Enter', 0, 5, 2)).toBeNull();
  // The current account gone meanwhile (Settings in another window): the keys start from the first card.
  expect(accountArrow('ArrowRight', -1, 5, 2)).toBe(1);
  expect(accountArrow('ArrowLeft', -1, 5, 2)).toBe(4);
  expect(accountArrow('ArrowDown', -1, 5, 2)).toBe(2);
});

test('accountChoices: a task\'s account step — every account in order, its limits or else its folder as hint, starting on the one set for new sessions', () => {
  const now = 1_000_000;
  const three = normalizeAccounts({ list: [...two.list, { id: 'work', name: 'Work', dir: '/Volumes/w/claude/work', color: 3 }], newSession: 'ops' })!;
  const usage = [{ configDir: '/Users/x/.claude_ops', usage: { fiveHour: { pct: 42, resetsAt: now + 3600 }, sevenDay: { pct: 18, resetsAt: now + 86400 }, updatedAt: now } }];
  const c = accountChoices(three, usage, '/Users/x/.claude', '/Users/x', now);
  expect(c.rows).toEqual([
    { id: 'default', name: 'Claude', color: 1, hint: '~/.claude' },
    { id: 'ops', name: 'Ops', color: 5, hint: '5h 42% · 7d 18%' },
    { id: 'work', name: 'Work', color: 3, hint: '/…/claude/work' }
  ]);
  expect(c.initial).toBe(1);
  // The default dir not known yet: the default account has no hint. A default no longer listed: the first row.
  expect(accountChoices({ ...three, newSession: 'gone' }, [], null, '/Users/x', now)).toEqual({ rows: [
    { id: 'default', name: 'Claude', color: 1, hint: '' },
    { id: 'ops', name: 'Ops', color: 5, hint: '~/.claude_ops' },
    { id: 'work', name: 'Work', color: 3, hint: '/…/claude/work' }
  ], initial: 0 });
});
