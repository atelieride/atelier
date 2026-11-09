import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { accountOf, normalizeAccounts } from '@shared/claude-accounts';
import { ACCOUNTS, accountDir, claudeAccountsAt, scenarioAccount } from './accounts';
import { SCENARIOS, type ScenarioName } from './scenarios';

describe('world: Claude accounts', () => {
  const home = '/home/ada';

  test('Personal is the default account, Work the other one', () => {
    expect(ACCOUNTS.map((a) => [a.id, a.name])).toEqual([['default', 'Personal'], ['work', 'Work']]);
  });

  test('each account has its dir under the home', () => {
    expect(accountDir(home, 'default')).toBe('/home/ada/.claude');
    expect(accountDir(home, 'work')).toBe('/home/ada/.claude-work');
  });

  test('the settings value is what the app keeps (normalized unchanged), the default stored without a dir', () => {
    const a = claudeAccountsAt(home);
    expect(normalizeAccounts(a)).toEqual(a);
    expect(a.list[0]).toEqual({ id: 'default', name: 'Personal', dir: '', color: 1 });
    expect(a.newSession).toBe('default');
    expect(accountOf(accountDir(home, 'work'), a, accountDir(home, 'default'))?.name).toBe('Work');
  });

  test('docs runs as Work, every other session as Personal', () => {
    const names = Object.keys(SCENARIOS) as ScenarioName[];
    expect(names.filter((n) => scenarioAccount(SCENARIOS[n]).id === 'work')).toEqual(['docs']);
  });

  test('takes types only from the scenarios: the demo\'s runtime may import it without every scenario\'s source', () => {
    const src = readFileSync(join(__dirname, 'accounts.ts'), 'utf8');
    expect(src).not.toMatch(/^import (?!type )[^;]*from '\.\/scenarios'/m);
  });

  test('Personal keeps the limits every shot showed (34% and 12%); Work has its own', () => {
    expect(ACCOUNTS[0]!.limits).toEqual({ fiveHour: 34, sevenDay: 12 });
    expect(ACCOUNTS[1]!.limits).not.toEqual(ACCOUNTS[0]!.limits);
  });
});
