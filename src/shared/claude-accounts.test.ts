import { describe, expect, test } from 'vitest';
import { DEFAULT_ACCOUNTS, accountById, accountOf, accountsFor, hasAccounts, launchAccount, launchDir, nameFromDir, newAccountId, normalizeAccounts, type ClaudeAccounts } from './claude-accounts';

const D = '/Users/x/.claude';
const def = { id: 'default', name: 'Claude', dir: '', color: 1 };
const ops = { id: 'ops', name: 'Ops', dir: '/Users/x/.claude_ops', color: 2 };
const accs = (over: Partial<ClaudeAccounts> = {}) => normalizeAccounts({ list: [def, ops], newSession: 'default', dismissed: [], ...over })!;

describe('Claude accounts', () => {
  test('launchAccount: no id → the account new sessions start with; unknown ids refused', () => {
    expect(launchAccount(accs(), undefined)).toMatchObject({ account: { id: 'default' }, dir: undefined });
    expect(launchAccount(accs({ newSession: 'ops' }), undefined)).toMatchObject({ account: { id: 'ops' }, dir: ops.dir });
    expect(launchAccount(accs(), 'ops')).toMatchObject({ account: { id: 'ops' }, dir: ops.dir });
    expect(launchAccount(accs(), 'default').dir).toBeUndefined();
    expect(() => launchAccount(accs(), 'nope')).toThrow(/account/);
  });
  test('the default: one account, the default one', () => {
    expect(DEFAULT_ACCOUNTS).toEqual({ list: [def], newSession: 'default', dismissed: [] });
    expect(hasAccounts(DEFAULT_ACCOUNTS)).toBe(false);
    expect(hasAccounts(accs())).toBe(true);
  });
  test('junk is not a value; missing parts get their defaults', () => {
    for (const v of [undefined, null, 1, 'x', []]) expect(normalizeAccounts(v), String(v)).toBeUndefined();
    expect(normalizeAccounts({})).toEqual(DEFAULT_ACCOUNTS);
  });
  test('the default always comes first, even when missing or moved, and keeps its name and color', () => {
    expect(normalizeAccounts({ list: [ops] })!.list.map((a) => a.id)).toEqual(['default', 'ops']);
    expect(normalizeAccounts({ list: [ops, { id: 'default', name: 'Me', dir: '/ignored', color: 3 }] })!.list[0]).toEqual({ id: 'default', name: 'Me', dir: '', color: 3 });
  });
  test('drops bad dirs, duplicate dirs and ids; keeps at most 9 accounts', () => {
    const bad = ['rel', '/a/../b', '/a//b', '/a/', '/a/./b', '/a\nb', '/', `/${'x'.repeat(5000)}`, ''].map((dir, i) => ({ id: `b${i}`, name: 'B', dir, color: 1 }));
    expect(normalizeAccounts({ list: [...bad, ops, { ...ops, id: 'ops2' }, { ...ops, dir: '/other' }] })!.list.map((a) => a.id)).toEqual(['default', 'ops']);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, dir: `/d/${i}`, color: 1 }));
    expect(normalizeAccounts({ list: many })!.list).toHaveLength(9);
  });
  test('names are trimmed single lines of 1–40 characters; colors 1–8 (else 1); ids are slugs', () => {
    const r = normalizeAccounts({ list: [
      { id: 'X Y', name: 'a', dir: '/a', color: 1 },
      { id: 'ok', name: ' \tOps\n ', dir: '/b', color: 99 },
      { id: 'long', name: 'x'.repeat(41), dir: '/c', color: 2 },
      { id: 'blank', name: '  ', dir: '/d', color: 2 }
    ] })!;
    expect(r.list.slice(1)).toEqual([{ id: 'ok', name: 'Ops', dir: '/b', color: 1 }]);
  });
  test('newSession falls back to the default; dismissed keeps clean dirs only, at most 32', () => {
    expect(accs({ newSession: 'gone' }).newSession).toBe('default');
    expect(accs({ newSession: 'ops' }).newSession).toBe('ops');
    const d = accs({ dismissed: ['/z', 'rel', '/z', ...Array.from({ length: 40 }, (_, i) => `/d${i}`)] }).dismissed;
    expect(d.slice(0, 2)).toEqual(['/z', '/d0']);
    expect(d).toHaveLength(32);
  });
  test('accountOf: exact dirs; the default by the default dir; anything else is unknown', () => {
    expect(accountOf(D, accs(), D)?.id).toBe('default');
    expect(accountOf('/Users/x/.claude_ops', accs(), D)?.id).toBe('ops');
    expect(accountOf('/Users/x/.claude_ops/', accs(), D)).toBeNull();
    expect(accountOf('/Users/x/.claude_qa', accs(), D)).toBeNull();
    expect(accountOf(undefined, accs(), D)).toBeNull();
    expect(accountOf(null, accs(), D)).toBeNull();
  });
  test('accountsFor drops an account at the default dir: the default is never launched with an explicit dir', () => {
    const a = accountsFor(accs({ list: [def, { ...ops, dir: D }], newSession: 'ops' }), D);
    expect(a.list.map((x) => x.id)).toEqual(['default']);
    expect(a.newSession).toBe('default');
  });
  test('accountById and launchDir', () => {
    expect(accountById(accs(), 'ops')).toEqual(ops);
    expect(accountById(accs(), 'nope')).toBeNull();
    expect(accountById(accs(), undefined)).toBeNull();
    expect(launchDir(accs().list[0]!)).toBeUndefined();
    expect(launchDir(ops)).toBe('/Users/x/.claude_ops');
  });
  test('newAccountId: a slug of the name, unique in the list', () => {
    expect(newAccountId('Ops', accs())).toBe('ops-2');
    expect(newAccountId('Work · Team', accs())).toBe('work-team');
    expect(newAccountId('???', accs())).toBe('account');
    expect(newAccountId('Default', accs())).toBe('default-2');
    expect(newAccountId('x'.repeat(60), accs())).toHaveLength(32);
  });
  test('nameFromDir: a readable name from a config folder', () => {
    expect(nameFromDir('/Users/x/.claude_ops')).toBe('Ops');
    expect(nameFromDir('/Users/x/claude-work')).toBe('Work');
    expect(nameFromDir('/Users/x/.claude-team_b')).toBe('Team b');
    expect(nameFromDir('/Users/x/.config/claude')).toBe('Claude');
    expect(nameFromDir('/Users/x/acme')).toBe('Acme');
  });
});
