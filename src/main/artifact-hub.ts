// src/main/artifact-hub.ts
import type { TerminalInfo } from '@shared/protocol';
import { MAIN_AGENT, type SessionState } from '@shared/session';
import type { ToolCallWindow } from '@shared/tool-calls';
import { ArtifactLog, type SessionArtifact } from '@shared/artifacts';
import { isInside, projectsRootOf, sessionTranscriptPath, type ClaudeRoots } from '@shared/background-files';
import type { HubFs } from './background-hub';

/** The first read of a session's transcript covers at most its end: artifacts further back are not looked for. */
export const FIRST_SCAN_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 1024 * 1024;
/** After an Artifact call ends, its result line may not be in the transcript yet: read again after these waits. */
export const RETRY_MS: readonly number[] = [500, 1500, 4000];
/** Tool calls already acted on, so a list atelierd sends again reads nothing more. */
const MAX_HANDLED = 512;

export interface ArtifactDeps {
  fs: Pick<HubFs, 'realpath' | 'stat' | 'owner' | 'read'>;
  roots(): ClaudeRoots;
  /** The app's own user: another account's projects root must be theirs. Null: no check (no POSIX uid). */
  uid: number | null;
  log(line: string): void;
  firstScanBytes?: number;
  chunkBytes?: number;
  setTimer?(fn: () => void, ms: number): () => void;
}

/** One terminal's Claude session, followed through its transcript. */
interface Followed {
  terminalId: string;
  sessionId: string;
  cwd: string;
  configDir: string | undefined;
  state: SessionState;
  /** The transcript file being read (its inode) and how far; null before the first read found it. */
  ino: number | null;
  offset: number;
  lines: TranscriptLines;
  log: ArtifactLog;
  list: SessionArtifact[];
  timers: Set<() => void>;
  /** A failed read was logged: a transcript that can't be read fails again at every state change. */
  logged: boolean;
}

const defaultTimer = (fn: () => void, ms: number) => {
  const h = setTimeout(fn, ms);
  h.unref?.();
  return () => clearTimeout(h);
};

/**
 * A transcript's bytes cut into lines, each searched as bytes and decoded only when the log finds it relevant: a long
 * session's transcript is mostly tool output and images, and decoding all of it on main took ~0.4–0.8 s per 64 MB. A
 * line cut between reads waits for its end and is decoded whole, so a character cut between reads stays whole too.
 */
export class TranscriptLines {
  /** The bytes after the last newline: a line still being written (copies: a reader may reuse its buffer). */
  private carry: Buffer[] = [];

  /** The lines these bytes complete, in order, each fed to the log when relevant. True when its list changed. */
  push(bytes: Uint8Array, log: Pick<ArtifactLog, 'relevant' | 'line'>): boolean {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let changed = false;
    let start = 0;
    for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) {
      const part = buf.subarray(start, nl);
      const line = this.carry.length > 0 ? Buffer.concat([...this.carry, part]) : part;
      this.carry = [];
      start = nl + 1;
      if (log.relevant((s) => line.includes(s)) && log.line(line.toString('utf8'))) changed = true;
    }
    if (start < buf.length) this.carry.push(Buffer.from(buf.subarray(start)));
    return changed;
  }
}

/**
 * The Artifacts each session published, from its transcript. A session is read once when it is first seen (the
 * transcript's last FIRST_SCAN_BYTES), then only what was written since: when one of its Artifact calls ends
 * (atelierd's tool-call windows; read again a few times until the call's result line is there) and when its state
 * changes. Same root checks as the Background inspector's loop details; read-only, one read at a time.
 */
export class ArtifactHub {
  /** Some session's list changed (TerminalHub sends the terminals again). */
  onChange: () => void = () => {};
  private followed = new Map<string, Followed>();
  private handled = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: ArtifactDeps) {}

  /** The terminals: a new session is read, a state change reads what was written since, a session that left is dropped. */
  terminals(list: readonly TerminalInfo[]): void {
    let changed = false;
    const live = new Set<string>();
    for (const t of list) {
      const s = t.session;
      if (!s) continue;
      live.add(t.id);
      const cwd = s.cwd ?? t.cwd;
      const old = this.followed.get(t.id);
      if (old && old.sessionId === s.sessionId) {
        old.cwd = cwd;
        old.configDir = t.configDir;
        if (old.state !== s.state) { old.state = s.state; void this.read(old); }
        continue;
      }
      // `drop` must run for each one: `changed ||= this.drop(…)` would skip it once something changed.
      if (old && this.drop(old)) changed = true;
      const f: Followed = {
        terminalId: t.id, sessionId: s.sessionId, cwd, configDir: t.configDir, state: s.state,
        ino: null, offset: 0, lines: new TranscriptLines(), log: new ArtifactLog(), list: [], timers: new Set(), logged: false
      };
      this.followed.set(t.id, f);
      void this.read(f);
    }
    for (const f of [...this.followed.values()]) if (!live.has(f.terminalId) && this.drop(f)) changed = true;
    if (changed) this.onChange();
  }

  /** atelierd's tool-call windows (null with an older atelierd): each main-agent Artifact call that ended is read for. */
  toolCalls(list: readonly ToolCallWindow[] | null): void {
    for (const c of list ?? []) {
      if (c.tool !== 'Artifact' || c.end === null || c.agent !== MAIN_AGENT) continue;
      const key = `${c.terminalId}\u0000${c.id}`;
      if (this.handled.has(key)) continue;
      this.handled.add(key);
      if (this.handled.size > MAX_HANDLED) this.handled.delete(this.handled.values().next().value as string);
      const f = this.followed.get(c.terminalId);
      if (f && f.sessionId === c.sessionId) this.awaitResult(f, c.id, 0);
    }
  }

  /** The artifacts of that terminal's session, newest first; undefined when it has none (or another session runs there). */
  artifacts(terminalId: string, sessionId: string): SessionArtifact[] | undefined {
    const f = this.followed.get(terminalId);
    return f && f.sessionId === sessionId && f.list.length > 0 ? f.list : undefined;
  }

  dispose(): void {
    this.disposed = true;
    for (const f of this.followed.values()) this.drop(f);
    this.followed.clear();
  }

  private current(f: Followed): boolean {
    return !this.disposed && this.followed.get(f.terminalId) === f;
  }

  /** Stops following; true when it had artifacts (the terminals must be sent again). */
  private drop(f: Followed): boolean {
    for (const cancel of f.timers) cancel();
    f.timers.clear();
    if (this.followed.get(f.terminalId) === f) this.followed.delete(f.terminalId);
    return f.list.length > 0;
  }

  /** Reads, then again after each of RETRY_MS while the call's result line hasn't been read. */
  private awaitResult(f: Followed, toolUseId: string, attempt: number): void {
    void this.read(f).then(() => {
      if (!this.current(f) || f.log.resultSeen(toolUseId)) return;
      const ms = RETRY_MS[attempt];
      if (ms === undefined) return;
      const cancel = (this.deps.setTimer ?? defaultTimer)(() => {
        f.timers.delete(cancel);
        this.awaitResult(f, toolUseId, attempt + 1);
      }, ms);
      f.timers.add(cancel);
    });
  }

  /** Queued behind any read in progress: one file read at a time for the whole app. */
  private read(f: Followed): Promise<void> {
    const next = this.chain.then(() => this.readNow(f)).catch((e: unknown) => {
      if (f.logged) return;
      f.logged = true;
      this.deps.log(`artifacts: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.chain = next;
    return next;
  }

  private async readNow(f: Followed): Promise<void> {
    if (!this.current(f)) return;
    const path = await this.resolve(f);
    if (!path || !this.current(f)) return;
    const st = await this.deps.fs.stat(path);
    if (!st || !this.current(f)) return;
    let changed = false;
    // Rewritten (shorter, or another file at that path): read again from its start.
    if (f.ino !== null && (st.ino !== f.ino || st.size < f.offset)) {
      changed = f.list.length > 0;
      f.log = new ArtifactLog();
      f.lines = new TranscriptLines();
      f.list = [];
      f.ino = null;
    }
    if (f.ino === null) {
      f.ino = st.ino;
      f.offset = Math.max(0, st.size - (this.deps.firstScanBytes ?? FIRST_SCAN_BYTES));
    }
    const chunk = this.deps.chunkBytes ?? CHUNK_BYTES;
    while (f.offset < st.size) {
      const bytes = await this.deps.fs.read(path, f.offset, Math.min(chunk, st.size - f.offset));
      if (!this.current(f)) return;
      if (bytes.length === 0) break;
      f.offset += bytes.length;
      if (f.lines.push(bytes, f.log)) changed = true;
    }
    if (!changed) return;
    f.list = f.log.list();
    this.onChange();
  }

  /** The session's transcript as a real path inside its projects root, or null. */
  private async resolve(f: Followed): Promise<string | null> {
    const roots = this.deps.roots();
    // A session started with another config dir (`CLAUDE_CONFIG_DIR=… claude`) keeps its transcripts there.
    const projects = f.configDir !== roots.configDir ? projectsRootOf(f.configDir) : null;
    const path = sessionTranscriptPath(projects ? { ...roots, projects } : roots, f.cwd, f.sessionId);
    if (!path) return null;
    const real = await this.deps.fs.realpath(path);
    if (!real) return null;
    const root = await this.deps.fs.realpath(projects ?? roots.projects);
    if (!root || real === root || !isInside(root, real)) return null;
    // The default projects root is the user's own config; another one named by hook data must be theirs too.
    if (projects && this.deps.uid !== null && (await this.deps.fs.owner(root)) !== this.deps.uid) return null;
    return real;
  }
}

/** Each terminal with the artifacts of its current session; the field only when there are some. */
export function attachArtifacts(list: readonly TerminalInfo[], of: (terminalId: string, sessionId: string) => SessionArtifact[] | undefined): TerminalInfo[] {
  return list.map((t) => {
    const a = t.session ? of(t.id, t.session.sessionId) : undefined;
    return a ? { ...t, artifacts: a } : t;
  });
}
