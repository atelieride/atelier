import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { accountOf, accountsFor, normalizeAccounts } from './claude-accounts';

// Windows: a config dir names one folder in any case and either separator (CLAUDE_CONFIG_DIR typed C:\Users\M\.claude-w,
// Claude reporting c:/users/m/.claude-w). macOS compares exactly, as before.

afterEach(() => { resetPlatformForTests(); });

const accs = () => normalizeAccounts({ list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'w', name: 'Work', dir: 'C:/Users/M/.claude-w', color: 2 }] })!;

test('Windows: the account of a dir in any case; an account at the default dir is the default', () => {
  initPlatform('win32');
  expect(accountOf('c:/users/m/.claude-w', accs(), 'C:/Users/M/.claude')?.id).toBe('w');
  expect(accountOf('C:\\Users\\M\\.claude', accs(), 'C:/Users/M/.claude')?.id).toBe('default');
  expect(accountsFor(accs(), 'c:/users/m/.CLAUDE-W').list.map((a) => a.id)).toEqual(['default']);
});

test('macOS: exact', () => {
  initPlatform('darwin');
  const a = normalizeAccounts({ list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'w', name: 'Work', dir: '/Users/M/.claude-w', color: 2 }] })!;
  expect(accountOf('/users/m/.claude-w', a, '/Users/M/.claude')).toBe(null);
  expect(accountOf('/Users/M/.claude-w', a, '/Users/M/.claude')?.id).toBe('w');
});
