// The namespaces the demo answers inertly by design ("About 60% of the surface"): no tmux
// services, ports, pull requests, Claude history, shell environment or notifications in a browser. Background work's
// feeds are live (bridge/background.ts), and so are the Databases view's (bridge/databases.ts).
import type { AtelierApi } from '@shared/api';
import type { ClaudeConfig } from '@shared/claude-config';
import type { TerminalInfo } from '@shared/protocol';
import { DEMO_HOME, accountDir } from '../world/accounts';
import { notInDemo } from './not-in-demo';
import { noop, resolved, type DemoContext } from './context';

export function createServices(): AtelierApi['services'] {
  return { list: () => resolved({ status: 'no-server', panes: [] }), lines: () => resolved({ lines: [], seq: 0, live: '' }), watch: () => {} };
}

export function createPorts(): AtelierApi['ports'] {
  return { list: () => resolved({}), open: () => resolved(false) };
}

export function createPrs(): AtelierApi['prs'] {
  return { list: () => resolved({ gh: 'ok', terminals: {} }), open: () => resolved(false) };
}

const NO_CONFIG: ClaudeConfig = { mcpServers: [], skills: [], plugins: [], unreadable: false, project: true };

export function createClaude(ctx: DemoContext): AtelierApi['claude'] {
  const usage = () => import('./context-usage');
  return {
    // The fictional user's home and default account dir (world/accounts.ts).
    dirs: () => resolved({ defaultDir: accountDir(DEMO_HOME, 'default'), home: DEMO_HOME }),
    pickDir: () => resolved(null),
    // No launch flags in the demo: the plain command the fictional sessions start with.
    launchPreview: (o) => resolved(`claude --name='${o.name.replace(/'/g, '')}'`),
    history: () => resolved([]),
    resume: (): Promise<TerminalInfo> => { notInDemo('Resume a conversation'); return Promise.reject(new Error('not in the demo')); },
    config: () => resolved(NO_CONFIG),
    // The demo's sessions never restart (a real Claude Code would quit): the reason, then nothing typed.
    restartCommand: (): Promise<string> => { notInDemo('Restart Session'); return Promise.reject(new Error('not in the demo')); },
    mcpAdded: () => resolved({}),
    // Context usage on fictional numbers, in a chunk loaded on the first call.
    contextUsage: (id) => usage().then((m) => m.analyze(ctx, id)),
    contextLive: (id) => usage().then((m) => m.live(ctx, id)),
    contextOpen: () => usage().then((m) => m.open())
  };
}

export function createSchedules(): AtelierApi['schedules'] {
  const no = () => resolved({ ok: false as const, error: 'unavailable' });
  return { list: () => resolved([]), add: no, update: no, remove: no, restore: no, fire: no, snooze: no };
}

/** Settings › Claude › Claude Code compatibility: everything recognized, nothing to note. */
export function createClaudeSignals(): AtelierApi['claudeSignals'] {
  return { get: () => resolved({ lastVersion: '2.1.316', since: 0, entries: [] }), clear: noop };
}

export function createShellEnv(): AtelierApi['shellEnv'] {
  return { files: () => resolved([]), pickFiles: () => resolved([]) };
}

export function createShellCommand(): AtelierApi['shellCommand'] {
  const mac = () => { notInDemo('The atelier command'); return resolved({ error: 'cancelled' as const }); };
  return { install: mac, uninstall: mac };
}

export function createNotifications(): AtelierApi['notifications'] {
  const mac = () => { notInDemo('Notifications'); return noop(); };
  return { test: mac, openSettings: mac };
}
