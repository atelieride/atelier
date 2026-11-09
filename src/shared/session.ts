import { endLimitPause, isLimitPaused } from './limit-pause';
import { isAbsPath } from './paths';
import { pathStyle } from './platform';

export type SessionState = 'idle' | 'running' | 'waiting' | 'done' | 'error';

/** Why a usage-limit wait ended without Claude continuing. */
export type LimitPauseEnd = 'unconfirmed' | 'stale' | 'disabled' | 'cancelled' | 'expired';
export interface LimitPause { since: number; resetsAt: number | null; over?: LimitPauseEnd }

export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  title: string | null;
  activity: string | null;
  contextPct: number | null;
  unread: boolean;
  updatedAt: number;
  /**
   * When the conversation last had a message: your prompt (UserPromptSubmit) or the end of Claude's
   * reply (Stop, StopFailure); a resumed conversation starts with its own last time (seedLastMessage). Null: none yet.
   * Optional: an atelierd from an earlier build doesn't send it (capability 'lastmessage').
   */
  lastMessageAt?: number | null;
  /** Folder where Claude was started: that is where `claude --resume` finds the session. */
  cwd?: string;
  /**
   * From the status line: model and session totals. Optional: an atelierd from an earlier build does not send them
   * (they arrive after its restart), and the app treats them as absent.
   */
  model?: string | null;
  cost?: SessionCost | null;
  /**
   * v2.0 fields (capability 'states2'), all optional: an atelierd from an earlier build does not send them.
   * waitingFor: what Claude waits for — a permission (tool, plan approval), an answer (AskUserQuestion, MCP
   * elicitation) or, with the turn over, a new prompt (idle notice). Null when not waiting.
   */
  waitingFor?: WaitingFor | null;
  /** Between PreCompact and PostCompact (or the next activity). */
  compacting?: boolean;
  /**
   * Subagents running: the ids started (SubagentStart) and not stopped (SubagentStop), at most 99. Background
   * subagents outlive the main turn, so Stop/UserPromptSubmit keep them; SessionStart (not compact) and SessionEnd
   * clear them, and an id with no event for 2 hours is dropped.
   */
  subagents?: number;
  /** Raw StopFailure code (rate_limit, overloaded, …) while the state is 'error'; the app maps it to a label. */
  errorReason?: string | null;
  /**
   * Claude Code's usage-limit wait: only while state is 'error' with errorReason
   * 'rate_limit'. since: when the limit stopped the turn (ms). resetsAt: ms, null while atelierd is still checking that
   * this is a usage limit (at most CHECK_MS). over: the wait ended without a continuation (absent while it lasts).
   * A session that never paused has no key at all.
   */
  limitPause?: LimitPause;
  /** Claude Code's permission mode from the hook inputs (default, plan, acceptEdits, auto, dontAsk, bypassPermissions). */
  permissionMode?: string | null;
  /** The session's first prompt, cleaned and cut to 60 characters: the title when no name and no Claude title. */
  autoTitle?: string | null;
  /**
   * Capability 'background': the session's background work according to Claude Code. Items:
   * the running subagents (mirroring `subagents`) and the background shells, monitors and other tasks, from the
   * `background_tasks` snapshot of Stop/SubagentStop and the tool events in between; crons: `session_crons`.
   * SessionStart (not compact) and SessionEnd clear it; an item unconfirmed for 24 hours is dropped.
   */
  background?: SessionBackground;
  /**
   * atelierd-internal (stripped before a session leaves the daemon): the pending waits per agent (`agent_id`, or
   * 'main' for the main agent), so a subagent's tool events never clear another agent's permission or question.
   */
  agentWaits?: Record<string, AgentWait>;
  /** atelierd-internal: the subagents running (agent key → time of its last event), behind `subagents`. */
  agentRuns?: Record<string, number>;
  /**
   * atelierd-internal: the main agent's turn is over (Stop → 'done', the idle notice → 'idle'), so a background
   * subagent's tool events leave the state alone; null while the main agent works.
   */
  mainRest?: 'done' | 'idle' | null;
  /** atelierd-internal: background task id → key of the agent that launched it (incremental events only). */
  bgOwners?: Record<string, string>;
  /** atelierd-internal: background task id → time a snapshot or an event last confirmed it (the 24-hour hygiene). */
  bgSeen?: Record<string, number>;
  /**
   * atelierd-internal: a running subagent's description (agent key → label), from the Agent call that launched it or
   * a snapshot entry; its `agent` item's label for the subagent's life, over its agent_type.
   */
  agentDescriptions?: Record<string, string>;
  /**
   * atelierd-internal: the subagents kept after their SubagentStop only because work they launched still runs (agent
   * keys); their next own event (the wake-up) takes them off. Published as `waiting` on their agent items.
   */
  agentsWaiting?: string[];
}

export type BackgroundKind = 'agent' | 'shell' | 'monitor' | 'other';
/**
 * A piece of background work. id: Claude Code's task id, or the subagent's agent_id (≤ 64 chars); label: one line,
 * secrets redacted, ≤ 80 chars; command: shells and monitors, the raw command (≤ 2048 chars) for matching only, never
 * shown; since: when atelierd first saw it (ms).
 *
 * Optional, from a later atelierd (an app must work without them, an older app ignores them):
 * - owner: shells, monitors and other tasks launched by a subagent, its id (the id of its `agent` item); absent for
 *   the main agent's and for tasks only a snapshot told about.
 * - waiting: agent items, true when the subagent's last event was its SubagentStop and it is kept only because work it
 *   launched still runs.
 * - lastEvent: agent items, ms of the subagent's last event (it is taken as gone 2 hours after it, SUBAGENT_TTL_MS).
 * - persistent: monitors, Claude Code's `persistent` from the Monitor call (recorded, not used yet).
 */
export interface BackgroundItem {
  id: string; kind: BackgroundKind; label: string; command?: string; since: number;
  owner?: string; waiting?: boolean; lastEvent?: number; persistent?: boolean;
}
/** A scheduled wake-up: 5-field cron in local time; label: the prompt, redacted, ≤ 60 chars. */
export interface CronItem { id: string; schedule: string; recurring: boolean; label: string }
export interface SessionBackground { items: BackgroundItem[]; crons: CronItem[] }

export type WaitingFor = 'permission' | 'question' | 'input';
export interface AgentWait { kind: 'permission' | 'question'; activity: string }

/** Session totals according to Claude Code: cost in dollars (API equivalent) and lines added and removed. */
export interface SessionCost { usd: number; linesAdded: number; linesRemoved: number }

/** `seenAt`: when the terminal it came from last saw these numbers move (atelierd stamps it, see stampUsage). */
export interface UsageWindow { pct: number; resetsAt: number; seenAt?: number }
export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  updatedAt: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const base = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Notification types (Claude Code hooks docs) that mean Claude waits for the user, and for what.
const WAITING_NOTIFICATIONS = new Map<string, WaitingFor>([
  ['permission_prompt', 'permission'],
  ['elicitation_dialog', 'question'],
  ['elicitation_url_dialog', 'question'],
  ['agent_needs_input', 'question']
]);
// An MCP elicitation answered: the tool call goes on.
const ANSWERED_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response']);
// Claude Code's wait at a usage limit: it continues the task by itself (fired),
// or the wait is over without a continuation: it waits for Enter (stale), or auto-continue is off (disabled).
const QUOTA_FIRED = 'quota_auto_resume_fired';
const QUOTA_STALE = 'quota_auto_resume_stale';
const QUOTA_DISABLED = 'quota_auto_resume_disabled';
const KNOWN = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact'
]);
const MAX_SUBAGENTS = 99;
/** A subagent with no event for this long is taken as gone (its SubagentStop was lost). */
export const SUBAGENT_TTL_MS = 2 * 60 * 60 * 1000;
const ANON_AGENT = 'anon:';
const AUTO_TITLE_CHARS = 60;
const PERMISSION_MODE = /^[A-Za-z]{1,32}$/;
// Control characters, format characters (zero-width, bidi overrides, BOM) and line/paragraph separators: never
// part of a title.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const modeOf = (payload: Obj): string | null => {
  const m = str(payload.permission_mode);
  return m && PERMISSION_MODE.test(m) ? m : null;
};

/** Cuts to `max` characters (code points), on a word boundary when one is close, with an ellipsis. */
function cut(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  let head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  if (space >= head.length * 0.66) head = head.slice(0, space);
  return head.trimEnd() + '…';
}

// Token-like runs a prompt may carry (API keys, access tokens, hashes, blobs): a title is shown everywhere (rows,
// tabs, banners, the resumables list), so they become "…". Specific prefixes first, then the generic shapes.
const SECRETS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe keys
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, // GitHub tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g // long hex (hashes, secrets)
];
// Long base64-like runs: only when they mix digits, upper and lower case (paths and words don't).
const BLOB = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}/g;
const isBlob = (run: string) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);

/** Replaces token-like runs (keys, tokens, long hex or base64) with "…". */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRETS) out = out.replace(re, '…');
  return out.replace(BLOB, (run) => (isBlob(run) ? '…' : run));
}

/**
 * A title from a prompt: one line, no control characters, no token-like runs, at most 60 characters. Null for slash
 * commands and for the messages Claude Code itself submits (a background subagent reporting back, a scheduled task:
 * they start with a tag), and for empty prompts.
 */
export function promptTitle(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return null;
  const text = cleanLine(prompt);
  if (!text || text.startsWith('/') || text.startsWith('<')) return null;
  return cut(text, AUTO_TITLE_CHARS);
}

/** One line of text to show: no control or invisible characters, whitespace collapsed, token-like runs redacted. */
function cleanLine(text: string): string {
  return redactSecrets(text.slice(0, 4096).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim());
}

export function describeTool(toolName: string, toolInput: unknown): string {
  const i = isObj(toolInput) ? toolInput : {};
  const file = str(i.file_path) ?? str(i.notebook_path);
  switch (toolName) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? `edit ${base(file)}` : 'edit';
    case 'Write': return file ? `write ${base(file)}` : 'write';
    case 'Read': return file ? `read ${base(file)}` : 'read';
    case 'Grep': case 'Glob': return str(i.pattern) ? `search ${clip(str(i.pattern)!)}` : 'search';
    case 'Bash': {
      const d = str(i.description) ?? str(i.command);
      return d ? `Bash: ${clip(d.replace(/\s+/g, ' '))}` : 'Bash';
    }
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
      return m ? `${m[1]} · ${m[2]}` : toolName;
    }
  }
}

function fresh(sessionId: string, now: number): SessionInfo {
  return {
    sessionId, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: now, lastMessageAt: null, model: null, cost: null,
    waitingFor: null, compacting: false, subagents: 0, errorReason: null, permissionMode: null, autoTitle: null,
    background: { items: [], crons: [] }, agentRuns: {}, mainRest: null, bgOwners: {}, bgSeen: {}, agentDescriptions: {}
  };
}

/** Tools that always stop for the user: Claude's multiple-choice question and the plan approval. */
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';
const MAX_AGENT_WAITS = 100;
export const MAIN_AGENT = 'main';

export const agentOf = (payload: Record<string, unknown>): string => {
  const id = str(payload.agent_id);
  return id ? `agent:${id.slice(0, 128)}` : MAIN_AGENT;
};

/** The state that the pending waits give: the most urgent one (permission, then question; latest first) shows. */
function showWaits(s: SessionInfo): boolean {
  const waits = Object.values(s.agentWaits ?? {}).reverse();
  const top = waits.find((w) => w.kind === 'permission') ?? waits[0];
  if (!top) return false;
  s.state = 'waiting'; s.waitingFor = top.kind; s.activity = top.activity;
  return true;
}

function addWait(s: SessionInfo, agent: string, wait: AgentWait): void {
  const waits = { ...(s.agentWaits ?? {}) };
  delete waits[agent];
  const keys = Object.keys(waits);
  if (keys.length >= MAX_AGENT_WAITS) delete waits[keys[0]!];
  waits[agent] = wait;
  s.agentWaits = waits;
  showWaits(s);
}

/** That agent goes on: its wait (if any) is over; returns whether another agent still waits. */
function endWait(s: SessionInfo, agent: string): boolean {
  if (s.agentWaits && agent in s.agentWaits) {
    const waits = { ...s.agentWaits };
    delete waits[agent];
    s.agentWaits = waits;
  }
  return showWaits(s);
}

function setRuns(s: SessionInfo, runs: Record<string, number>): void {
  s.agentRuns = runs;
  s.subagents = Object.keys(runs).length;
}

const oldestOf = (entries: [string, number][]): string | undefined =>
  entries.reduce<[string, number] | undefined>((a, b) => (!a || b[1] < a[1] ? b : a), undefined)?.[0];

/**
 * A subagent starts: tracked by its agent key, or anonymously when it has no agent_id; at most 99 (oldest out).
 * Returns the key it is tracked by.
 */
function startRun(s: SessionInfo, agent: string, now: number): string {
  const runs = { ...(s.agentRuns ?? {}) };
  let key = agent;
  if (agent === MAIN_AGENT) {
    let i = 1;
    while (`${ANON_AGENT}${i}` in runs) i += 1;
    key = `${ANON_AGENT}${i}`;
  }
  if (!(key in runs) && Object.keys(runs).length >= MAX_SUBAGENTS) delete runs[oldestOf(Object.entries(runs))!];
  runs[key] = now;
  setRuns(s, runs);
  return key;
}

/** A subagent stops: only one that was started (an unknown id changes nothing); without agent_id, an anonymous one. */
function stopRun(s: SessionInfo, agent: string): void {
  const runs = { ...(s.agentRuns ?? {}) };
  const key = agent === MAIN_AGENT ? oldestOf(Object.entries(runs).filter(([k]) => k.startsWith(ANON_AGENT))) : agent;
  if (key === undefined || !(key in runs)) return;
  delete runs[key];
  setRuns(s, runs);
}

/** Keeps only the subagents in `listed` or owning one of `others` (a subagent waiting on its own work). */
function pruneRuns(s: SessionInfo, others: BackgroundItem[], listed: Set<string>): void {
  const owners = new Set(others.map((i) => s.bgOwners?.[i.id]));
  setRuns(s, Object.fromEntries(Object.entries(s.agentRuns ?? {}).filter(([k]) => listed.has(k) || owners.has(k))));
}

/** Drops the subagents with no event for 2 hours (their SubagentStop was lost); the same object when none is. */
export function expireSubagents(s: SessionInfo, now: number): SessionInfo {
  const runs = s.agentRuns;
  if (!runs) return s;
  const all = Object.entries(runs);
  const live = all.filter(([, at]) => now - at <= SUBAGENT_TTL_MS);
  if (live.length === all.length) return s;
  const next = { ...s, agentRuns: Object.fromEntries(live), subagents: live.length };
  settleBackground(next, othersOf(next), now);
  return next;
}

/** Background items no snapshot or event has confirmed for this long are dropped (the cap on work lives in the app). */
export const BACKGROUND_HYGIENE_MS = 24 * 60 * 60 * 1000;
const MAX_BACKGROUND_ITEMS = 32;
const MAX_CRONS = 8;
const TASK_ID_CHARS = 64;
/** The longest command kept on a background item, for matching (clipped beyond it; the app matches those by prefix). */
export const COMMAND_CHARS = 2048;
const BACKGROUND_LABEL_CHARS = 80;
const CRON_LABEL_CHARS = 60;
const SCHEDULE_CHARS = 64;
// Statuses of work that is over; anything else counts, so a new "still going" status is never missed.
const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'done']);
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);
const TASK_NOTIFICATION = '<task-notification>';
const NOTIFIED_TASK = /<task-id>([^<]{1,256})<\/task-id>/;
const AGENT_PREFIX = 'agent:';
const AGENT_TOOL = 'Agent';

export const taskId = (v: unknown): string | null => str(v)?.slice(0, TASK_ID_CHARS) ?? null;
const labelOf = (text: string | null, max = BACKGROUND_LABEL_CHARS): string | null => {
  const t = text ? cleanLine(text) : '';
  return t ? cut(t, max) : null;
};
/** The shells, monitors and other tasks: everything but the subagents' mirror. */
const othersOf = (s: SessionInfo): BackgroundItem[] => (s.background?.items ?? []).filter((i) => i.kind !== 'agent');
const keep = <T>(rec: Record<string, T> | undefined, ids: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(rec ?? {}).filter(([id]) => ids.has(id)));

function taskItem(id: string, kind: Exclude<BackgroundKind, 'agent'>, description: string | null, command: string | null, since: number, persistent?: boolean): BackgroundItem {
  const label = labelOf(description) ?? labelOf(command) ?? (kind === 'other' ? 'task' : kind);
  const item: BackgroundItem = { id, kind, label, since };
  if (command && kind !== 'other') item.command = command.slice(0, COMMAND_CHARS);
  if (persistent !== undefined) item.persistent = persistent;
  return item;
}

/** The public id of an agent key (its agent item's id), or null for the main agent and anonymous subagents. */
const agentIdOf = (key: string | undefined): string | null =>
  key?.startsWith(AGENT_PREFIX) ? key.slice(AGENT_PREFIX.length, AGENT_PREFIX.length + TASK_ID_CHARS) : null;

/** A subagent's description, kept while it runs (an id not running, e.g. a foreground agent already over, is ignored). */
function describeAgent(s: SessionInfo, key: string, description: string | null): void {
  const label = labelOf(description);
  if (label && s.agentRuns && key in s.agentRuns) s.agentDescriptions = { ...(s.agentDescriptions ?? {}), [key]: label };
}

/**
 * Rebuilds the items: one `agent` item per running subagent (label: its description, else its type from `labels` by
 * agent key, else the one it had, else "agent"; its last event; whether it is kept waiting on its own work), then the
 * other items with their owner, newest kept within the cap. Owners, confirmation times, descriptions and waiting
 * marks follow the items.
 */
function settleBackground(s: SessionInfo, others: BackgroundItem[], now: number, labels = new Map<string, string>()): void {
  const prev = new Map((s.background?.items ?? []).filter((i) => i.kind === 'agent').map((i) => [i.id, i]));
  const runs = s.agentRuns ?? {};
  const keys = Object.keys(runs);
  const descriptions = keep(s.agentDescriptions, new Set(keys));
  const waiting = (s.agentsWaiting ?? []).filter((k) => k in runs);
  const agents = keys.slice(-MAX_BACKGROUND_ITEMS).map((key): BackgroundItem => {
    const id = agentIdOf(key) ?? key;
    const old = prev.get(id);
    const item: BackgroundItem = { id, kind: 'agent', label: descriptions[key] ?? labels.get(key) ?? old?.label ?? 'agent', since: old?.since ?? now, lastEvent: runs[key]! };
    if (waiting.includes(key)) item.waiting = true;
    return item;
  });
  s.agentDescriptions = descriptions;
  s.agentsWaiting = waiting;
  const kept = others.slice(Math.max(0, others.length - Math.max(0, MAX_BACKGROUND_ITEMS - agents.length)));
  const ids = new Set(kept.map((i) => i.id));
  s.bgOwners = keep(s.bgOwners, ids);
  s.bgSeen = keep(s.bgSeen, ids);
  const owned = kept.map((i): BackgroundItem => {
    const { owner: _owner, ...rest } = i;
    const owner = agentIdOf(s.bgOwners![i.id]);
    return owner ? { ...rest, owner } : rest;
  });
  s.background = { items: [...agents, ...owned], crons: s.background?.crons ?? [] };
}

/**
 * Stop/SubagentStop's `background_tasks`: the session's running work. The shells, monitors and other tasks become
 * exactly its unfinished entries (`since` kept for known ids; a known monitor stays one, Claude Code calls it a
 * shell); a subagent unknown to the count is added (a lost SubagentStart), none is ever removed (the main Stop omits
 * a subagent waiting on its own shell). `self`: the stopping subagent, which lists itself.
 */
function applySnapshot(s: SessionInfo, tasks: unknown[], self: string | null, now: number, labels: Map<string, string>, listed: Set<string>): BackgroundItem[] {
  const known = new Map(othersOf(s).map((i) => [i.id, i]));
  const seen = { ...(s.bgSeen ?? {}) };
  const out = new Map<string, BackgroundItem>();
  for (const t of tasks) {
    if (!isObj(t)) continue;
    const raw = str(t.id);
    const id = taskId(raw);
    const status = str(t.status)?.toLowerCase();
    if (!raw || !id || raw === self || out.has(id) || (status && FINISHED.has(status))) continue;
    const type = str(t.type);
    if (type === 'subagent') {
      const key = startRun(s, `${AGENT_PREFIX}${raw.slice(0, 128)}`, now);
      listed.add(key);
      const agentType = labelOf(str(t.agent_type));
      if (agentType) labels.set(key, agentType);
      describeAgent(s, key, str(t.description));
      continue;
    }
    const old = known.get(id);
    const kind = type === 'monitor' || (type === 'shell' && old?.kind === 'monitor') ? 'monitor' : type === 'shell' ? 'shell' : 'other';
    out.set(id, taskItem(id, kind, str(t.description), str(t.command), old?.since ?? now, old?.persistent));
    seen[id] = now;
  }
  s.bgSeen = seen;
  return [...out.values()];
}

/** `session_crons`: the scheduled wake-ups, at most 8. */
function cronsOf(list: unknown[]): CronItem[] {
  const out: CronItem[] = [];
  for (const c of list) {
    if (out.length >= MAX_CRONS) break;
    if (!isObj(c)) continue;
    const id = taskId(c.id);
    const schedule = str(c.schedule)?.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, SCHEDULE_CHARS);
    if (!id || !schedule) continue;
    out.push({ id, schedule, recurring: c.recurring === true, label: labelOf(str(c.prompt), CRON_LABEL_CHARS) ?? 'scheduled task' });
  }
  return out;
}

/**
 * A background Bash or a Monitor started (owned by the agent that ran it), a task stopped (a running subagent too), or
 * an Agent call launched a subagent (its description).
 */
function applyToolEvent(s: SessionInfo, others: BackgroundItem[], toolName: string | null, payload: Obj, agent: string, now: number): BackgroundItem[] {
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const response = isObj(payload.tool_response) ? payload.tool_response : {};
  if (toolName && STOP_TOOLS.has(toolName)) {
    const raw = str(input.task_id) ?? str(input.shell_id);
    if (!raw) return others;
    stopRun(s, `${AGENT_PREFIX}${raw.slice(0, 128)}`);
    const id = raw.slice(0, TASK_ID_CHARS);
    return others.filter((i) => i.id !== id);
  }
  if (toolName === AGENT_TOOL) {
    const agentId = str(response.agentId);
    if (agentId) describeAgent(s, `${AGENT_PREFIX}${agentId.slice(0, 128)}`, str(input.description));
    return others;
  }
  const id = toolName === 'Bash' ? taskId(response.backgroundTaskId) : toolName === 'Monitor' ? taskId(response.taskId) : null;
  if (!id) return others;
  const old = others.find((i) => i.id === id);
  const persistent = toolName === 'Monitor' && typeof response.persistent === 'boolean' ? response.persistent : old?.persistent;
  const item = taskItem(id, toolName === 'Monitor' ? 'monitor' : 'shell', str(input.description), str(input.command), old?.since ?? now, persistent);
  s.bgOwners = { ...(s.bgOwners ?? {}), [id]: agent };
  s.bgSeen = { ...(s.bgSeen ?? {}), [id]: now };
  return old ? others.map((i) => (i.id === id ? item : i)) : [...others, item];
}

/** A background task reported back to the main agent: it is over. */
function applyNotification(others: BackgroundItem[], prompt: unknown): BackgroundItem[] {
  if (typeof prompt !== 'string' || !prompt.trimStart().startsWith(TASK_NOTIFICATION)) return others;
  const id = taskId(NOTIFIED_TASK.exec(prompt)?.[1]);
  return id ? others.filter((i) => i.id !== id) : others;
}

/** Drops the background items no snapshot or event confirmed for 24 hours; the same object when none is. */
export function expireBackground(s: SessionInfo, now: number): SessionInfo {
  const others = othersOf(s);
  const seen = s.bgSeen ?? {};
  const live = others.filter((i) => now - (seen[i.id] ?? i.since) <= BACKGROUND_HYGIENE_MS);
  if (live.length === others.length) return s;
  const next = { ...s };
  settleBackground(next, live, now);
  return next;
}

/** The main agent's turn is over and a background subagent goes on: back to how the main turn ended. */
function backToRest(s: SessionInfo): void {
  s.state = s.mainRest!; s.activity = null; s.waitingFor = null;
}

export function reduceHook(prev: SessionInfo | null, payload: unknown, now: number): SessionInfo | null | undefined {
  if (!isObj(payload)) return undefined;
  const event = str(payload.hook_event_name);
  const sessionId = str(payload.session_id);
  if (!event || !sessionId || !KNOWN.has(event)) return undefined;

  if (event === 'SessionEnd') return null;
  const mode = modeOf(payload);
  // Automatic compaction mid-work: same session, nothing to reset (the compaction is over).
  if (event === 'SessionStart' && payload.source === 'compact' && prev && prev.sessionId === sessionId) {
    return { ...prev, updatedAt: now, compacting: false, permissionMode: mode ?? prev.permissionMode ?? null };
  }
  // A new session in the same terminal (or /clear) starts over.
  let s: SessionInfo = prev && prev.sessionId === sessionId && event !== 'SessionStart' ? { ...prev } : fresh(sessionId, now);
  if (prev && prev.sessionId === sessionId && event === 'SessionStart') { s.title = prev.title; s.autoTitle = prev.autoTitle ?? null; s.lastMessageAt = prev.lastMessageAt ?? null; }
  s.updatedAt = now;
  const title = str(payload.session_title);
  if (title) s.title = title;
  const cwd = str(payload.cwd);
  if (!s.cwd && cwd && isAbsPath(cwd)) s.cwd = cwd;
  s.permissionMode = mode ?? s.permissionMode ?? null;
  const toolName = str(payload.tool_name);
  const agent = agentOf(payload);
  // A running subagent's own events keep it alive (the 2-hour expiry counts from its last one), and mean it no longer
  // just waits on its own work (its SubagentStop below may say it does again).
  if (agent !== MAIN_AGENT && s.agentRuns && agent in s.agentRuns) s.agentRuns = { ...s.agentRuns, [agent]: now };
  if (agent !== MAIN_AGENT && s.agentsWaiting?.includes(agent)) s.agentsWaiting = s.agentsWaiting.filter((k) => k !== agent);
  // The main agent's tool events mean it works; a subagent's, with the main turn over, are background work.
  if (agent === MAIN_AGENT && (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure' || event === 'PermissionRequest')) s.mainRest = null;
  const subagentInBackground = agent !== MAIN_AGENT && !!s.mainRest;

  // Background work: Claude Code's snapshot at the end of a turn, the tool events and reports in between.
  const labels = new Map<string, string>();
  const listed = new Set<string>();
  let others = othersOf(s);
  const snapshot = event === 'Stop' || event === 'SubagentStop';
  const tasks = snapshot && Array.isArray(payload.background_tasks) ? payload.background_tasks : null;
  if (tasks) others = applySnapshot(s, tasks, event === 'SubagentStop' ? str(payload.agent_id) : null, now, labels, listed);
  if (snapshot && Array.isArray(payload.session_crons)) s.background = { items: s.background?.items ?? [], crons: cronsOf(payload.session_crons) };
  if (event === 'PostToolUse') others = applyToolEvent(s, others, toolName, payload, agent, now);
  if (event === 'UserPromptSubmit') others = applyNotification(others, payload.prompt);

  switch (event) {
    case 'SessionStart':
      s.state = 'idle'; s.activity = null; s.unread = false;
      s.waitingFor = null; s.compacting = false; s.agentWaits = {};
      setRuns(s, {}); s.mainRest = null;
      break;
    case 'UserPromptSubmit':
      s.lastMessageAt = now;
      s.state = 'running'; s.activity = null; s.unread = false;
      s.waitingFor = null; s.compacting = false; s.agentWaits = {}; s.mainRest = null;
      if (!s.autoTitle) s.autoTitle = promptTitle(payload.prompt);
      break;
    case 'PreToolUse':
      if (!subagentInBackground) { s.unread = false; s.compacting = false; }
      if (toolName === QUESTION_TOOL || toolName === PLAN_TOOL) {
        // Both show their dialog right away, whatever the permission mode.
        addWait(s, agent, { kind: toolName === QUESTION_TOOL ? 'question' : 'permission', activity: `waiting: ${permissionTarget(toolName, payload.tool_input)}` });
      } else if (!endWait(s, agent)) {
        // Only this agent's own wait ends: another agent's permission or question stays in front.
        if (subagentInBackground) backToRest(s);
        else {
          s.state = 'running'; s.waitingFor = null;
          if (toolName) s.activity = describeTool(toolName, payload.tool_input);
        }
      }
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (!subagentInBackground) { s.unread = false; s.compacting = false; }
      if (!endWait(s, agent)) {
        if (subagentInBackground) backToRest(s);
        else { s.state = 'running'; s.waitingFor = null; }
      }
      break;
    case 'PermissionRequest':
      s.compacting = false;
      addWait(s, agent, {
        kind: toolName === QUESTION_TOOL ? 'question' : 'permission',
        activity: `waiting: ${toolName ? permissionTarget(toolName, payload.tool_input) : 'permission'}`
      });
      break;
    case 'Notification': {
      const nt = str(payload.notification_type);
      const wait = nt ? WAITING_NOTIFICATIONS.get(nt) : undefined;
      if (wait) {
        // Arrives ~6 s after the dialog: what PermissionRequest/PreToolUse already said stays.
        if (s.state !== 'waiting') addWait(s, agent, { kind: wait === 'question' ? 'question' : 'permission', activity: 'waiting for you' });
        else s.waitingFor ??= wait;
      } else if (nt === 'idle_prompt') {
        // Never sent during a usage-limit wait: the wait ended (Esc).
        if (isLimitPaused(s)) s = endLimitPause(s, 'cancelled');
        if (s.state === 'running' || s.state === 'waiting') {
          // No Stop after an interruption with Esc (even on a permission request):
          // the idle notice only arrives with the prompt free and brings it back to ready.
          s.state = 'idle'; s.activity = null;
        }
        s.waitingFor = 'input'; s.agentWaits = {};
        if (s.state === 'idle' || s.state === 'done') s.mainRest = s.state;
        // Claude Code sends it only with no background agent: a subagent still counted (a foreground one interrupted
        // with Esc never sends its SubagentStop) is gone, unless it waits on its own work still listed. Shells,
        // monitors and crons stay.
        pruneRuns(s, others, new Set());
      } else if (nt && ANSWERED_NOTIFICATIONS.has(nt) && s.state === 'waiting' && s.waitingFor === 'question') {
        s.agentWaits = Object.fromEntries(Object.entries(s.agentWaits ?? {}).filter(([, w]) => w.kind !== 'question'));
        if (!showWaits(s)) {
          if (s.mainRest) backToRest(s);
          else { s.state = 'running'; s.activity = null; s.waitingFor = null; }
        }
      } else if (nt === QUOTA_FIRED) {
        // The task goes on, even with no pause armed (its UserPromptSubmit follows); error and pause clear below. Only
        // from an error: a late or repeated one on a session already past it changes nothing.
        if (s.state === 'error') {
          s.state = 'running'; s.activity = null;
          s.waitingFor = null; s.agentWaits = {}; s.mainRest = null;
        }
      } else if (nt === QUOTA_STALE) {
        // A rate-limit stop, ended or not (the sweep may have expired it while the computer slept): waits for Enter.
        if (s.state === 'error' && s.errorReason === 'rate_limit') s = endLimitPause(s, 'stale');
      } else if (nt === QUOTA_DISABLED) {
        if (isLimitPaused(s)) s = endLimitPause(s, 'disabled');
      }
      break;
    }
    case 'Stop':
      s.lastMessageAt = now;
      // Background subagents go on after the main turn: they stay counted until their own SubagentStop.
      s.state = 'done'; s.activity = null; s.unread = true;
      s.waitingFor = null; s.compacting = false; s.agentWaits = {}; s.mainRest = 'done';
      if (tasks) {
        // The snapshot lists every running subagent, and the work of those waiting on it: any other one will never
        // send its SubagentStop (a foreground subagent interrupted with Esc).
        pruneRuns(s, others, listed);
      }
      break;
    case 'StopFailure': {
      s.lastMessageAt = now;
      const code = str(payload.error);
      s.state = 'error'; s.activity = clip(code ?? 'error'); s.unread = true;
      s.waitingFor = null; s.compacting = false; s.agentWaits = {}; s.mainRest = null;
      s.errorReason = clip((code ?? '').replace(INVISIBLE, '').trim() || 'unknown', 64);
      // A new episode: atelierd decides afresh whether this stop is a usage-limit wait.
      delete s.limitPause;
      break;
    }
    case 'SubagentStart': {
      const key = startRun(s, agent, now);
      const label = labelOf(str(payload.agent_type));
      if (label) labels.set(key, label);
      break;
    }
    case 'SubagentStop':
      // "Finished responding" while a background task it launched still runs: it waits on its own work, and stays.
      if (!(tasks && agent !== MAIN_AGENT && others.some((i) => s.bgOwners?.[i.id] === agent))) stopRun(s, agent);
      else if (s.agentRuns && agent in s.agentRuns) s.agentsWaiting = [...(s.agentsWaiting ?? []), agent];
      break;
    case 'PreCompact':
      s.compacting = true;
      break;
    case 'PostCompact':
      s.compacting = false;
      break;
  }
  if (s.state !== 'error') s.errorReason = null;
  // A pause lives only on a rate-limit error; a session that never paused has no key at all.
  if (s.state !== 'error' || s.errorReason !== 'rate_limit') delete s.limitPause;
  settleBackground(s, others, now, labels);
  return expireBackground(expireSubagents(s, now), now);
}

function permissionTarget(toolName: string, toolInput: unknown): string {
  if (toolName === QUESTION_TOOL) return 'question';
  if (toolName === PLAN_TOOL) return 'plan approval';
  const i = isObj(toolInput) ? toolInput : {};
  const file = str(i.file_path) ?? str(i.notebook_path);
  if (file) return `${toolName} ${base(file)}`;
  const cmd = str(i.command);
  if (cmd) return `${toolName} ${clip(cmd.replace(/\s+/g, ' '), 60)}`;
  return toolName;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The status line's cost block, only if complete and sensible. */
export function costOf(v: unknown): SessionCost | null {
  if (!isObj(v)) return null;
  const usd = num(v.total_cost_usd);
  const linesAdded = count(v.total_lines_added);
  const linesRemoved = count(v.total_lines_removed);
  if (usd === null || usd < 0 || linesAdded === null || linesRemoved === null) return null;
  return { usd, linesAdded, linesRemoved };
}

/**
 * The Claude config dir (`~/.claude`, or the `CLAUDE_CONFIG_DIR` the session runs with) from its `transcript_path`,
 * `<dir>/projects/<project slug>/<session id>.jsonl`; null for anything else. Each dir is one account's limits.
 */
export function configDirOf(transcriptPath: unknown): string | null {
  // Hook data is untrusted and travels in every terminal list: nothing longer than PATH_MAX, no control characters.
  if (pathStyle() === 'win32') return win32ConfigDirOf(transcriptPath);
  if (typeof transcriptPath !== 'string' || transcriptPath.length > 4096 || !transcriptPath.startsWith('/') || !transcriptPath.endsWith('.jsonl')) return null;
  if (/[\u0000-\u001f\u007f]/.test(transcriptPath)) return null;
  const parts = transcriptPath.split('/').slice(1);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (parts.length < 4 || parts.at(-3) !== 'projects') return null;
  return '/' + parts.slice(0, -3).join('/');
}

/** configDirOf for a canonical Windows path (`C:/Users/…/.claude/projects/<slug>/<id>.jsonl`): the same rules. */
function win32ConfigDirOf(t: unknown): string | null {
  if (typeof t !== 'string' || t.length > 4096 || !/^[A-Za-z]:\//.test(t) || t.includes('\\') || !t.endsWith('.jsonl')) return null;
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  const parts = t.slice(3).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (parts.length < 4 || parts.at(-3) !== 'projects') return null;
  return t.slice(0, 3) + parts.slice(0, -3).join('/');
}

export function applyStatusLine(prev: SessionInfo | null, payload: unknown, now: number): { session: SessionInfo | null; usage: Usage | null; configDir: string | null } {
  if (!isObj(payload)) return { session: prev, usage: null, configDir: null };
  let session = prev;
  if (prev && str(payload.session_id) === prev.sessionId) {
    const cw = isObj(payload.context_window) ? payload.context_window : {};
    const pct = num(cw.used_percentage);
    const name = str(payload.session_name);
    const model = isObj(payload.model) ? str(payload.model.display_name) : null;
    // session_name is Claude's live name (custom title, else its AI title): the latest one wins.
    const next = { ...prev, contextPct: pct === null ? prev.contextPct : Math.round(pct), title: name ?? prev.title, model: model ?? prev.model ?? null, cost: costOf(payload.cost) ?? prev.cost ?? null };
    // Nothing it shows changed: the same object, so atelierd neither saves nor sends a list.
    const same = next.contextPct === prev.contextPct && next.title === prev.title && next.model === prev.model
      && JSON.stringify(next.cost) === JSON.stringify(prev.cost);
    session = same ? prev : next;
  }
  let usage: Usage | null = null;
  const rl = isObj(payload.rate_limits) ? payload.rate_limits : null;
  if (rl) {
    const win = (w: unknown) => {
      if (!isObj(w)) return null;
      const pct = num(w.used_percentage);
      const at = num(w.resets_at);
      return pct === null || at === null ? null : { pct: Math.round(pct), resetsAt: at };
    };
    const fiveHour = win(rl.five_hour);
    const sevenDay = win(rl.seven_day);
    if (fiveHour || sevenDay) usage = { fiveHour, sevenDay, updatedAt: now };
  }
  return { session, usage, configDir: configDirOf(payload.transcript_path) };
}

type Window = UsageWindow | null;

/** The 7-day window plus a day of slack. */
const MAX_WINDOW_SEC = 8 * 86400;

/**
 * Usage as far as anyone can see it: every `updatedAt` left out (it changes on every status line),
 * and `seenAt` (bookkeeping: which terminal's numbers are newer).
 */
export function usageKey(u: unknown): string {
  return JSON.stringify(u, (k, v: unknown) => (k === 'updatedAt' || k === 'seenAt' ? undefined : v)) ?? 'undefined';
}

/**
 * One terminal's limits stamped with when it last saw them move: a claude process only gets new numbers with an API
 * response, and repeats them on every status line until the next one. So the first numbers and every change are
 * seen `now`; the same numbers again keep the moment they were first seen.
 */
export function stampUsage(prev: Usage | null, next: Usage, now: number): Usage {
  const at = prev && usageKey(prev) === usageKey(next) ? null : now;
  const stamp = (w: Window, old: Window): Window => w && { pct: w.pct, resetsAt: w.resetsAt, seenAt: at ?? old?.seenAt ?? now };
  return { fiveHour: stamp(next.fiveHour, prev?.fiveHour ?? null), sevenDay: stamp(next.sevenDay, prev?.sevenDay ?? null), updatedAt: next.updatedAt };
}

/**
 * Every claude process repeats the limits from its last response: an idle session sends stale numbers.
 * For each window the numbers seen more recently win (stampUsage): a limit reset mid-window lowers the percentage and
 * may keep, or even move up, the reset time. Without both stamps, the later reset wins (new window), and on a tie the
 * higher percentage. Windows that have already expired disappear.
 */
export function mergeUsage(prev: Usage | null, next: Usage | null, nowSec: number): Usage | null {
  const pick = (a: Window, b: Window): Window => {
    // Windows last at most 7 days: one resetting later than that (plus slack) is not credible and would never expire.
    const live = (w: Window) => (w && w.resetsAt > nowSec && w.resetsAt <= nowSec + MAX_WINDOW_SEC ? w : null);
    const x = live(a); const y = live(b);
    if (!x) return y;
    if (!y) return x;
    if (x.seenAt !== undefined && y.seenAt !== undefined) return y.seenAt >= x.seenAt ? y : x;
    if (y.resetsAt !== x.resetsAt) return y.resetsAt > x.resetsAt ? y : x;
    return y.pct >= x.pct ? y : x;
  };
  const fiveHour = pick(prev?.fiveHour ?? null, next?.fiveHour ?? null);
  const sevenDay = pick(prev?.sevenDay ?? null, next?.sevenDay ?? null);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, updatedAt: next?.updatedAt ?? prev?.updatedAt ?? 0 };
}

/**
 * A resumed conversation's last message time for a session that has none of its own yet: a finite,
 * non-negative time not in the future; anything else is ignored. The session itself when there is nothing to seed.
 */
export function seedLastMessage(s: SessionInfo, at: number | undefined, now: number): SessionInfo {
  if (at === undefined || s.lastMessageAt != null || !Number.isFinite(at) || at < 0 || at > now) return s;
  return { ...s, lastMessageAt: at };
}

/** One config dir's limits (null: a session whose dir is unknown). */
export interface UsageEntry { configDir: string | null; usage: Usage }

/**
 * Limits per config dir: two accounts never mix, since a later reset only means a newer
 * window within one account. `next` is merged into its dir's entry; dirs left with no live window drop out.
 */
export function mergeUsageByDir(list: UsageEntry[], configDir: string | null, next: Usage, nowSec: number): UsageEntry[] {
  const out: UsageEntry[] = [];
  let found = false;
  for (const e of list) {
    const usage = e.configDir === configDir ? (found = true, mergeUsage(e.usage, next, nowSec)) : mergeUsage(e.usage, null, nowSec);
    if (usage) out.push({ configDir: e.configDir, usage });
  }
  if (!found) { const usage = mergeUsage(null, next, nowSec); if (usage) out.push({ configDir, usage }); }
  // Bounded (every dir travels in each message): past the cap, the stalest goes.
  while (out.length > MAX_USAGE_DIRS) {
    const stalest = out.reduce((a, e, i) => (e.usage.updatedAt < out[a]!.usage.updatedAt ? i : a), 0);
    out.splice(stalest, 1);
  }
  return out;
}

const MAX_USAGE_DIRS = 16;

/**
 * The session as atelierd sends it: without its internal bookkeeping (per-agent waits, running subagents and their
 * descriptions, background task owners and confirmation times).
 */
export function publicSession(s: SessionInfo): SessionInfo {
  const { agentWaits: _waits, agentRuns: _runs, mainRest: _rest, bgOwners: _owners, bgSeen: _seen, agentDescriptions: _descriptions, agentsWaiting: _waiting, ...rest } = s;
  return rest;
}

export function markSeen(s: SessionInfo): SessionInfo {
  return s.unread ? { ...s, unread: false } : s;
}

/** The shell is back in the foreground: claude exited (even without SessionEnd). */
export function onShellForeground(_s: SessionInfo | null): SessionInfo | null {
  return null;
}
