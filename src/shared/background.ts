/**
 * Background work of a session: matching atelierd's shells to processes, what counts as work,
 * the chip labels and a small cron parser. Pure: main's WorkHub produces the `WorkScan`s, main and the renderer
 * consume the results.
 */
import { loopFired } from './loop';
import { COMMAND_CHARS, SUBAGENT_TTL_MS, redactSecrets, type BackgroundItem, type BackgroundKind, type SessionInfo, type SessionState } from './session';

/** A shell, monitor or other task counts as work for at most this long since atelierd first saw it. */
export const WORK_CAP_MS = 30 * 60 * 1000;

export interface ProcArgs { pid: number; ppid: number; args: string }

/** What main's work scan found for one terminal at `at`. */
export interface WorkScan {
  at: number;
  /** Item id → pid of its shell. */
  matched: Record<string, number>;
  /** Item ids that are servers (a descendant listens on a non-ephemeral port). */
  servers: string[];
  /** Item ids matched by an earlier scan whose process is gone now. */
  gone: string[];
  /** Servers' listening ports (non-ephemeral), when known: the inspector's port chips. */
  ports?: Record<string, number[]>;
}

/** One row of the inspector: listed items and servers, with what the views need. */
export interface InspectorEntry {
  id: string; kind: BackgroundKind; label: string; since: number;
  /** Counts as work now (a watcher, a capped item or a server does not). */
  counted: boolean;
  server?: { ports: number[] };
  /** A watcher (`isWatcher`): lasts the whole session, never counted, never capped. */
  watcher?: true;
  owner?: string; lastEvent?: number; waiting?: boolean;
  /** The matched shell's pid. */
  pid?: number;
  /** ms when a counted shell, monitor or other task stops counting. */
  capEndsAt?: number;
  /** Shells and monitors: the command to show, redacted. */
  display?: string;
}

const DISPLAY_CHARS = 400;
/** A command as the inspector shows it: one line, no control characters, at most 400 chars, token-like runs redacted. */
export function displayCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  // Redact the whole command first: a secret straddling the display cut would leave a fragment too short to match.
  const one = redactSecrets(command.slice(0, COMMAND_CHARS).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim());
  if (!one) return undefined;
  const points = Array.from(one);
  return points.length > DISPLAY_CHARS ? `${points.slice(0, DISPLAY_CHARS - 1).join('').trimEnd()}…` : one;
}

export interface BackgroundWork {
  /** Work keeps the session "working": something counts, the setting is on and the main state is idle or done. */
  counting: boolean;
  agents: number;
  shells: number;
  monitors: number;
  other: number;
  /** Shells, monitors and other tasks past the cap: listed, not counted. */
  idle: number;
  /** ms: `since` of the oldest idle item (the chip's "Running for 2 h"); absent without idle items. */
  idleSince?: number;
  /** Servers excluded; agents first, then monitors, shells, other. */
  items: { kind: BackgroundKind; label: string; counted: boolean }[];
  crons: { id: string; label: string; schedule: string; recurring: boolean; next: number | null }[];
  /** The inspector's list: every listed item and every server, in chip order. */
  entries: InspectorEntry[];
  /**
   * ms of the next change that only time brings, for main's timer: a cap expiry (a counted item stops counting), a
   * subagent's 2-hour expiry (silent since its `lastEvent`) or a cron fire (its chip moves on to the following time).
   */
  nextChange: number | null;
}

/** The text inside `eval '…'` of a background shell's arguments (`'\''` → `'`), or null. */
export function evalCommand(args: string): string | null {
  const m = /(?:^|[\s;&|{(])eval '/.exec(args);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < args.length) {
    const c = args[i]!;
    if (c === "'") {
      if (args.startsWith("'\\''", i)) { out += "'"; i += 4; continue; }
      return out;
    }
    out += c;
    i++;
  }
  return null;
}

/**
 * Item id → pid of the shell that runs it. Exact `eval` text first, then prefix for commands clipped at 2048; equal
 * commands go in pid order to items in `since` order, and a pid is used once.
 */
export function matchShells(items: BackgroundItem[], procs: ProcArgs[]): Record<string, number> {
  const todo = items.filter((i) => i.kind !== 'agent' && i.command).sort((a, b) => a.since - b.since);
  const cands = procs.map((p) => ({ pid: p.pid, text: evalCommand(p.args) })).filter((p): p is { pid: number; text: string } => p.text !== null)
    .sort((a, b) => a.pid - b.pid);
  const used = new Set<number>();
  const out: Record<string, number> = {};
  const pass = (ok: (item: BackgroundItem, text: string) => boolean) => {
    for (const item of todo) {
      if (item.id in out) continue;
      const hit = cands.find((c) => !used.has(c.pid) && ok(item, c.text));
      if (hit) { out[item.id] = hit.pid; used.add(hit.pid); }
    }
  };
  pass((item, text) => text === item.command);
  pass((item, text) => item.command!.length === COMMAND_CHARS && text.startsWith(item.command!));
  return out;
}

/**
 * A matched shell's non-ephemeral listener must be seen continuously this long before the shell is a server: a test
 * run opens ports too (briefly, or for the whole run), a dev server keeps listening.
 */
export const SERVER_LISTEN_MS = 15_000;
const TEST_RUN = /(?<![A-Za-z0-9])(?:test|tests|e2e|vitest|jest|playwright|pytest|mocha|cypress)(?![A-Za-z0-9])/i;
/** Redirections (`2>&1`, `> /tmp/x.log`, `>| f`, `< in`) with their target. */
const REDIRECTION = /\d*[<>]{1,2}[&|]?\s*[^\s;&|]+/g;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CD = new Set(['cd', 'pushd', 'popd']);

/**
 * The words of one command that say what it runs: the program's name and its script/subcommand words (`npm run e2e`,
 * `npx playwright test`, `python -m pytest`). Leading `VAR=value` assignments and `env` (with its options) are
 * skipped, so are options and paths among the arguments; a `cd` says nothing.
 */
function programWords(segment: string): string[] {
  const words = segment.trim().replace(/^[({]\s*/, '').split(/\s+/).map((w) => w.replace(/["']/g, '')).filter(Boolean);
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]!) || words[i] === 'env' || (words[i]!.startsWith('-') && words.slice(0, i).includes('env')))) i++;
  const program = words[i];
  if (!program || CD.has(program)) return [];
  return [program.slice(program.lastIndexOf('/') + 1), ...words.slice(i + 1).filter((w) => !w.startsWith('-') && !w.includes('/'))];
}

/**
 * A command that looks like a test run (a word of a program it runs: test, e2e, vitest, jest, playwright…): never a
 * server. Only the programs and their script/subcommand words count, in every command of a chain or pipeline (a test
 * run read as a server would end the work early): a `cd ~/tests/app`, `NODE_ENV=test` or `--config tests/x` does not.
 */
export const looksLikeTestRun = (command: string): boolean =>
  command.replace(REDIRECTION, ' ').split(/&&|\|\||[;|&\n]/).some((segment) => programWords(segment).some((w) => TEST_RUN.test(w)));

/** What the work scan knows about one matched shell's listener: since when it listens, and whether it is a server. */
export interface ServerWatch { pid: number; listenSince: number | null; server: boolean; ports?: number[] }

/**
 * One scan's sighting of a matched shell (`listening`: a descendant listens on a non-ephemeral port at `at`). A server
 * once its listener has been seen continuously for SERVER_LISTEN_MS, then sticky (a dev server restarting keeps it)
 * until its process changes; a scan without the listener before that restarts the clock; a test run never is one.
 */
export function watchServer(prev: ServerWatch | undefined, pid: number, listening: boolean, command: string, at: number, ports: number[] = [], listenMs = SERVER_LISTEN_MS): ServerWatch {
  const same = prev && prev.pid === pid ? prev : undefined;
  if (same?.server) return same;
  if (!listening || looksLikeTestRun(command)) return { pid, listenSince: null, server: false };
  const listenSince = same?.listenSince ?? at;
  return { pid, listenSince, server: at - listenSince >= listenMs, ...(ports.length ? { ports } : {}) };
}

const KIND_ORDER: BackgroundKind[] = ['agent', 'monitor', 'shell', 'other'];

const ARTIFACT_WATCH = /\bartifacts?\b/i;
const WATCH_WORDS = /\b(?:watch\w*|comments?|subscri\w*|listen\w*)\b/i;

/**
 * A watcher, not work: it lasts the whole session by design, so it would keep it "working" for nothing. A persistent
 * Monitor; a monitor with no command (no shell: a watch Claude Code runs itself, e.g. MCP or a published artifact's
 * comments); a task with no command that watches an artifact ("Watching artifact…", "Artifact comments"; "Build
 * release artifacts" is work).
 */
export const isWatcher = (it: BackgroundItem): boolean =>
  it.kind !== 'agent' && (it.persistent === true
    || (!it.command && (it.kind === 'monitor' || (ARTIFACT_WATCH.test(it.label) && WATCH_WORDS.test(it.label)))));

/**
 * What a session's background work is right now, from atelierd's items and main's latest scan. Agents count until 2
 * hours after their `lastEvent`; one `waiting` on its own work counts only while some item it owns counts.
 */
export function backgroundWork(s: SessionInfo, scan: WorkScan | null, now: number, opts: { countAsWork: boolean }): BackgroundWork {
  const items = s.background?.items ?? [];
  const servers = new Set(scan?.servers ?? []);
  const gone = new Set(scan?.gone ?? []);
  const entries: InspectorEntry[] = [];
  const base = (it: BackgroundItem): InspectorEntry => {
    const pid = scan?.matched[it.id];
    const display = it.kind === 'agent' ? undefined : displayCommand(it.command);
    return {
      id: it.id, kind: it.kind, label: it.label, since: it.since, counted: false,
      ...(it.owner ? { owner: it.owner } : {}), ...(pid !== undefined ? { pid } : {}), ...(display ? { display } : {})
    };
  };
  const listed: { kind: BackgroundKind; label: string; counted: boolean }[] = [];
  let agents = 0, shells = 0, monitors = 0, other = 0, idle = 0;
  let nextChange: number | null = null;
  let idleSince: number | null = null;
  const soonest = (t: number) => { if (nextChange === null || t < nextChange) nextChange = t; };
  /** Agents whose own shell, monitor or task counts (a waiting agent counts only through them). */
  const busyOwners = new Set<string>();
  for (const it of items) {
    if (it.kind === 'agent') continue;
    if (scan && scan.at > it.since && servers.has(it.id)) {
      entries.push({ ...base(it), server: { ports: scan.ports?.[it.id] ?? [] } });
      continue;
    }
    if (gone.has(it.id)) continue;
    if (isWatcher(it)) { listed.push({ kind: it.kind, label: it.label, counted: false }); entries.push({ ...base(it), watcher: true }); continue; }
    const expiry = it.since + WORK_CAP_MS + 1;
    const counted = now < expiry;
    listed.push({ kind: it.kind, label: it.label, counted });
    entries.push({ ...base(it), counted, ...(counted ? { capEndsAt: it.since + WORK_CAP_MS } : {}) });
    if (!counted) {
      idle++;
      if (idleSince === null || it.since < idleSince) idleSince = it.since;
      continue;
    }
    if (it.owner) busyOwners.add(it.owner);
    if (it.kind === 'shell') shells++;
    else if (it.kind === 'monitor') monitors++;
    else other++;
    soonest(expiry);
  }
  const agentItems = items.filter((it) => it.kind === 'agent');
  for (const it of agentItems) {
    // Silent for 2 hours: taken as gone (atelierd drops it at its next sweep), a change only time brings.
    if (it.lastEvent !== undefined) {
      const expiry = it.lastEvent + SUBAGENT_TTL_MS + 1;
      if (now >= expiry) continue;
      soonest(expiry);
    }
    // Kept after its SubagentStop only by its own work: work while some of that work counts (not a server, not
    // over, not past the cap).
    if (it.waiting && !busyOwners.has(it.id)) continue;
    agents++;
    listed.push({ kind: 'agent', label: it.label, counted: true });
    entries.push({ ...base(it), counted: true, ...(it.lastEvent !== undefined ? { lastEvent: it.lastEvent } : {}), ...(it.waiting ? { waiting: true } : {}) });
  }
  // Subagents the count knows beyond the agent items (a lost event) still are work.
  for (let n = agentItems.length; n < (s.subagents ?? 0); n++, agents++) {
    listed.push({ kind: 'agent', label: 'Subagent', counted: true });
    entries.push({ id: `subagent-${n + 1}`, kind: 'agent', label: 'Subagent', since: s.updatedAt ?? now, counted: true });
  }
  const sorted = KIND_ORDER.flatMap((k) => listed.filter((i) => i.kind === k));
  const sortedEntries = KIND_ORDER.flatMap((k) => entries.filter((e) => e.kind === k));
  const counts = agents + shells + monitors + other > 0;
  const crons = (s.background?.crons ?? []).map((c) => {
    const next = cronNext(c.schedule, new Date(now))?.getTime() ?? null;
    // A self-paced loop's wake-up that fired: its next match is tomorrow's, which nothing will run.
    return { id: c.id, label: c.label, schedule: c.schedule, recurring: c.recurring, next: loopFired({ ...c, next }, now) ? null : next };
  });
  for (const c of crons) if (c.next !== null && (nextChange === null || c.next < nextChange)) nextChange = c.next;
  return {
    counting: opts.countAsWork && counts && (s.state === 'idle' || s.state === 'done'),
    agents, shells, monitors, other, idle,
    ...(idleSince !== null ? { idleSince } : {}),
    items: sorted,
    crons,
    entries: sortedEntries,
    nextChange
  };
}

const NOUN: Record<BackgroundKind, [string, string]> = { agent: ['agent', 'agents'], shell: ['shell', 'shells'], monitor: ['monitor', 'monitors'], other: ['task', 'tasks'] };
/**
 * Per-kind counts of what the chip shows, in chip order (agents, shells, monitors, tasks): the counted items, or, when
 * only capped ones remain, those.
 */
export function workCounts(w: BackgroundWork): [BackgroundKind, number][] {
  const base = w.items.filter((i) => i.counted);
  const list = base.length > 0 ? base : w.items;
  const order: BackgroundKind[] = ['agent', 'shell', 'monitor', 'other'];
  return order.map((k): [BackgroundKind, number] => [k, list.filter((i) => i.kind === k).length]).filter(([, n]) => n > 0);
}

/** "1 agent · 2 shells · 1 monitor · 1 task"; null when nothing is listed. */
export function workSummary(w: BackgroundWork): string | null {
  const parts = workCounts(w).map(([k, n]) => `${n} ${NOUN[k][n === 1 ? 0 : 1]}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Everything listed, counted or not. */
export const workTotal = (w: BackgroundWork): number => w.items.length;

/** The state the app shows: "running" while background work counts (only over idle or done), else the main state (null without a session). */
export function effectiveState(t: { session: SessionInfo | null; work?: BackgroundWork }): SessionState | null {
  if (!t.session) return null;
  const { state } = t.session;
  return t.work?.counting && (state === 'idle' || state === 'done') ? 'running' : state;
}

// ---- cron (5 fields, local time) ----

interface CronField { any: boolean; set: Set<number> }
const FIELD_RANGE: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(text: string, [lo, hi]: [number, number]): CronField | null {
  const set = new Set<number>();
  const int = (t: string) => (/^\d+$/.test(t) ? Number(t) : NaN);
  for (const part of text.split(',')) {
    const [range, step, extra] = part.split('/');
    if (extra !== undefined || range === undefined || range === '') return null;
    const n = step === undefined ? 1 : int(step);
    if (!(n >= 1)) return null;
    let a: number, b: number;
    if (range === '*') { a = lo; b = hi; }
    else if (range.includes('-')) {
      const [x, y, z] = range.split('-');
      if (z !== undefined) return null;
      a = int(x!); b = int(y ?? '');
    } else { a = int(range); b = step === undefined ? a : hi; }
    if (!(a >= lo && b <= hi && a <= b)) return null;
    for (let v = a; v <= b; v += n) set.add(v);
  }
  return { any: text.startsWith('*'), set };
}

/** The first matching minute strictly after `from` (local time, seconds zeroed), within 366 days; null if unparsable or never. */
export function cronNext(schedule: string, from: Date): Date | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const f = parts.map((p, i) => parseField(p, FIELD_RANGE[i]!));
  if (f.some((x) => x === null)) return null;
  const [min, hour, dom, mon, dow] = f as CronField[];
  const days = new Set([...dow!.set].map((d) => d % 7));
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1, 0, 0);
  for (let d = 0; d <= 366; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    if (!mon!.set.has(day.getMonth() + 1)) continue;
    const domOk = dom!.set.has(day.getDate());
    const dowOk = days.has(day.getDay());
    if (!(dom!.any || dow!.any ? domOk && dowOk : domOk || dowOk)) continue;
    for (let h = d === 0 ? start.getHours() : 0; h < 24; h++) {
      if (!hour!.set.has(h)) continue;
      for (let m = d === 0 && h === start.getHours() ? start.getMinutes() : 0; m < 60; m++) {
        if (!min!.set.has(m)) continue;
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        if (t.getTime() > from.getTime()) return t;
      }
    }
  }
  return null;
}
