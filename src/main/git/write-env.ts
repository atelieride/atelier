import { envKey } from '@shared/env';
import { currentPlatform } from '@shared/platform';
import { devEnv } from '../dev-env';

// Advice git prints on stderr for a terminal user: noise in a result's message and "Full log".
const QUIET_ADVICE = ['pushNonFFCurrent', 'pushNonFFMatching', 'pushUpdateRejected', 'pushFetchFirst', 'statusHints', 'detachedHead',
  'resolveConflict', 'skippedCherryPicks', 'waitingForEditor', 'mergeConflict'];

/**
 * Settings forced on every write op, through GIT_CONFIG_COUNT (never -c). Unlike fetch, never
 * core.hooksPath: writes run the repo's hooks (husky, lint-staged), the user's own checks behind an explicit click.
 */
export const WRITE_CONFIG: [string, string][] = [
  ['core.fsmonitor', 'false'], ['protocol.ext.allow', 'never'], ['gc.auto', '0'], ['maintenance.auto', 'false'],
  ['credential.interactive', 'false'], ['commit.verbose', 'false'],
  // A pull --rebase moves only the current branch (never other branches pointing into it) and never stashes by itself.
  ['rebase.updateRefs', 'false'], ['rebase.autoStash', 'false'],
  ...QUIET_ADVICE.map((k): [string, string] => [`advice.${k}`, 'false'])
];

/** The locale categories but LC_MESSAGES, which writes keep at C. */
const LOCALE_CATEGORIES = ['LC_CTYPE', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY'] as const;

export interface WriteEnvOpts {
  /** Tests only: no global or system config, no credential helper. Default: ATELIER_TEST_GIT_ISOLATED=1 (e2eEnv). */
  isolated?: boolean;
  /** The op's trace2 Unix socket (`listenTrace2`); empty or missing: no trace2. */
  trace2?: string;
}

/**
 * A write op's environment, on top of `base` (the user's shell environment when captured): no inherited GIT_* variable,
 * no prompt of any kind (an empty GIT_ASKPASS makes git skip core.askPass and SSH_ASKPASS too), no editor (`:` accepts
 * the message as is), the forced settings, and trace2 events to the op's socket. Literal pathspecs are runWrite's call,
 * per invocation: only the ops that read paths from stdin get them (a hook would inherit them otherwise).
 */
export function writeEnv(base: NodeJS.ProcessEnv, o: WriteEnvOpts = {}): NodeJS.ProcessEnv {
  const isolated = o.isolated ?? devEnv('ATELIER_TEST_GIT_ISOLATED') === '1';
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!envKey(k).startsWith('GIT_')) env[k] = v;
  // git's own messages in English (write-outcome reads them), every other category the user's: a hook keeps its
  // character set (UTF-8 file names, a linter's output). The user's LC_ALL would override LC_MESSAGES, so its value
  // goes to each other category instead.
  const all = env.LC_ALL;
  delete env.LC_ALL;
  if (all) for (const k of LOCALE_CATEGORIES) env[k] = all;
  // An empty helper clears every helper configured before it (system, global, repo).
  // Windows: paths past MAX_PATH (a run's worktree, node_modules) check out and commit.
  const config = [...WRITE_CONFIG, ...(currentPlatform() === 'win32' ? [['core.longpaths', 'true'] as [string, string]] : []),
    ...(isolated ? [['credential.helper', ''] as [string, string]] : [])];
  const out: NodeJS.ProcessEnv = {
    ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', LC_MESSAGES: 'C', LANGUAGE: 'C',
    GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_MERGE_AUTOEDIT: 'no', GIT_CONFIG_COUNT: String(config.length)
  };
  config.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  if (isolated) { out.GIT_CONFIG_GLOBAL = '/dev/null'; out.GIT_CONFIG_NOSYSTEM = '1'; }
  if (o.trace2) out.GIT_TRACE2_EVENT = `af_unix:stream:${o.trace2}`;
  return out;
}
