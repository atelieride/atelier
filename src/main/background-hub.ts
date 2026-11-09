// src/main/background-hub.ts
import type { TerminalInfo } from '@shared/protocol';
import type { BackgroundKind } from '@shared/session';
import { ITEM_ID, isInside, outputPath, projectsRootOf, sessionTranscriptPath, transcriptPath, type ClaudeRoots } from '@shared/background-files';
import { LOOP_MAX_AHEAD_MS, selfPacedLoop } from '@shared/loop';
import { loopDetail, oldestStamp } from '@shared/loop-transcript';
import { BUFFER_LINES, OutputTail } from '@shared/output-tail';
import { TranscriptReader } from '@shared/transcript';
import { feedKey, type BackgroundFeed, type LoopResult, type Unavailable, type WatchResult } from '@shared/background-feed';

export interface HubFs {
  realpath(p: string): Promise<string | null>;
  stat(p: string): Promise<{ size: number; ino: number } | null>;
  /** The uid owning a path, or null when it cannot be read. */
  owner(p: string): Promise<number | null>;
  read(p: string, start: number, length: number): Promise<Uint8Array>;
  watch(p: string, onChange: () => void): () => void;
}
/** `uid`: the app's own user; the temp root (in the shared /tmp) must be theirs. Null: no check (no POSIX uid). */
export interface HubDeps {
  fs: HubFs; roots(): ClaudeRoots; log(line: string): void; uid: number | null; now?(): number;
  /** How long a missing output is retried before "unavailable" (MISSING_GIVE_UP_MS; shorter in e2e). */
  missingGiveUpMs?: number;
}

export const TAIL_BYTES = 64 * 1024;
export const TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** A loop's first read: the session transcript's tail, where its newest wake-ups are. */
export const LOOP_TAIL_BYTES = 512 * 1024;
export const READ_CHUNK = 1024 * 1024;
export const MAX_WATCHED = 6;
export const POLL_MS = 1000;
export const MISSING_RETRY_MS = 2000;
export const MISSING_GIVE_UP_MS = 10_000;
/** A followed item sends at most one feed per this long: a chatty process costs one IPC message and render, not one per read. */
export const FEED_MS = 100;
const EXIT_BYTES = 256;
const EXIT_TRAILER = /\[exited with code (\d+)\]\s*$/;

interface Follower {
  wcId: number; terminalId: string; itemId: string; sessionId: string; order: number;
  kind: 'output' | 'timeline'; path: string | null; cwd: string; started: number;
  /** A timeline's projects root when the session runs with another Claude config dir (checked to be the user's). */
  projects: string | null;
  real: string | null; offset: number; ino: number | null; first: boolean;
  tail: OutputTail; reader: TranscriptReader;
  stopWatch: (() => void) | null; poll: NodeJS.Timeout | null; retry: NodeJS.Timeout | null;
  busy: boolean; again: boolean; closed: boolean; stopped: boolean; logged: boolean; feedLogged: boolean;
  lastLive: string; lastExit: number | null;
  /** What is held back until the next send (FEED_MS after the last one): a snapshot, or the new lines in order. */
  pend: { reset: boolean; lines: string[] } | null; flush: NodeJS.Timeout | null; sentAt: number;
  /** The flush timer fired while a tick was reading: the send waits for the tick's end (the tail moves during a read). */
  flushDue: boolean;
}

/** The trailer of a shell that just ended may not be flushed yet: one more look after this delay. */
export const EXIT_RETRY_MS = 2000;

/** Reads an exit code; on null (not there yet) waits and tries once more, unless `live` says the app is going away. */
export async function probeExit(read: () => Promise<number | null>, wait: (ms: number) => Promise<void>, live: () => boolean = () => true): Promise<number | null> {
  const first = await read();
  if (first !== null) return first;
  await wait(EXIT_RETRY_MS);
  return live() ? read() : null;
}

export interface ExitProbeDeps {
  exitOf(terminalId: string, itemId: string): Promise<number | null>;
  /** Attaches the code to the recent item; false when it is not listed any more. */
  setExit(terminalId: string, itemId: string, exit: number): boolean;
  publish(): void;
  wait(ms: number): Promise<void>;
  live(): boolean;
  log(line: string): void;
}

/** TerminalHub's wiring for items that just ended: shells and monitors (agents have no trailer) get their exit code. */
export function probeEndedExits(ended: readonly { terminalId: string; id: string; kind: BackgroundKind }[], d: ExitProbeDeps): Promise<void>[] {
  return ended.filter((e) => e.kind !== 'agent').map((e) => probeExit(() => d.exitOf(e.terminalId, e.id), d.wait, d.live).then((exit) => {
    if (exit !== null && d.setExit(e.terminalId, e.id, exit)) d.publish();
  }).catch((err: unknown) => { d.log(`background: exit probe for ${e.id} failed: ${(err as Error)?.message ?? String(err)}`); }));
}

/** Where an item's files are: its kind, the session it runs (or ran) in and that session's folder. */
interface Located { kind: BackgroundKind; sessionId: string; cwd: string }

/**
 * Follows the files an open Background inspector shows: a background shell's or
 * monitor's output, a subagent's transcript. Paths come from main's own terminal list (session id, cwd, item id),
 * resolved and checked inside Claude Code's roots; nothing is read while no inspector asks, nothing is ever written.
 */
export class BackgroundHub {
  onFeed: (wcId: number, feed: BackgroundFeed) => void = () => {};
  private list: readonly TerminalInfo[] = [];
  private followers = new Map<string, Follower>();
  private order = 0;

  constructor(private readonly deps: HubDeps) {}

  /** The hub's log line (the app log), for its wiring in TerminalHub. */
  log(line: string): void { this.deps.log(line); }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /**
   * A new terminal list: followers of a terminal that left, or of an item its session no longer lists (a different
   * session started there), close. An item that ended with its session is still a recent item: it stays followed.
   */
  terminals(list: readonly TerminalInfo[]): void {
    this.list = list;
    for (const [id, f] of this.followers) {
      const t = list.find((x) => x.id === f.terminalId);
      if (t?.session?.sessionId === f.sessionId) continue;
      if (t?.recent?.some((r) => r.id === f.itemId && r.sessionId === f.sessionId)) continue;
      this.close(id);
    }
  }

  async watch(wcId: number, terminalId: string, itemId: string): Promise<WatchResult> {
    if (!ITEM_ID.test(itemId)) return { ok: false, reason: 'outside' };
    const t = this.list.find((x) => x.id === terminalId);
    const at = t ? this.locate(t, itemId) : null;
    if (!at) return { ok: false, reason: 'missing' };
    const id = `${wcId}|${feedKey(terminalId, itemId)}`;
    const roots = this.deps.roots();
    const { kind, sessionId, cwd } = at;
    const timeline = kind === 'agent';
    // A session started with another config dir (`CLAUDE_CONFIG_DIR=… claude`) keeps its transcripts there. A recent
    // item ran in the terminal's last session, so the terminal's dir is its dir too (a new session clears them).
    const projects = timeline && t!.configDir !== roots.configDir ? projectsRootOf(t!.configDir) : null;
    const path = timeline ? transcriptPath(projects ? { ...roots, projects } : roots, cwd, sessionId, itemId) : outputPath(roots, cwd, sessionId, itemId);
    if (!path) return { ok: false, reason: 'outside' };
    // A re-watch starts over with a fresh follower (a fresh snapshot, and the newest subscription).
    this.close(id);
    const mine = [...this.followers.entries()].filter(([, f]) => f.wcId === wcId).sort((a, b) => a[1].order - b[1].order);
    if (mine.length >= MAX_WATCHED) this.close(mine[0]![0]);
    const f: Follower = {
      wcId, terminalId, itemId, sessionId, order: this.order++,
      kind: timeline ? 'timeline' : 'output', path, projects,
      cwd, started: this.now(), real: null, offset: 0, ino: null, first: true,
      tail: new OutputTail(), reader: new TranscriptReader(),
      stopWatch: null, poll: null, retry: null, busy: false, again: false, closed: false, stopped: false,
      logged: false, feedLogged: false, lastLive: '', lastExit: null,
      pend: null, flush: null, sentAt: -Infinity, flushDue: false
    };
    this.followers.set(id, f);
    void this.tick(f);
    return { ok: true };
  }

  unwatch(wcId: number, terminalId: string, itemId: string): void { this.close(`${wcId}|${feedKey(terminalId, itemId)}`); }

  windowGone(wcId: number): void { for (const [id, f] of this.followers) if (f.wcId === wcId) this.close(id); }

  /** The exit code in an ended shell's output trailer, or null (no file, outside the roots, no trailer). */
  async exitOf(terminalId: string, itemId: string): Promise<number | null> {
    const t = this.list.find((x) => x.id === terminalId);
    const at = t && ITEM_ID.test(itemId) ? this.locate(t, itemId) : null;
    if (!at) return null;
    const roots = this.deps.roots();
    const path = outputPath(roots, at.cwd, at.sessionId, itemId);
    try {
      const real = path ? await this.deps.fs.realpath(path) : null;
      const root = await this.deps.fs.realpath(roots.tmp);
      if (!real || !root || real === root || !isInside(root, real) || !(await this.ownRoot(root))) return null;
      const st = await this.deps.fs.stat(real);
      if (!st) return null;
      const start = Math.max(0, st.size - EXIT_BYTES);
      const m = EXIT_TRAILER.exec(new TextDecoder().decode(await this.deps.fs.read(real, start, st.size - start)));
      return m ? Number(m[1]) : null;
    } catch { return null; }
  }

  /**
   * A self-paced loop's details: read once from the session's own transcript, its tail first
   * and once more up to TRANSCRIPT_BYTES when the tail holds no wake-up for the cron, or only the end of its run. Same
   * root checks as timelines. Only a loop's cron is read for.
   */
  async loop(terminalId: string, cronId: string): Promise<LoopResult> {
    if (!ITEM_ID.test(cronId)) return { ok: false, reason: 'outside' };
    const t = this.list.find((x) => x.id === terminalId);
    const cron = t?.session ? t.work?.crons.find((c) => c.id === cronId) : undefined;
    if (!t?.session || !cron || !selfPacedLoop(cron.label, cron.recurring)) return { ok: false, reason: 'missing' };
    const roots = this.deps.roots();
    const projects = t.configDir !== roots.configDir ? projectsRootOf(t.configDir) : null;
    const path = sessionTranscriptPath(projects ? { ...roots, projects } : roots, t.session.cwd ?? t.cwd, t.session.sessionId);
    if (!path) return { ok: false, reason: 'outside' };
    try {
      const real = await this.deps.fs.realpath(path);
      if (!real) return { ok: false, reason: 'missing' };
      const root = await this.deps.fs.realpath(projects ?? roots.projects);
      // The default projects root is the user's own config; another one named by hook data must be theirs too.
      const mine = !projects || (!!root && await this.ownRoot(root));
      if (!root || real === root || !isInside(root, real) || !mine) return { ok: false, reason: 'outside' };
      const st = await this.deps.fs.stat(real);
      if (!st) return { ok: false, reason: 'missing' };
      const now = this.now();
      const read = async (bytes: number) => {
        const start = Math.max(0, st.size - bytes);
        return { text: new TextDecoder().decode(await this.deps.fs.read(real, start, st.size - start)), fromStart: start === 0 };
      };
      const tail = await read(LOOP_TAIL_BYTES);
      const first = loopDetail(tail.text, cron.schedule, now, tail.fromStart);
      // No wake-up in a tail that already starts further back than one can be asked for: none is further back either.
      const oldest = first.ok ? null : oldestStamp(tail.text);
      const more = first.ok ? !first.detail.complete : first.reason === 'missing' && !(oldest !== null && now - oldest > LOOP_MAX_AHEAD_MS + 60_000);
      if (!more || tail.fromStart) return first;
      const wide = await read(TRANSCRIPT_BYTES);
      const again = loopDetail(wide.text, cron.schedule, now, wide.fromStart);
      // A wider read that lost the match (the file changed in between) never replaces a good answer.
      return again.ok || !first.ok ? again : first;
    } catch { return { ok: false, reason: 'unreadable' }; }
  }

  dispose(): void { for (const id of [...this.followers.keys()]) this.close(id); }

  /**
   * The temp root sits in the shared /tmp: anyone can create `/tmp/claude-<our uid>` before Claude Code does, and fill
   * it. Only a root owned by the app's user is read from; the same goes for another config dir's projects root.
   */
  private async ownRoot(root: string): Promise<boolean> {
    if (this.deps.uid === null) return true;
    return (await this.deps.fs.owner(root)) === this.deps.uid;
  }

  /** A listed item runs in the terminal's session; a recent one ran in the session it recorded (maybe ended since). */
  private locate(t: TerminalInfo, itemId: string): Located | null {
    const e = t.session ? t.work?.entries.find((x) => x.id === itemId) : undefined;
    if (e && t.session) return { kind: e.kind, sessionId: t.session.sessionId, cwd: t.session.cwd ?? t.cwd };
    const r = t.recent?.find((x) => x.id === itemId);
    return r ? { kind: r.kind, sessionId: r.sessionId, cwd: r.cwd } : null;
  }

  private close(id: string): void {
    const f = this.followers.get(id);
    if (!f) return;
    f.closed = true;
    f.stopWatch?.();
    if (f.poll) clearInterval(f.poll);
    if (f.retry) clearTimeout(f.retry);
    if (f.flush) clearTimeout(f.flush);
    f.pend = null;
    this.followers.delete(id);
  }

  private stop(f: Follower): void {
    f.stopWatch?.(); f.stopWatch = null;
    if (f.poll) { clearInterval(f.poll); f.poll = null; }
    if (f.retry) { clearTimeout(f.retry); f.retry = null; }
    if (f.flush) { clearTimeout(f.flush); f.flush = null; }
  }

  /** The file cannot be followed: said at once (it replaces whatever was held back), and the follower stops. */
  private unavailable(f: Follower, reason: Unavailable): void {
    f.stopped = true;
    this.stop(f);
    f.pend = null;
    this.send(f, true, [], reason);
  }

  /**
   * Queues a change for the window: sent at once when the last send is FEED_MS old, else merged with what is held
   * back (new lines appended in order; a reset wins and is sent as the whole snapshot) and sent when the window ends,
   * with the live line and exit code of that moment.
   */
  private emit(f: Follower, reset: boolean, lines: string[]): void {
    const p = f.pend ?? (f.pend = { reset: false, lines: [] });
    if (reset) { p.reset = true; p.lines = []; }
    else if (!p.reset) {
      for (const l of lines) p.lines.push(l);
      // More new lines than the buffer holds: the snapshot is the truth, not the delta.
      if (p.lines.length > BUFFER_LINES) { p.reset = true; p.lines = []; }
    }
    if (f.flush) return;
    const wait = f.sentAt + FEED_MS - this.now();
    if (wait <= 0) { this.flushNow(f); return; }
    f.flush = setTimeout(() => {
      f.flush = null;
      if (f.closed || f.stopped) return;
      if (f.busy) f.flushDue = true;
      else this.flushNow(f);
    }, wait);
  }

  private flushNow(f: Follower): void {
    const p = f.pend;
    f.pend = null;
    if (p) this.send(f, p.reset, p.lines);
  }

  private send(f: Follower, reset: boolean, lines: string[], unavailable?: Unavailable): void {
    const key = feedKey(f.terminalId, f.itemId);
    const at = this.now();
    f.sentAt = at;
    let feed: BackgroundFeed;
    if (f.kind === 'output') {
      const t = f.tail;
      feed = { key, kind: 'output', lines: reset ? [...t.lines] : lines, live: t.live, reset, seq: t.seq, dropped: t.dropped, exit: t.exit, at, ...(unavailable ? { unavailable } : {}) };
    } else {
      const r = f.reader;
      const reason = unavailable ?? (r.unrecognized() ? 'format' : undefined);
      feed = { key, kind: 'timeline', entries: r.shown(), meta: { ...r.meta }, at, ...(reason ? { unavailable: reason } : {}) };
    }
    // A consumer that throws (a destroyed window) is not a file error.
    try { this.onFeed(f.wcId, feed); } catch (e) {
      if (!f.feedLogged) { f.feedLogged = true; this.deps.log(`background: feed for ${f.itemId} not delivered: ${(e as Error).message}`); }
    }
  }

  /**
   * Positions the next read at the end of the file: the last `window` bytes, from a line boundary. A window that
   * starts exactly at a line start keeps that line; one with no newline at all is kept for output (a `\r` progress
   * bar: `live` shows its latest segment) and skipped for a transcript (a JSON line cut in the middle is useless).
   */
  private async seekTail(f: Follower, size: number): Promise<void> {
    const window = f.kind === 'output' ? TAIL_BYTES : TRANSCRIPT_BYTES;
    f.offset = Math.max(0, size - window);
    if (f.offset === 0) return;
    const head = await this.deps.fs.read(f.real!, f.offset - 1, Math.min(READ_CHUNK, size - f.offset) + 1);
    if (f.closed) return;
    if (head[0] !== 10) {
      const rest = head.subarray(1);
      const nl = rest.indexOf(10);
      if (nl >= 0) f.offset += nl + 1;
      else if (f.kind === 'timeline') f.offset += rest.length;
    }
    // A timeline that starts past the beginning never saw the task: a later user line is not it.
    if (f.kind === 'timeline') f.reader.startsMidFile();
  }

  private async tick(f: Follower): Promise<void> {
    if (f.closed || f.stopped) return;
    if (f.busy) { f.again = true; return; }
    f.busy = true;
    try {
      if (!f.real) {
        const real = f.path ? await this.deps.fs.realpath(f.path) : null;
        if (f.closed) return;
        if (!real) {
          if (this.now() - f.started >= (this.deps.missingGiveUpMs ?? MISSING_GIVE_UP_MS)) { this.unavailable(f, 'missing'); return; }
          f.retry = setTimeout(() => { f.retry = null; void this.tick(f); }, MISSING_RETRY_MS);
          return;
        }
        const roots = this.deps.roots();
        const root = await this.deps.fs.realpath(f.kind === 'timeline' ? f.projects ?? roots.projects : roots.tmp);
        if (f.closed) return;
        // The default projects root is the user's own config; another one named by hook data must be theirs too.
        const mine = (f.kind === 'timeline' && !f.projects) || (!!root && await this.ownRoot(root));
        if (f.closed) return;
        if (!root || real === root || !isInside(root, real) || !mine) { this.unavailable(f, 'outside'); return; }
        f.real = real;
        f.stopWatch = this.deps.fs.watch(real, () => void this.tick(f));
        f.poll = setInterval(() => void this.tick(f), POLL_MS);
      }
      const st = await this.deps.fs.stat(f.real);
      if (f.closed) return;
      if (!st) { this.unavailable(f, 'missing'); return; }
      let reset = f.first;
      if (f.ino !== null && (st.ino !== f.ino || st.size < f.offset)) {
        f.offset = 0; f.tail.reset(); f.reader.reset(); reset = true;
      }
      // Far behind (a burst of output): jump to the tail instead of replaying it all, as a reset snapshot.
      if (f.kind === 'output' && !reset && st.size - f.offset > 4 * TAIL_BYTES) {
        f.tail.reset(); reset = true;
        f.ino = null;
      }
      if (f.ino === null || reset) {
        // First read (or a restart): only the end of the file, from a line boundary.
        f.ino = st.ino;
        await this.seekTail(f, st.size);
        if (f.closed) return;
      }
      f.ino = st.ino;
      let added: string[] = [];
      let completed = 0;
      while (f.offset < st.size && !f.closed) {
        const bytes = await this.deps.fs.read(f.real, f.offset, Math.min(READ_CHUNK, st.size - f.offset));
        if (f.closed) return;
        if (bytes.length === 0) break;
        f.offset += bytes.length;
        if (f.kind === 'output') for (const line of f.tail.push(bytes)) added.push(line);
        else completed += f.reader.push(bytes, f.cwd);
      }
      if (f.closed) return;
      // More new lines than the buffer holds: the snapshot is the truth, not the delta.
      if (added.length > BUFFER_LINES) { reset = true; added = []; }
      // Only what changed goes out: new lines, a new live line, a new exit code, a timeline with a new line, or a snapshot.
      if (reset || added.length > 0 || (f.kind === 'timeline' && completed > 0) || (f.kind === 'output' && (f.tail.live !== f.lastLive || f.tail.exit !== f.lastExit))) {
        this.emit(f, reset, added);
        f.lastLive = f.tail.live;
        f.lastExit = f.tail.exit;
      }
      f.first = false;
    } catch (e) {
      if (f.closed) return;
      if (!f.logged) { f.logged = true; this.deps.log(`background: cannot read ${f.itemId}: ${(e as Error).message}`); }
      this.unavailable(f, 'unreadable');
    } finally {
      f.busy = false;
      if (f.flushDue) { f.flushDue = false; if (!f.closed && !f.stopped) this.flushNow(f); }
      if (f.again && !f.closed) { f.again = false; void this.tick(f); }
    }
  }
}
