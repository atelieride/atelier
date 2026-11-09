// The Claude beats, compiled: each authored beat (src/demo/world/beats.ts)
// is walked segment by segment from the state its session is in, and every run of hook events goes through the app's
// own reducer as atelierd applies it. What ships is the result — the public fields each run sets, the background work
// and recently ended items main would attach — never the reducer. Node, build time only; relative imports (esbuild
// loads this module without the `@shared` alias).
import { attributionFromHook } from '../../shared/attribution';
import { feedKey } from '../../shared/background-feed';
import { RecentBook } from '../../shared/background-recent';
import type { TerminalInfo } from '../../shared/protocol';
import { applyStatusLine, publicSession, reduceHook, type SessionInfo } from '../../shared/session';
import type { BeatStep, CompiledBeat, CompiledFeed, DemoBeats, SessionPatch, StampKey } from '../engine/beats-types';
import type { DemoSession } from '../types';
import { BEATS, BILLING_FEEDS, BILLING_SHELL_TAIL, BILLING_WATCH, GENERIC_BEATS, SESSION_BEATS, welcome, type BeatName, type Hook, type SourceBeat, type SourceStep } from '../world/beats';
import { SCENARIOS, type ScenarioName } from '../world/scenarios';
import { agentFeed, shellFeed, watchFeed } from './beats-feeds';
import { SESSION_COLORS, withWork } from './sessions';

/** Always set by a patch, changed or not: the template a generic beat was compiled from may differ from its session. */
export const STATE_FIELDS = ['state', 'activity', 'waitingFor', 'unread', 'compacting', 'errorReason'] as const;
/** Never set by a patch: the session's identity and what the runtime keeps itself (name, totals, stamped times). */
const KEPT = new Set(['sessionId', 'cwd', 'title', 'autoTitle', 'model', 'cost', 'contextPct', 'updatedAt', 'lastMessageAt']);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A hook as Claude Code sends it: the session id added, relative file paths made absolute in the project. */
export function payloadOf(h: Hook, sessionId: string, root: string): Hook {
  const input = h.tool_input as Record<string, unknown> | undefined;
  const abs = (p: unknown) => (typeof p === 'string' && !p.startsWith('/') ? `${root}/${p}` : p);
  const tool_input = input && typeof input === 'object' ? { ...input, ...('file_path' in input ? { file_path: abs(input.file_path) } : {}), ...('path' in input ? { path: abs(input.path) } : {}) } : undefined;
  return { ...h, ...(tool_input ? { tool_input } : {}), session_id: sessionId };
}

/** What changed between two sessions as main sends them, as a patch (the state fields always). */
export function patchOf(prev: SessionInfo, next: SessionInfo): SessionPatch {
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const drop: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (KEPT.has(k)) continue;
    if (b[k] === undefined) { if (a[k] !== undefined) drop.push(k); continue; }
    if ((STATE_FIELDS as readonly string[]).includes(k) || !same(a[k], b[k])) set[k] = b[k];
  }
  const stamp: StampKey[] = ['updatedAt'];
  if (next.lastMessageAt !== prev.lastMessageAt && next.lastMessageAt != null) stamp.push('lastMessageAt');
  return { set: set as Partial<SessionInfo>, ...(drop.length ? { drop } : {}), stamp };
}

export interface BeatStart {
  /** The session as atelierd holds it when the beat starts (internal bookkeeping included). */
  raw: SessionInfo;
  /** Its terminal: main's view of it (the work attached). */
  terminal: TerminalInfo;
  root: string;
  /** The build clock when the beat starts (auto beats: t0, the demo's start). */
  at: number;
  /** The session's background changes in this beat: ship the work and recently ended items with each patch. */
  work?: boolean;
  /** Exit codes of the background shells that end in this beat (main reads them from the output's trailer). */
  exits?: Record<string, number>;
}

/** The time a step takes on the build clock (the runtime's pace is close enough: these times only age the items). */
function duration(s: SourceStep, elapsed: number): number {
  if ('hook' in s) return 10;
  switch (s.k) {
    case 'wait': return s.ms;
    case 'until': return Math.max(0, s.ms - elapsed);
    case 'out': return s.lines.length * s.every;
    case 'say': return s.lines.length * 300;
    default: return 0;
  }
}

/**
 * Compiles a beat from the state its session is in: each segment from the state the step that leads to it left (an
 * ask's answers all start from the state at the ask). Runs of hooks become one `session` step each.
 */
export function compileBeat(src: SourceBeat, start: BeatStart): CompiledBeat {
  const segments: Record<string, BeatStep[]> = {};
  // The terminal as main last sent it (its recent items move with the beat).
  let term = start.terminal;
  const view =(s: SessionInfo, at: number): TerminalInfo => withWork({ ...term, session: publicSession(s) }, at);
  const book = new RecentBook();
  if (start.work) book.apply([term], start.at);

  const walk = (name: string, from: SessionInfo, at0: number, elapsed0: number) => {
    if (segments[name]) return;
    const steps = src.segments[name];
    if (!steps) throw new Error(`beat: no segment "${name}"`);
    const out: BeatStep[] = [];
    segments[name] = out;
    let s = structuredClone(from);
    let at = at0;
    let elapsed = elapsed0;
    let run: { before: TerminalInfo } | null = null;
    const flush = () => {
      if (!run) return;
      const after = view(s, at);
      const patch = patchOf(run.before.session!, after.session!);
      if (start.work) {
        let { list, ended } = book.apply([after], at);
        for (const e of ended) if (start.exits?.[e.id] !== undefined) book.setExit(e.terminalId, e.id, start.exits[e.id]!);
        if (ended.length) ({ list } = book.apply([after], at));
        const t = list[0]!;
        if (!same(run.before.work, after.work)) patch.work = after.work ?? null;
        if (!same(run.before.recent, t.recent)) patch.recent = t.recent ?? null;
        term = { ...after, ...(t.recent ? { recent: t.recent } : {}) };
      }
      out.push({ k: 'session', patch });
      run = null;
    };
    for (const step of steps) {
      const d = duration(step, elapsed);
      if ('hook' in step) {
        if (!run) run = { before: start.work ? { ...view(s, at), recent: term.recent } : view(s, at) };
        const payload = payloadOf(step.hook, s.sessionId, start.root);
        const next = reduceHook(s, payload, at);
        if (!next) throw new Error(`beat: hook ${String(step.hook.hook_event_name)} was refused`);
        s = next;
        // An edit's PostToolUse must be one atelierd attributes (the runtime stamps the terminal on it).
        if (payload.hook_event_name === 'PostToolUse' && ['Edit', 'Write'].includes(String(payload.tool_name)) && !attributionFromHook(payload, { id: 'x', color: 'x', title: 'x' }, at)) {
          throw new Error(`beat: ${String(payload.tool_name)} of ${JSON.stringify(payload.tool_input)} would not be attributed`);
        }
      } else {
        flush();
        out.push(step);
        if (step.k === 'ask') {
          const routes = new Set([...step.ask.routes, step.ask.cancel]);
          for (const r of routes) walk(r, s, at, elapsed);
        }
      }
      at += d;
      elapsed += d;
    }
    flush();
  };
  walk(src.start, start.raw, start.at, 0);
  const interrupt = interruptOf(start.raw, start.root, start.at);
  return { start: src.start, segments, ...(interrupt ? { interrupt } : {}) };
}

/**
 * Esc while Claude works: Claude Code sends no Stop after an interruption; its idle notice frees the session (the
 * reducer's Notification idle_prompt), which the demo applies at once. The state fields only, so it fits any working
 * step of the beat. None while background agents run: Claude Code holds that notice until they end, and the app keeps
 * the session working.
 */
export function interruptOf(raw: SessionInfo, root: string, at: number): SessionPatch | undefined {
  const hook = (h: Hook) => payloadOf(h, raw.sessionId, root);
  const working = reduceHook(structuredClone(raw), hook({ hook_event_name: 'UserPromptSubmit', prompt: 'interrupted' }), at);
  if (!working) throw new Error('interrupt: UserPromptSubmit was refused');
  if ((working.subagents ?? 0) > 0) return undefined;
  const ready = reduceHook(structuredClone(working), hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), at + 10);
  if (!ready) throw new Error('interrupt: the idle notice was refused');
  return patchOf(publicSession(working), publicSession(ready));
}

/** A new session's state when Claude has started (SessionStart, then its first status line): the template stamped at runtime. */
export function newSessionTemplate(root: string, t0: number): SessionInfo {
  const sessionId = '00000000-0000-4000-8000-000000000000';
  const started = reduceHook(null, { hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId, cwd: root }, t0);
  if (!started) throw new Error('new session: SessionStart was refused');
  const { session } = applyStatusLine(started, {
    session_id: sessionId, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    cost: { total_cost_usd: 0, total_lines_added: 0, total_lines_removed: 0 }, context_window: { used_percentage: 0 }
  }, t0);
  if (!session) throw new Error('new session: the status line was refused');
  return publicSession(session);
}

/** The raw state a free-prompt beat is compiled from: a finished turn, nothing in the background. */
export function genericStart(raw: SessionInfo): SessionInfo {
  const { background: _bg, ...rest } = structuredClone(raw);
  return { ...rest, subagents: 0, agentRuns: {}, agentWaits: {} };
}

const BILLING_SHELL = 'b7k2m9q4x';

/**
 * Everything the beats need at runtime: each beat compiled from where it starts (a scripted session's own state, or,
 * for free prompts and diagnoses, a finished turn), what each session plays, a new session's template, the feeds and
 * the crons' periods.
 */
export function compileDemoBeats(root: string, t0: number, sessions: readonly DemoSession[], raw: Record<ScenarioName, SessionInfo>): DemoBeats {
  const byScenario = new Map(sessions.map((s) => [s.scenario, s]));
  const billing = byScenario.get('billing-tests')!;
  const generic = byScenario.get('onboarding-copy')!;
  const beats = {} as Record<BeatName, CompiledBeat>;
  const played = new Map<BeatName, ScenarioName>(Object.entries(SESSION_BEATS).map(([name, p]) => [p!.beat, name as ScenarioName]));
  for (const name of Object.keys(BEATS) as BeatName[]) {
    const own = played.get(name);
    const auto = own ? SESSION_BEATS[own]!.auto : false;
    beats[name] = compileBeat(BEATS[name], {
      raw: own ? raw[own] : genericStart(raw['onboarding-copy']), terminal: (own ? byScenario.get(own)! : generic).terminal, root,
      at: auto ? t0 : t0 + 60_000, work: auto, ...(own === 'billing-tests' ? { exits: { [BILLING_SHELL]: BILLING_FEEDS.b7k2m9q4x.exit } } : {})
    });
  }

  const feeds: Record<string, CompiledFeed> = {};
  const bg = SCENARIOS['billing-tests'].background!;
  for (const a of bg.agents ?? []) feeds[feedKey(billing.terminal.id, a.id)] = agentFeed(a, root, t0, BILLING_FEEDS[a.id as 'a1' | 'a2']);
  const shell = bg.shells!.find((x) => x.id === BILLING_SHELL)!;
  feeds[feedKey(billing.terminal.id, shell.id)] = shellFeed([...shell.output, ...BILLING_SHELL_TAIL], BILLING_FEEDS.b7k2m9q4x);
  feeds[feedKey(billing.terminal.id, BILLING_WATCH.id)] = watchFeed(BILLING_WATCH);

  // A cron's period: its next fire after the next one (backgroundWork knows the schedule; the runtime only adds).
  const crons: Record<string, Record<string, number>> = {};
  for (const s of sessions) {
    for (const c of s.terminal.work?.crons ?? []) {
      if (c.next === null) continue;
      const after = withWork({ ...s.terminal, work: undefined }, c.next + 1).work?.crons.find((x) => x.id === c.id)?.next;
      if (after) (crons[s.terminal.id] ??= {})[c.id] = after - c.next;
    }
  }

  return {
    beats,
    generic: [...GENERIC_BEATS],
    diagnose: { worker: 'diagnose-worker', job: 'diagnose-job' },
    sessions: Object.fromEntries(Object.entries(SESSION_BEATS).map(([name, p]) => [byScenario.get(name as ScenarioName)!.terminal.id, { beat: p!.beat, auto: p!.auto }])),
    fresh: { session: newSessionTemplate(root, t0), transcript: welcome(root) },
    feeds,
    crons,
    colors: [...SESSION_COLORS]
  };
}
