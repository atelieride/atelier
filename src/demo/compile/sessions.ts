// The five Claude sessions, compiled: each scenario's hook and statusline
// payloads, the ones tests/e2e/fake-claude-demo.pl sends for the screenshots, go through the app's own reducers as
// atelierd applies them; the background work is attached as main attaches it. Node, build time only: the runtime gets
// the resulting TerminalInfo and never the reducers. Relative imports only (the demo's Vite config loads this module
// through esbuild, which knows no `@shared` alias).
import { createHash } from 'node:crypto';
import { addAttribution, attributionFromHook, type Attribution } from '../../shared/attribution';
import { backgroundWork } from '../../shared/background';
import type { TerminalInfo } from '../../shared/protocol';
import { applyStatusLine, markSeen, mergeUsageByDir, publicSession, reduceHook, type SessionInfo, type UsageEntry } from '../../shared/session';
import { encodeProjectPath } from '../../shared/history';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { screenOf } from '../engine/claude-screen';
import type { DemoSession } from '../types';
import { DEMO_HOME, accountDir, scenarioAccount } from '../world/accounts';
import { PROJECT_NAME } from '../world/project';
import { SCENARIOS, type Scenario, type ScenarioName } from '../world/scenarios';

/**
 * The fictional project lives at /home/ada/code/acme-store — the header shows "/…/code/acme-store" as in the
 * overview shot, and the site's guard bans "/Users/" in anything it serves. A Mac user may find the path odd in a tooltip;
 * nothing else depends on it.
 */
export const DEMO_ROOT = `${DEMO_HOME}/code/${PROJECT_NAME}`;

/** The build's clock: fixed, so the same world gives the same bytes; the docker logs' wall-clock texts end near it. */
export const T0 = Date.parse('2026-10-15T07:43:22.000Z');

/** atelierd's identity colours (src/daemon/terminals.ts, a copy: that module loads node-pty; a test keeps them equal). */
export const SESSION_COLORS = ['#B794F6', '#4FC3D9', '#F28FAD', '#A3D977', '#F2A766', '#7CC4FF', '#E8A0E8', '#E6D06E'];

/** A version-4 UUID derived from a label: stable across builds, shaped like the ids atelierd and Claude Code use. */
export function stableUuid(label: string): string {
  const h = createHash('sha256').update(label).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Payload = Record<string, unknown>;

/**
 * The hook payloads fake-claude-demo.pl sends for a scenario, in order (its session_id added by the bridge). With a
 * `transcriptPath` (under the session's Claude account dir), SessionStart and the status line carry it, as Claude Code
 * sends them: atelierd learns the session's config dir from it. The limits are those of the scenario's account.
 */
export function hookPayloads(name: ScenarioName, sc: Scenario, cwd: string, nowSec: number, transcriptPath?: string): { hooks: Payload[]; status: Payload; statusAfter: number } {
  const transcript = transcriptPath ? { transcript_path: transcriptPath } : {};
  const hooks: Payload[] = [
    { hook_event_name: 'SessionStart', source: 'startup', session_title: name, cwd, ...transcript },
    { hook_event_name: 'UserPromptSubmit', prompt: sc.prompt, session_title: name }
  ];
  for (const e of sc.edits) {
    const tool_input = { file_path: `${cwd}/${e.file}` };
    hooks.push({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input }, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input });
  }
  // The status line comes here, between the edits and the background work.
  const statusAfter = hooks.length;
  const bg = sc.background;
  const started = new Set<string>();
  if (bg?.crons?.length) {
    hooks.push({ hook_event_name: 'Stop', session_crons: bg.crons }, { hook_event_name: 'UserPromptSubmit', prompt: sc.prompt, session_title: name });
  }
  for (const a of bg?.agents ?? []) {
    const type = a.type ?? 'Explore';
    hooks.push({ hook_event_name: 'SubagentStart', agent_id: a.id, agent_type: type });
    started.add(a.id);
    hooks.push({
      hook_event_name: 'PostToolUse', tool_name: 'Agent',
      tool_input: { description: a.description, prompt: a.task, subagent_type: type, run_in_background: true },
      tool_response: { status: 'async_launched', agentId: a.id }
    });
  }
  for (const b of bg?.shells ?? []) {
    hooks.push({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: b.command, description: b.description, run_in_background: true },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: b.id }
    });
  }
  if (sc.state === 'permission') {
    hooks.push({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: sc.command } }, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: sc.command } });
  } else if (sc.state === 'question') {
    hooks.push({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
  } else if (sc.state === 'working') {
    for (let i = 1; i <= (sc.agents ?? 0); i++) if (!started.has(`a${i}`)) hooks.push({ hook_event_name: 'SubagentStart', agent_id: `a${i}`, agent_type: 'Explore' });
    hooks.push({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${cwd}/README.md` } });
  } else {
    hooks.push({ hook_event_name: 'Stop' });
  }
  const { limits } = scenarioAccount(sc);
  const status: Payload = {
    ...transcript,
    session_name: name,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    cost: { total_cost_usd: sc.cost, total_lines_added: sc.added, total_lines_removed: sc.removed },
    context_window: { used_percentage: sc.context },
    rate_limits: { five_hour: { used_percentage: limits.fiveHour, resets_at: nowSec + 2 * 3600 }, seven_day: { used_percentage: limits.sevenDay, resets_at: nowSec + 3 * 86400 } }
  };
  return { hooks, status, statusAfter };
}

/** Each event a few ms after the previous one. */
const STEP_MS = 10;
/**
 * The sessions start one after another, as the screenshots create them (a few seconds each), the last one ending a
 * second before t0: the sidebar sorts each group by the latest update, so db-migration sits above auth-refactor and
 * docs above billing-tests, as in the overview shot.
 */
const SESSION_GAP_MS = 3000;
/**
 * The limits' resets, a little later than the Perl's time() + 2 h: the demo shows them a moment after its build clock,
 * and the bar floors to the minute ("2h0m" in the shot, taken the same second).
 */
const RESET_SLACK_S = 30;

/** Sessions that finished while in front: markSeen, as the window does for the session you look at (the overview shot). */
const SEEN: ReadonlySet<ScenarioName> = new Set(['onboarding-copy']);

/**
 * `raw`: each session as atelierd holds it at the end (internal bookkeeping included), for the beats to go on from
 * (compile/beats.ts); never shipped.
 */
export function compileSessions(root: string, t0: number): { sessions: DemoSession[]; usage: UsageEntry[]; attributions: Attribution[]; raw: Record<ScenarioName, SessionInfo> } {
  const names = Object.keys(SCENARIOS) as ScenarioName[];
  let usage: UsageEntry[] = [];
  let attributions: Attribution[] = [];
  const raw = {} as Record<ScenarioName, SessionInfo>;
  const sessions = names.map((name, index): DemoSession => {
    const sc = SCENARIOS[name];
    const id = stableUuid(`terminal:${name}`);
    const sessionId = stableUuid(`session:${name}`);
    const color = SESSION_COLORS[index % SESSION_COLORS.length]!;
    const configDir = accountDir(DEMO_HOME, scenarioAccount(sc).id);
    const transcriptPath = `${configDir}/projects/${encodeProjectPath(root)}/${sessionId}.jsonl`;
    const { hooks, status, statusAfter } = hookPayloads(name, sc, root, Math.floor(t0 / 1000) + RESET_SLACK_S, transcriptPath);
    const end = t0 - 1000 - (names.length - 1 - index) * SESSION_GAP_MS;
    const createdAt = end - (hooks.length + 2) * STEP_MS - 500;
    let at = end - (hooks.length + 1) * STEP_MS;
    let s: SessionInfo | null = null;
    const applyStatus = () => {
      const r = applyStatusLine(s, { ...status, session_id: sessionId }, at);
      s = r.session;
      if (r.usage) usage = mergeUsageByDir(usage, r.configDir, r.usage, Math.floor(at / 1000));
      at += STEP_MS;
    };
    hooks.forEach((h, i) => {
      if (i === statusAfter) applyStatus();
      const payload = { ...h, session_id: sessionId };
      const next = reduceHook(s, payload, at);
      if (next === undefined) throw new Error(`${name}: hook ${String(h.hook_event_name)} was refused`);
      s = next;
      const a = attributionFromHook(payload, { id, color, title: name }, at);
      if (a) attributions = addAttribution(attributions, a);
      at += STEP_MS;
    });
    if (statusAfter >= hooks.length) applyStatus();
    if (!s) throw new Error(`${name}: no session`);
    if (SEEN.has(name)) s = markSeen(s);
    raw[name] = s;
    const session = publicSession(s);
    const base: TerminalInfo = {
      id, projectRoot: root, cwd: root, title: name, name, color, foreground: 'claude', createdAt,
      session, profile: 'atelier', configDir
    };
    return { scenario: name, terminal: withWork(base, t0), screen: screenOf(sc) };
  });
  return { sessions, usage, attributions, raw };
}

/**
 * main's attachWork (src/main/work-hub.ts) for one terminal with no work scan yet: the work computed, the items sent
 * without their raw commands. A copy of its few lines (that module loads main's process readers); a test compares them.
 */
export function withWork(t: TerminalInfo, now: number): TerminalInfo {
  const bg = t.session?.background;
  if (!t.session || !bg) return t;
  const work = backgroundWork(t.session, null, now, { countAsWork: DEFAULT_SETTINGS.countBackgroundWork });
  const items = bg.items.map(({ command: _command, ...rest }) => rest);
  return { ...t, session: { ...t.session, background: { ...bg, items } }, work };
}
