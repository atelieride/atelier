// What the demo bundle must never contain: the main process, the preload, atelierd,
// the build-time compiler, dictation's recorder, the app's sounds, the repo's test helpers, the shared modules only main
// and atelierd use; and the state-detection code — the hook and statusline reducers, the background-work builder, the
// Docker and Redis parsers — which runs at build time only. Checked on Rollup's module graph and rendered exports, so
// it holds transitively, whatever imports what; the demo build fails on any of it (compile/build.ts).
import type { DemoModule } from './build';

/**
 * Functions that turn Claude's hooks, Docker and Redis into state: their output ships, never they. With them the
 * beats' helpers (compile/beats.ts): atelierd's attribution of an edit hook, main's reader of a subagent's transcript
 * and its book of recently ended background items.
 */
export const BUILD_TIME_ONLY = [
  'reduceHook', 'applyStatusLine', 'backgroundWork', 'publicSession', 'containerFromInspect', 'detailFromInspect', 'parseInfo', 'bullJob',
  'attributionFromHook', 'TranscriptReader', 'RecentBook',
  // Docker's disk usage and events, Redis's queue detection and the other libraries' job parsers, CLIENT LIST, MONITOR
  // and string classification: compile/docker.ts, redis.ts and redis-queues.ts run them; the runtime plays their output.
  'dfSummary', 'eventEntry', 'detectQueues', 'doneSeries', 'workerCount', 'sidekiqEntry', 'horizonFailed', 'laravelPayload', 'celeryMessage',
  'celeryResult', 'rqJob', 'asynqTask', 'resqueFailed', 'resqueItem', 'parseClientList', 'parseMonitorLine', 'classifyString',
  // The usage-limit pause's detection (shared/limit-pause.ts, run by atelierd): the renderer reads only isLimitPaused.
  'openLimitPause', 'confirmLimitPause', 'sweepLimitPause', 'endLimitPause', 'limitEvidence', 'claudeVersion', 'waitsAtLimit',
  'compareVersions',
  // Context usage's backend (shared/context-usage.ts, run by main): the private copy's argv and control lines, the
  // answer's parser. The demo plays fictional reports instead (world/context.ts); the renderer reads only types and
  // GROUP_ORDER.
  'contextArgs', 'controlLine', 'parseMcpStatus', 'parseContextUsage'
] as const;

/**
 * Shared modules (src/shared/, by file name) only main and atelierd use: neither the real renderer, which the demo
 * bundles unchanged, nor the demo runtime imports them. A name list cannot see a new function in one of them; a path
 * can. tests/integration/demo-isolation.test.ts keeps the list exactly "every shared module the renderer and the
 * runtime don't reach", so a new backend module is banned from the bundle until someone decides otherwise.
 */
export const BACKEND_ONLY_SHARED: readonly string[] = [
  'app-icon.ts', 'automation-run.ts', 'background-files.ts', 'background-recent.ts', 'bash-attribution.ts', 'claude-config.ts', 'claude-signals.ts', 'close-sessions.ts', 'command-attribution.ts', 'daemon-build.ts',
  'env.ts', 'git.ts', 'helper-hash.node.ts', 'hook-paths.ts', 'loop-transcript.ts', 'paths.node.ts', 'popout.ts', 'prompt-text.ts', 'protocol.ts', 'readonly-command.ts', 'repo-names.ts', 'schedule-notices.ts', 'services.ts', 'session-name.ts', 'shell.ts',
  'store-updates.ts', 'tool-calls.ts', 'transcript.ts', 'update-sign.node.ts', 'version.ts', 'windows-menu.ts',
  // Ask's backend: the `claude -p` argv builder, the chat digest, the rules and facts it
  // writes (live.ts too), the stream parser. The demo plays
  // a script instead; the renderer's own parts (answer, catch-up, thread, stale, types) ship.
  'companion/args.ts', 'companion/chat.ts', 'companion/facts.ts', 'companion/live.ts', 'companion/rules.ts', 'companion/stream.ts', 'companion/text.ts'
  // Databases view: none left. databases.ts, databases-url.ts and pg-json.ts are the sidebar's (pasted URLs,
  // passwordless copies, quoted names), pg-format.ts and databases-filters.ts the table tab's (values as text,
  // masked), in their lazy chunks; the demo's own Databases engine (engine/databases*.ts, a chunk of its own) reads
  // databases-filters.ts and pg-format.ts too. The first paint reaches databases-empty.ts only.
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FORBIDDEN_PATHS: { re: RegExp; why: string }[] = [
  ...BACKEND_ONLY_SHARED.map((m) => ({ re: new RegExp(`/src/shared/${escapeRe(m)}$`), why: 'backend-only shared module' })),
  { re: /\/src\/main\//, why: 'main process' },
  { re: /\/src\/preload\//, why: 'preload' },
  { re: /\/src\/daemon\//, why: 'atelierd' },
  { re: /\/src\/demo\/compile\//, why: 'build-time compiler' },
  { re: /\/src\/renderer\/dictation\/recorder(?:\.worklet)?\.ts/, why: 'dictation recorder' },
  // A page on the site never makes a sound (compile/build.ts swaps them for silent stubs).
  { re: /\/src\/renderer\/(?:chime|dictation\/sounds)\.ts$/, why: 'sound' },
  // The build-time compiler reads the world through the app's test fakes (fake Redis, fixtures): never the runtime.
  { re: /^(?!.*\/node_modules\/).*\/tests\//, why: 'test helpers' }
];

/** Every way the module graph breaks the rule; empty when it holds. */
export function graphViolations(modules: readonly DemoModule[]): string[] {
  const out: string[] = [];
  for (const m of modules) {
    const id = m.id.replace(/^\0/, '').replace(/\?.*$/, '');
    for (const f of FORBIDDEN_PATHS) if (f.re.test(id)) out.push(`${f.why}: ${id}`);
    for (const name of BUILD_TIME_ONLY) if (m.exports.includes(name)) out.push(`build-time function ${name} from ${id}`);
  }
  return out;
}
