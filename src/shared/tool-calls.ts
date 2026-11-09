import { EDIT_TOOLS } from './attribution';
import { MAIN_AGENT, agentOf, taskId, type SessionInfo } from './session';
import { isWaiting } from './session-view';
import { isAbsPath } from './paths';

/**
 * Tool calls that may write files, with their exact times. atelierd builds them from the
 * hooks — a PreToolUse is handled before Claude Code runs the tool, a PostToolUse after it returns — and the app
 * decides with them which session changed a file. Edit/Write & co. are not here: their own hook names the file.
 */
export interface ToolCallWindow {
  /** tool_use_id (≤ 128 chars), or a local `anon:` id when the hook had none. */
  id: string;
  terminalId: string;
  sessionId: string;
  /** 'main' or `agent:<agent_id>` (the session reducer's agent keys). */
  agent: string;
  tool: string;
  /** Bash and Monitor only, at most 2048 chars: absent when longer (then never read-only). */
  command?: string;
  /**
   * The folder Claude ran the call from (the hook's `cwd`, absolute, at most 4096 chars, no control characters). Shown in
   * "Why unsure" as a hint, never used to decide: a command can `cd` elsewhere or write by absolute path.
   */
  cwd?: string;
  start: number;
  end: number | null;
  /** A background Bash or a Monitor: once launched, open until its shell (`taskId`) ends. */
  background?: true;
  taskId?: string;
}

/** Tools that never write files. Anything else — MCP tools, tools we do not know yet — may. */
export const NON_WRITING_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TaskOutput', 'TaskStop', 'KillShell', 'KillBash', 'BashOutput', 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode',
  'ExitPlanMode', 'Skill', 'SendMessage', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Agent', 'Task'
]);
/**
 * A foreground call nothing closed is closed this long after it started, unless its session waits for a permission
 * answer: PreToolUse fires before the dialog and the command runs only once the user answers, maybe much later; a
 * long BASH_MAX_TIMEOUT_MS too. Closing a running call early can give a wrong name, keeping a lost one open only
 * adds unclear.
 */
export const CALL_CAP_MS = 2 * 60 * 60_000;
/** Closed calls are kept this long. */
export const CALL_KEEP_MS = 10 * 60_000;
export const MAX_CALLS = 1000;
const ID_CHARS = 128;
const COMMAND_CHARS = 2048;
const CWD_CHARS = 4096;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const isOpen = (c: ToolCallWindow) => c.end === null;

function closeWhere(list: ToolCallWindow[], pred: (c: ToolCallWindow) => boolean, now: number): ToolCallWindow[] {
  if (!list.some(pred)) return list;
  return list.map((c) => (pred(c) ? { ...c, end: now } : c));
}

export function applyToolCallHook(list: ToolCallWindow[], terminalId: string, payload: unknown, now: number): ToolCallWindow[] {
  if (!isObj(payload)) return list;
  const event = str(payload.hook_event_name);
  const sessionId = str(payload.session_id)?.slice(0, ID_CHARS) ?? null;
  if (!event || !sessionId) return list;
  const agent = agentOf(payload);
  const tool = str(payload.tool_name)?.slice(0, ID_CHARS) ?? null;
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const response = isObj(payload.tool_response) ? payload.tool_response : {};
  const rawId = str(payload.tool_use_id)?.slice(0, ID_CHARS) ?? null;
  const mine = (c: ToolCallWindow) => c.terminalId === terminalId && isOpen(c);
  // The calls an end of turn closes: the agent's own, not a launched background shell (its shell decides).
  const turnOf = (who: string) => (c: ToolCallWindow) => mine(c) && c.agent === who && !c.taskId;
  switch (event) {
    case 'PreToolUse': {
      if (!tool || EDIT_TOOLS.has(tool) || NON_WRITING_TOOLS.has(tool)) return list;
      let id = rawId;
      if (!id) {
        // Local id, unique even for two calls in one millisecond (deterministic: a counter while the base is taken).
        const base = `anon:${agent}:${tool}:${now}`;
        id = base;
        for (let n = 2; list.some((c) => c.terminalId === terminalId && c.id === id); n++) id = `${base}#${n}`;
      }
      if (list.some((c) => c.terminalId === terminalId && c.id === id)) return list;
      const call: ToolCallWindow = { id, terminalId, sessionId, agent, tool, start: now, end: null };
      const command = tool === 'Bash' || tool === 'Monitor' ? str(input.command) : null;
      if (command && command.length <= COMMAND_CHARS) call.command = command;
      const cwd = str(payload.cwd);
      if (cwd && isAbsPath(cwd) && cwd.length <= CWD_CHARS && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(cwd)) call.cwd = cwd;
      if ((tool === 'Bash' && input.run_in_background === true) || tool === 'Monitor') call.background = true;
      return [...list, call];
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const target = rawId
        ? list.find((c) => mine(c) && c.id === rawId)
        : list.find((c) => mine(c) && c.agent === agent && c.tool === tool && c.id.startsWith('anon:'));
      if (!target || target.taskId) return list;
      const shell = event === 'PostToolUse' && target.background ? taskId(target.tool === 'Monitor' ? response.taskId : response.backgroundTaskId) : null;
      return list.map((c) => (c !== target ? c : shell ? { ...c, taskId: shell } : { ...c, end: now }));
    }
    case 'SubagentStop':
      // Without agent_id we cannot tell whose turn ended: not the main agent's.
      return agent === MAIN_AGENT ? list : closeWhere(list, turnOf(agent), now);
    // Not UserPromptSubmit: a prompt queued while a call runs must not end it.
    case 'Stop':
    case 'StopFailure':
      return closeWhere(list, turnOf(MAIN_AGENT), now);
    case 'Notification':
      return str(payload.notification_type) === 'idle_prompt' ? closeWhere(list, turnOf(MAIN_AGENT), now) : list;
    case 'SessionStart':
      return payload.source === 'compact' ? list : closeWhere(list, mine, now);
    case 'SessionEnd':
      return closeWhere(list, mine, now);
    default:
      return list;
  }
}

/** After a terminal list change: closes the calls of terminals or sessions gone, and of background shells over. */
export function syncToolCalls(list: ToolCallWindow[], terminals: { id: string; session: SessionInfo | null }[], now: number): ToolCallWindow[] {
  const byId = new Map(terminals.map((t) => [t.id, t.session]));
  return closeWhere(list, (c) => {
    if (!isOpen(c)) return false;
    if (!byId.has(c.terminalId)) return true;
    const s = byId.get(c.terminalId) ?? null;
    if (!s || s.sessionId.slice(0, ID_CHARS) !== c.sessionId) return true;
    return !!c.taskId && !(s.background?.items ?? []).some((i) => i.id === c.taskId);
  }, now);
}

/**
 * The calls the cap must spare: those of a terminal whose session (the same one) waits for you — a permission, or an
 * answer (an MCP elicitation comes in the middle of its tool call). The session-level state, for every agent of the
 * session: erring open is safe.
 */
export function waitingForAnswer(terminals: { id: string; session: SessionInfo | null }[]): (c: ToolCallWindow) => boolean {
  const asking = new Map<string, string>();
  for (const t of terminals) if (t.session && isWaiting(t.session)) asking.set(t.id, t.session.sessionId.slice(0, ID_CHARS));
  return (c) => asking.get(c.terminalId) === c.sessionId;
}

/**
 * The cap on foreground calls (not those `spare` keeps open), then the 10 minutes and the bound on closed calls (the
 * oldest closed go first).
 */
export function pruneToolCalls(
  list: ToolCallWindow[], now: number, cap = CALL_CAP_MS, keep = CALL_KEEP_MS, max = MAX_CALLS, spare: (c: ToolCallWindow) => boolean = () => false
): ToolCallWindow[] {
  let out = closeWhere(list, (c) => isOpen(c) && !c.taskId && c.start < now - cap && !spare(c), now);
  const kept = out.filter((c) => c.end === null || c.end >= now - keep);
  if (kept.length !== out.length) out = kept;
  if (out.length <= max) return out;
  const closed = out.filter((c) => c.end !== null).sort((a, b) => a.end! - b.end!);
  if (closed.length === 0) return out;
  const drop = new Set(closed.slice(0, out.length - max));
  return out.filter((c) => !drop.has(c));
}

/**
 * The full list as it may be sent in one line of at most `maxChars`: over it, folders go (a hint), then commands, each
 * from the windows that ended first, then from the open ones (oldest first), until it fits. A window without its command is a writer; the closed
 * ones in a full list barely matter anyway (the app's first status after a connect is a baseline), and an open one
 * gets its command back with its closure.
 */
export function fitCalls(list: ToolCallWindow[], maxChars: number): ToolCallWindow[] {
  const size = (c: ToolCallWindow) => JSON.stringify(c).length + 1;
  let total = 1 + list.reduce((n, c) => n + size(c), 0);
  if (total <= maxChars) return list;
  const byAge = (x: number, y: number) => {
    const a = list[x]!, b = list[y]!;
    if ((a.end === null) !== (b.end === null)) return a.end === null ? 1 : -1;
    return a.end !== null && b.end !== null ? a.end - b.end : a.start - b.start;
  };
  const out = [...list];
  // Folders first (a hint), then commands (whose loss makes a window a writer); each pass oldest first.
  for (const key of ['cwd', 'command'] as const) {
    const order = list.map((_, i) => i).filter((i) => list[i]![key] !== undefined).sort(byAge);
    for (const i of order) {
      if (total <= maxChars) return out;
      const { [key]: _gone, ...bare } = out[i]!;
      total -= size(out[i]!) - size(bare);
      out[i] = bare;
    }
  }
  return out;
}

/** The windows of `next` that are new or replaced since `prev` (windows are never mutated, only replaced). */
export function changedCalls(prev: ToolCallWindow[], next: ToolCallWindow[]): ToolCallWindow[] {
  const old = new Set(prev);
  return next.filter((c) => !old.has(c));
}

/** Merges changed windows into a list, by terminal and id. */
export function upsertCalls(list: ToolCallWindow[], changes: ToolCallWindow[]): ToolCallWindow[] {
  const key = (c: ToolCallWindow) => `${c.terminalId}\u0000${c.id}`;
  const byKey = new Map(changes.map((c) => [key(c), c]));
  const out = list.map((c) => byKey.get(key(c)) ?? c);
  const known = new Set(list.map(key));
  const added = [...byKey.values()].filter((c) => !known.has(key(c)));
  return [...out, ...added];
}
