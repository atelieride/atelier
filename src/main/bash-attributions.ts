import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { cleanLine } from '@shared/clean-text';
import { redactSecrets } from '@shared/session';
import { lstat } from 'node:fs/promises';
import { dirname, toOut } from './cpath';
import { isUnsure, pruneAttributions, type Attribution } from '@shared/attribution';
import {
  BASH_KEEP_MS, BASH_SLACK_MS, MAX_BASH_ATTRIBUTIONS, addBashAttributions, bashBetween, bashCulprit, changedFiles, relatedRoots, trackBashWindows,
  type BashWindow, type FileState
} from '@shared/bash-attribution';
import { CALL_SLACK_MS, callCulprit, changeTime, writingCallBetween } from '@shared/command-attribution';
import type { RepoStatus } from '@shared/git';
import type { TerminalInfo } from '@shared/protocol';
import { CALL_KEEP_MS, MAX_CALLS, pruneToolCalls, upsertCalls, type ToolCallWindow } from '@shared/tool-calls';
import { ensureDir, writeFileAtomic } from '../daemon/fsutil';
import type { StatusPrune } from './git-hub';
import { isAbsPath } from '@shared/paths';

/** Above this many dirty files a status is not examined (and the next one is a new baseline): stat stays bounded. */
const MAX_STAT_FILES = 2000;
/** The saved file stays under this size (the oldest attributions go first). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A file bigger than this is not ours to read (2000 entries of the largest valid size fit well below). */
const MAX_LOAD_BYTES = 16 * 1024 * 1024;
/** More candidates than this for one change: it is attributed to nobody. */
const MAX_CANDIDATES = 16;

/** The newest attributions whose JSON fits in MAX_FILE_BYTES, in their order. */
function boundBytes(list: Attribution[]): Attribution[] {
  const sizes = list.map((a) => Buffer.byteLength(JSON.stringify(a)) + 1);
  let total = 64 + sizes.reduce((s, n) => s + n, 0);
  if (total <= MAX_FILE_BYTES) return list;
  const byAge = list.map((a, i) => i).sort((x, y) => list[x]!.at - list[y]!.at);
  const drop = new Set<number>();
  for (const i of byAge) {
    if (total <= MAX_FILE_BYTES) break;
    drop.add(i);
    total -= sizes[i]!;
  }
  return list.filter((_, i) => !drop.has(i));
}

interface Options {
  now?: () => number;
  /** A file's mtime (ms), null when it does not exist. */
  stat?: (path: string) => Promise<number | null>;
  realpath?: (path: string) => string;
}

const statMtime = async (p: string): Promise<number | null> => {
  try { return (await lstat(p)).mtimeMs; } catch { return null; }
};
const safeRealpath = (p: string): string => {
  try { return toOut(realpathSync(p)); } catch { return p; }
};

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
function validEntry(v: unknown): Attribution | null {
  const o = v as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null) return null;
  if (!isStr(o.path, 4096) || !isAbsPath(o.path) || !isStr(o.terminalId, 64) || typeof o.sessionId !== 'string' || o.sessionId.length > 200) return null;
  if (!isStr(o.color, 64) || typeof o.title !== 'string' || o.title.length > 400 || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  const out: Attribution = { path: o.path, terminalId: o.terminalId, sessionId: o.sessionId, color: o.color, title: o.title, at: o.at, via: o.via === 'tool' ? 'tool' : 'bash' };
  if (out.via === 'tool' && isStr(o.tool, 128)) out.tool = o.tool;
  const u = o.unclear;
  if (u !== undefined) {
    // An invalid `unclear` must not turn a guess into an exact attribution: the entry is dropped.
    if (!Array.isArray(u) || u.length < 2 || u.length > MAX_CANDIDATES || !u.every((x) => isStr(x, 64))) return null;
    out.unclear = u as string[];
  }
  if (o.maybe !== undefined) {
    // The same: a maybe that isn't one, or one also unclear, is not trusted as anything.
    if (o.maybe !== true || out.unclear) return null;
    out.maybe = true;
  }
  if (o.resolved !== undefined) {
    // The user's word on an unsure file: only on an entry that names one session for sure.
    if (o.resolved !== true || out.unclear || out.maybe) return null;
    out.resolved = true;
  }
  // Details for "Why unsure": an invalid one is only left out.
  const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (time(o.changedAt)) out.changedAt = o.changedAt;
  if (isStr(o.command, MAX_COMMAND)) out.command = o.command;
  if (time(o.callStart)) out.callStart = o.callStart;
  if (time(o.callEnd)) out.callEnd = o.callEnd;
  if (typeof o.cwd === 'string' && cleanCwd(o.cwd)) out.cwd = o.cwd;
  return out;
}

/** The longest command atelierd keeps in a tool-call window. */
const MAX_COMMAND = 2048;
/** A command as it is kept and shown in "Why unsure": one line, no invisible or control characters, secrets redacted. */
const shownCommand = (command: string): string => redactSecrets(cleanLine(command)).slice(0, MAX_COMMAND);
/** A folder fit to show: absolute, bounded, no control, invisible (bidi, zero-width) or line-separator characters. */
const cleanCwd = (cwd: string): boolean => isAbsPath(cwd) && cwd.length <= 4096 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(cwd);
/** Undo records of resolutions kept (in memory). */
const MAX_UNDO = 20;

/**
 * The app-side "via Bash" attributions: Bash windows from the terminal list, or atelierd's tool-call
 * windows (capability 'toolcalls'), and file changes from each git status, kept in memory
 * and in `file` (ATELIER_HOME, 0600, atomic, bounded). The decisions are made here; atelierd only supplies the windows.
 */
export class BashAttributions {
  private windows: BashWindow[] = [];
  /** atelierd's tool-call windows (capability 'toolcalls'); null with an older atelierd: the Bash-window heuristic. */
  private calls: ToolCallWindow[] | null = null;
  /** The full list has not arrived since (re)connecting: terminals are kept, statuses are only baselines. */
  private pendingFull = false;
  /** Counts the connection changes (and mode switches): a status in flight across one decides nothing, writes nothing. */
  private epoch = 0;
  /**
   * Calls lost to count pruning (MAX_CALLS) that had not expired by time: the latest `end` among them. A status whose
   * interval starts before it is a baseline, since the writer's call may be gone while another one still matches.
   */
  private lostThrough = -Infinity;
  private terminals: TerminalInfo[] = [];
  /** Terminals by id: the live ones and the closed ones that still have Bash or tool-call windows. */
  private known = new Map<string, TerminalInfo>();
  private items: Attribution[] = [];
  private daemonPaths = new Set<string>();
  /** Files saved from Atelier's editor (real path → time): the user's changes, never a session's. */
  private appWrites = new Map<string, number>();
  /** Per repo: the last complete status's start and the mtimes of its dirty files (`unknown`: not read, nobody in Bash or a tool call then). */
  private snapshots = new Map<string, { at: number; files: Map<string, number | null>; unknown: boolean }>();
  private queues = new Map<string, Promise<void>>();
  private realRoots = new Map<string, string>();
  /** Recent resolutions by token: what they removed and added, for Undo. */
  private undos = new Map<string, { removed: Attribution[]; added: Attribution[]; after: Attribution[]; scope: string }>();
  private readonly now: () => number;
  private readonly stat: (path: string) => Promise<number | null>;
  private readonly realpath: (path: string) => string;
  /** Called when the list changes (the windows get the merged attributions again). */
  onChange: () => void = () => {};
  /** Called when a full tool-call list ends the wait after (re)connecting: the app should read every repo's status, the baseline. */
  onBaselineNeeded: () => void = () => {};

  constructor(private readonly file: string | null, opts: Options = {}) {
    this.now = opts.now ?? Date.now;
    this.stat = opts.stat ?? statMtime;
    this.realpath = opts.realpath ?? safeRealpath;
    if (file) this.items = this.load(file);
  }

  list(): Attribution[] { return this.items; }

  setTerminals(list: TerminalInfo[]): void {
    this.terminals = list;
    this.windows = trackBashWindows(this.windows, list, this.now());
    for (const t of list) this.known.set(t.id, t);
    this.forgetTerminals();
  }

  /** The whole list (`full`, on connect) or the windows that changed; null: an older atelierd. */
  setToolCalls(list: ToolCallWindow[] | null, full = true): void {
    if (list === null) {
      if (this.calls) this.epoch++;
      this.calls = null;
    } else {
      const merged = full || !this.calls ? list : upsertCalls(this.calls, list);
      // atelierd may have count-pruned a full list already: its oldest closed call marks what may be missing.
      if (full && merged.length >= MAX_CALLS) {
        // No closed call to tell how far back it reaches: everything up to now may be missing.
        const ends = merged.filter((c) => c.end !== null).map((c) => c.end!);
        this.lostThrough = Math.max(this.lostThrough, ends.length > 0 ? Math.min(...ends) : this.now());
      }
      this.calls = this.prune(merged);
    }
    const wasPending = this.pendingFull;
    if (list === null || full) this.pendingFull = false;
    this.forgetTerminals();
    // Without it the status the first change triggers would itself be the baseline, and that change never attributed.
    if (wasPending && list !== null && full) this.onBaselineNeeded();
  }

  /**
   * The connection to atelierd changed: `connected` with the capability starts exact mode, whose full list follows the
   * welcome; any other state makes what we hold stale. Until the full list arrives no terminal is forgotten (a closed
   * terminal's calls are still to come) and statuses are only baselines, so no change is named from stale windows.
   */
  awaitToolCalls(connected: boolean): void {
    if (connected) this.calls ??= [];
    if (this.calls) {
      this.epoch++;
      this.pendingFull = true;
      // The first status after a reconnect is always a baseline: atelierd may have restarted, its old windows are gone.
      this.snapshots.clear();
    }
  }

  /**
   * Prunes the windows, remembering the end of those lost to the count cap rather than to their age. Open calls are
   * never capped here: only atelierd knows whether a session waits for a permission answer, and it sends the closure.
   */
  private prune(list: ToolCallWindow[]): ToolCallWindow[] {
    const now = this.now();
    const out = pruneToolCalls(list, now, Number.POSITIVE_INFINITY);
    if (out.length < list.length) {
      const key = (c: ToolCallWindow) => `${c.terminalId}\u0000${c.id}`;
      const kept = new Set(out.map(key));
      for (const c of list) if (!kept.has(key(c)) && c.end !== null && c.end >= now - CALL_KEEP_MS) this.lostThrough = Math.max(this.lostThrough, c.end);
    }
    return out;
  }

  /**
   * A closed terminal is remembered while it has Bash or tool-call windows: it still counts (and can be the culprit)
   * until they age out, so a change it made is never given to another session.
   */
  private forgetTerminals(): void {
    if (this.pendingFull) return;
    const live = new Set([...this.terminals.map((t) => t.id), ...this.windows.map((w) => w.terminalId), ...(this.calls ?? []).map((c) => c.terminalId)]);
    for (const id of this.known.keys()) if (!live.has(id)) this.known.delete(id);
  }

  setDaemonAttributions(list: Attribution[]): void {
    this.daemonPaths = new Set(list.map((a) => a.path));
  }

  noteAppWrite(path: string): void {
    const now = this.now();
    this.appWrites.set(this.realpath(path), now);
    for (const [p, t] of this.appWrites) if (t < now - BASH_KEEP_MS) this.appWrites.delete(p);
  }

  /**
   * A new status of a repo: prunes like the daemon does (when told to), then attributes what changed during Bash or tool
   * calls. `keep`: files an Atelier op holds, pruned as if still dirty.
   */
  status(st: RepoStatus, o: StatusPrune): Promise<void> {
    // One status at a time per repo: each compares with the previous one.
    const run = (this.queues.get(st.root) ?? Promise.resolve()).then(() => this.examine(st, o)).catch(() => {});
    this.queues.set(st.root, run);
    return run;
  }

  private async examine(st: RepoStatus, o: StatusPrune): Promise<void> {
    // What this status adds; applied to the list as it is after the stats (the user may resolve meanwhile).
    let adds: Attribution[] = [];
    // Pruned at the start (not at `to`): a call that ends in between is kept, never dropped early. More conservative.
    if (this.calls) this.calls = this.prune(this.calls);
    const paths = [...new Set(st.changes.map((c) => c.path))];
    // Exact mode: a baseline too when the windows cannot cover the interval: stale, older than their retention, or
    // pruned by count. The culprit lookup reaches back BASH_SLACK_MS + CALL_SLACK_MS before the previous status.
    const old = this.snapshots.get(st.root);
    const epoch = this.epoch;
    const exact = this.calls !== null;
    const reach = old ? old.at - BASH_SLACK_MS - CALL_SLACK_MS : 0;
    const prev = exact && (this.pendingFull || (old && (reach < this.now() - CALL_KEEP_MS || reach <= this.lostThrough))) ? undefined : old;
    if (st.error || st.truncated > 0 || paths.length > MAX_STAT_FILES) {
      this.snapshots.delete(st.root);
    } else if (prev && !this.bashSince(st.root, prev.at)) {
      // Nobody of this repo was in Bash (or a writing tool call) since the last status: nothing to attribute, so nothing is stat'ed. The next
      // examined status counts only the files whose mtime is after this one.
      this.snapshots.set(st.root, { at: st.checkedAt, files: new Map(paths.map((p) => [p, null])), unknown: true });
    } else {
      const files: FileState[] = [];
      for (const path of paths) files.push({ path, mtime: await this.stat(path) });
      const to = this.now();
      if (epoch !== this.epoch) {
        // The connection to atelierd changed during the stats: these files and the windows we hold do not match any
        // more, whether or not there was a previous status. The next status is a baseline.
        this.snapshots.delete(st.root);
      } else {
        this.snapshots.set(st.root, { at: st.checkedAt, files: new Map(files.map((f) => [f.path, f.mtime])), unknown: false });
      }
      if (prev && epoch === this.epoch) {
        // Refreshed after the stats: a session may have entered or left Bash or a tool call meanwhile.
        this.windows = trackBashWindows(this.windows, this.terminals, to);
        const changes = changedFiles(prev.files, files, prev.unknown ? prev.at - BASH_SLACK_MS : undefined);
        adds = this.attribute(st.root, changes, prev.at, to, st.checkedAt);
      }
    }
    // Built on the current list, never on one read before the awaits: a resolution or an undo made during the stats stays.
    let next = this.items;
    if (o.prune) next = pruneAttributions(next, st.root, new Set([...paths, ...(o.keep ?? [])]), { exclude: o.exclude, before: st.checkedAt });
    if (adds.length > 0) next = addBashAttributions(next, adds, MAX_BASH_ATTRIBUTIONS);
    if (next === this.items) return;
    this.items = next;
    this.save();
    this.onChange();
  }

  /** Terminals (live, or closed with Bash or tool-call windows left) of a project that contains the repo or is inside it. */
  private eligible(root: string): Set<string> {
    return new Set([...this.known.values()].filter((t) => relatedRoots(this.realRoot(t.projectRoot), root)).map((t) => t.id));
  }

  private bashSince(root: string, from: number): boolean {
    const now = this.now();
    const eligible = this.eligible(root);
    if (this.calls) return writingCallBetween(this.calls, from, now, (id) => eligible.has(id));
    this.windows = trackBashWindows(this.windows, this.terminals, now);
    return bashBetween(this.windows, from, now, (id) => eligible.has(id));
  }

  private attribute(root: string, changes: FileState[], from: number, to: number, at: number): Attribution[] {
    if (changes.length === 0) return [];
    const eligible = this.eligible(root);
    const out: Attribution[] = [];
    for (const c of changes) {
      if (this.daemonPaths.has(c.path)) continue;
      const wrote = this.appWrites.get(c.path);
      if (wrote !== undefined && wrote >= from - BASH_SLACK_MS) continue;
      if (this.calls) {
        out.push(...this.fromCalls(c, from, to, at, eligible));
        continue;
      }
      const w = bashCulprit(c, from, to, this.windows, (id) => eligible.has(id));
      const t = w && this.known.get(w.terminalId);
      if (!w || !t) continue;
      out.push({ path: c.path, terminalId: t.id, sessionId: w.sessionId, color: t.color, title: t.title, at, via: 'bash' });
    }
    return out;
  }

  /**
   * Exact mode: the one session whose writing call contains the change, every candidate marked unclear, or the one
   * session whose background command alone was running marked maybe.
   */
  private fromCalls(c: FileState, from: number, to: number, at: number, eligible: Set<string>): Attribution[] {
    const k = callCulprit(c, from, to, this.calls ?? [], (id) => eligible.has(id), undefined, undefined, (id) => this.known.has(id));
    if (!k) return [];
    const picked = k.kind === 'unclear' ? k.calls : [k.call];
    if (picked.length > MAX_CANDIDATES) return [];
    const mark = k.kind === 'unclear' ? { unclear: picked.map((x) => x.terminalId) } : k.kind === 'maybe' ? { maybe: true as const } : {};
    const changedAt = changeTime(c, from, to);
    const out: Attribution[] = [];
    for (const call of picked) {
      const t = this.known.get(call.terminalId);
      if (!t) continue;
      const via = call.tool === 'Bash' ? { via: 'bash' as const } : { via: 'tool' as const, tool: call.tool };
      out.push({
        path: c.path, terminalId: t.id, sessionId: call.sessionId, color: t.color, title: t.title, at, ...via, ...mark,
        ...(changedAt !== null ? { changedAt } : {}), ...(call.command ? { command: shownCommand(call.command) } : {}),
        callStart: call.start, ...(call.end !== null ? { callEnd: call.end } : {}),
        // Where it ran only explains a doubt: kept on unsure entries, as a real path (like the repos), clean.
        ...(k.kind !== 'one' && call.cwd && cleanCwd(call.cwd) ? { cwd: this.realpath(call.cwd) } : {})
      });
    }
    return out;
  }

  /**
   * The user settles unsure files: for each path, its unsure entries become one entry
   * for `terminalId`, marked resolved — only where that session is one of the candidates — or, with null (changed
   * outside Claude), they go. Returns an undo token (random; only `scope`, the resolving window's project prefix, may
   * use it) and how many files changed, or null when none did.
   */
  resolve(paths: string[], terminalId: string | null, scope = '/'): { token: string; count: number } | null {
    const targets = new Set(paths);
    const removed: Attribution[] = [];
    const added: Attribution[] = [];
    let count = 0;
    for (const path of targets) {
      const unsure = this.items.filter((a) => a.path === path && isUnsure(a));
      if (unsure.length === 0) continue;
      if (terminalId === null) {
        removed.push(...unsure);
        count++;
        continue;
      }
      const pick = unsure.find((a) => a.terminalId === terminalId);
      if (!pick) continue;
      const { unclear: _u, maybe: _m, ...rest } = pick;
      count++;
      removed.push(...unsure);
      // A sure entry of the same session for this file is replaced too: one entry per session and file.
      removed.push(...this.items.filter((a) => a.path === path && a.terminalId === terminalId && !isUnsure(a)));
      added.push({ ...rest, resolved: true });
    }
    if (removed.length === 0) return null;
    const gone = new Set(removed);
    this.items = [...this.items.filter((a) => !gone.has(a)), ...added];
    const token = randomBytes(12).toString('hex');
    const touched = new Set(removed.map((a) => a.path));
    this.undos.set(token, { removed, added, after: this.items.filter((a) => touched.has(a.path)), scope });
    for (const k of this.undos.keys()) { if (this.undos.size <= MAX_UNDO) break; this.undos.delete(k); }
    this.save();
    this.onChange();
    return { token, count };
  }

  /** Puts back what a resolution replaced, if what it left is still there untouched; only from the project that resolved. */
  undo(token: string, scope = '/'): boolean {
    const u = this.undos.get(token);
    if (!u || u.scope !== scope) return false;
    this.undos.delete(token);
    // Stale when the entries of those files changed since (a new change, a prune): exactly what it left, or nothing.
    const paths = new Set(u.removed.map((a) => a.path));
    const now = this.items.filter((a) => paths.has(a.path));
    if (now.length !== u.after.length || !now.every((a) => u.after.includes(a))) return false;
    const drop = new Set(u.added);
    this.items = [...this.items.filter((a) => !drop.has(a)), ...u.removed];
    this.save();
    this.onChange();
    return true;
  }

  private realRoot(p: string): string {
    let r = this.realRoots.get(p);
    if (r === undefined) { r = this.realpath(p); this.realRoots.set(p, r); }
    return r;
  }

  /** What parses is kept (the newest, within the bounds); only an absurdly large or broken file is ignored. */
  private load(file: string): Attribution[] {
    try {
      if (statSync(file).size > MAX_LOAD_BYTES) return [];
      const raw = (JSON.parse(readFileSync(file, 'utf8')) as { list?: unknown }).list;
      if (!Array.isArray(raw)) return [];
      return boundBytes(raw.map(validEntry).filter((a): a is Attribution => a !== null).slice(-MAX_BASH_ATTRIBUTIONS));
    } catch {
      return [];
    }
  }

  /** Bounded on save: at most MAX_BASH_ATTRIBUTIONS entries and MAX_FILE_BYTES (the oldest go first). */
  private save(): void {
    if (!this.file) return;
    this.items = boundBytes(this.items);
    try {
      ensureDir(dirname(this.file), 0o700);
      writeFileAtomic(this.file, JSON.stringify({ v: 1, list: this.items }), 0o600);
    } catch { /* the list stays in memory; the next change tries again */ }
  }
}
