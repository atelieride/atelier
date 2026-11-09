import type { RepoStatus } from './git';
import { isAbsPath, isBelow, trimOneSep } from './paths';
import { pathStyle } from './platform';

/**
 * Who touched a file. From atelierd: an Edit/Write hook (no `via`). From the app: a file that changed during a tool
 * call of that session alone — `via: 'bash'` (a Bash call) or `'tool'` (another tool, named in `tool`) — or during
 * calls of several sessions: one entry per candidate, each with `unclear` (all the candidates' terminal ids, sorted).
 * `maybe`: the only candidate was a background command (a dev server, a watcher), so the change may as well have been
 * made outside Claude; never together with `unclear`.
 * App-side entries from tool calls also say when the file changed (`changedAt`, its mtime when known) and what the call
 * was (`command`, `callStart`, `callEnd`: no end while it still ran); `resolved`: the user said it was this session
 *, never together with `unclear` or `maybe`.
 */
export interface Attribution {
  path: string; terminalId: string; sessionId: string; color: string; title: string; at: number;
  via?: 'bash' | 'tool'; tool?: string; unclear?: string[]; maybe?: true;
  changedAt?: number; command?: string; callStart?: number; callEnd?: number; resolved?: true;
  /** The folder Claude ran the call from (a hint for "Why unsure", never used to decide). */
  cwd?: string;
}

/** An entry that names a session only as one of several candidates, or as a background command's maybe. */
export const isUnsure = (a: { unclear?: unknown; maybe?: unknown }): boolean => !!a.unclear || !!a.maybe;

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Normalizes an absolute path without touching the disk (no /./, ../, double slashes). Windows: a canonical drive path
 * (`C:/…`, either separator read), the drive letter upper case.
 */
function normalize(p: string): string {
  if (pathStyle() === 'win32') {
    const out: string[] = [];
    for (const part of p.slice(3).split(/[\\/]/)) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return `${p[0]!.toUpperCase()}:/${out.join('/')}`;
  }
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

/** Only successful edits by tools that write files: writes via Bash cannot be attributed. */
export function attributionFromHook(payload: unknown, term: { id: string; color: string; title: string }, now: number): Attribution | null {
  if (!isObj(payload) || payload.hook_event_name !== 'PostToolUse') return null;
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !EDIT_TOOLS.has(tool)) return null;
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const raw = tool === 'NotebookEdit' ? input.notebook_path : input.file_path;
  if (typeof raw !== 'string' || !isAbsPath(raw)) return null;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  return { path: normalize(raw), terminalId: term.id, sessionId, color: term.color, title: term.title, at: now };
}

export function addAttribution(list: Attribution[], a: Attribution): Attribution[] {
  return [...list.filter((x) => !(x.path === a.path && x.terminalId === a.terminalId)), a];
}

/**
 * Removes the attributions of files that became clean in the repo `root`.
 * - exclude: nested repos, whose status does not appear in that of `root`;
 * - before: start of the status read; a more recent attribution may concern a file the status has not seen.
 */
export function pruneAttributions(list: Attribution[], root: string, dirty: ReadonlySet<string>, opts: { exclude?: string[]; before?: number } = {}): Attribution[] {
  const under = (p: string, r: string) => isBelow(trimOneSep(r), p);
  // Windows: one file in any case (Claude may name it c:/dev/…, the status C:/Dev/…).
  const folded = pathStyle() === 'win32' ? new Set([...dirty].map((d) => d.toLowerCase())) : null;
  const isDirty = (p: string) => (folded ? folded.has(p.toLowerCase()) : dirty.has(p));
  return list.filter((x) =>
    !under(x.path, root) || isDirty(x.path) ||
    (opts.exclude ?? []).some((e) => under(x.path, e)) ||
    (opts.before !== undefined && x.at >= opts.before));
}

/**
 * Whether a status may prune the repo's attributions: only when HEAD moved since the previous status (`prevOid`,
 * undefined if none was seen yet), i.e. after a commit or a checkout. A clean state with the same HEAD (stash,
 * stash pop, reset) is often brief and must not wipe them. Never on an incomplete status (error, truncated list).
 */
export function shouldPrune(prevOid: string | null | undefined, st: RepoStatus): boolean {
  if (st.error || st.truncated > 0 || prevOid === undefined) return false;
  return st.oid !== prevOid;
}
