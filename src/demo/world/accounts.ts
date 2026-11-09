// The fictional user's two Claude accounts: a personal subscription, the default
// one, and a work one in its own config dir. Shared by the screenshots (tests/e2e/site-shots.manual.ts) and the demo
// (bridge settings, compile/sessions.ts). Relative imports (the demo's build loads the world without the `@shared`
// alias), and types only: the runtime imports this module, and must never pull in every scenario's source with it.
import type { ClaudeAccounts } from '../../shared/claude-accounts';
import type { Scenario } from './scenarios';

/** The fictional user's home in the demo (the project is under it, compile/sessions.ts DEMO_ROOT). */
export const DEMO_HOME = '/home/ada';

export interface WorldAccount {
  id: 'default' | 'work';
  name: string;
  /** --person-N. */
  color: number;
  /** The config dir, under the home. */
  folder: string;
  /** What its sessions' status lines report (%). */
  limits: { fiveHour: number; sevenDay: number };
}

/** The default first, as the settings keep it. Personal's limits are the ones every shot showed before accounts. */
export const ACCOUNTS: readonly WorldAccount[] = [
  { id: 'default', name: 'Personal', color: 1, folder: '.claude', limits: { fiveHour: 34, sevenDay: 12 } },
  { id: 'work', name: 'Work', color: 2, folder: '.claude-work', limits: { fiveHour: 8, sevenDay: 41 } }
];

const byId = (id: WorldAccount['id']) => ACCOUNTS.find((a) => a.id === id)!;

export function accountDir(home: string, id: WorldAccount['id']): string {
  return `${home}/${byId(id).folder}`;
}

/** The `claudeAccounts` setting for a user at `home`: the default stored without a dir, new sessions as Personal. */
export function claudeAccountsAt(home: string): ClaudeAccounts {
  return {
    list: ACCOUNTS.map((a) => ({ id: a.id, name: a.name, dir: a.id === 'default' ? '' : accountDir(home, a.id), color: a.color })),
    newSession: 'default',
    dismissed: []
  };
}

/** The account a scenario's session runs as. */
export function scenarioAccount(sc: Pick<Scenario, 'account'>): WorldAccount {
  return byId(sc.account ?? 'default');
}
