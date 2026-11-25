// A Claude session's conversation as phones follow it: the session's transcript, read as it grows, into numbered
// entries (ConversationParser). One follower per terminal, shared by every phone that follows it. Its key names the
// conversation: it changes when the terminal's Claude session changes and when the transcript stops continuing the one
// read before, never when Claude only adds to it or completes an entry. Main only reads transcripts: never through a
// symlink, regular files only (readJsonLines), never written.
import { createHash } from 'node:crypto';
import { ConversationParser } from '@shared/conversation/parse';
import type { Entry } from '@shared/conversation/types';
import type { TerminalInfo } from '@shared/protocol';
import { realHubFs } from '../background-fs';
import { readJsonLines, type LineCursor } from '../transcript-lines';

export interface ConversationSnapshot {
  key: string; pending: boolean; entries: readonly Entry[];
  /** Bumped with every change; versionOf(n) is the seq an entry last changed at. */
  seq: number; versionOf(n: number): number;
  running: ReturnType<ConversationParser['running']>;
}

/** The transcript can't be read: a symlink or a folder in its place, a read error. */
export class ConversationUnreadable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConversationUnreadable';
  }
}

export interface ConversationDeps {
  /** Where the terminal's session transcript is now (sessionTranscript with its config dir), or null. */
  transcriptOf(t: TerminalInfo): string | null;
  home: string | null;
  watch?(file: string, onChange: () => void): () => void;   // default: realHubFs.watch (background-fs.ts)
  timing?: { pollMs?: number; lingerMs?: number };            // 2000, 60_000
  log?(message: string): void;
}

/** b64url(SHA-256(terminal id, session id, epoch))[0..16]. */
export function conversationKey(terminalId: string, sessionId: string, epoch: number): string {
  return createHash('sha256').update(JSON.stringify([terminalId, sessionId, epoch])).digest('base64url').slice(0, 16);
}

interface Waiter { want: number; resolve(s: ConversationSnapshot): void; reject(e: unknown): void }

interface Follower {
  readonly id: string;
  /** The terminal as last heard of: from the list, a read or a subscribe. */
  t: TerminalInfo;
  /** The session id read last ('' while the terminal has none); null before the first read. */
  sid: string | null;
  /** What the key is made of: a session id ('' for a conversation that started with none) and an epoch. */
  base: string;
  epoch: number;
  key: string;
  file: string | null;
  /** Null: the next read starts from the start with a fresh parser, compared with `entries`. */
  parser: ConversationParser | null;
  cursor: LineCursor | null;
  /** The entries the last read gave, kept while the file is missing or unreadable to compare the next read with. */
  entries: readonly Entry[];
  /** versions[n - 1]: the seq entry n last changed at. */
  versions: number[];
  pending: boolean;
  failed: boolean;
  seq: number;
  /** The key and `pending` as of the last change. */
  told: { key: string; pending: boolean };
  subs: Set<{ onChange(): void }>;
  watched: string | null;
  unwatch: (() => void) | null;
  /** The file was read again from the start: perhaps another file at the same path, watched again. */
  rewatch: boolean;
  poll: ReturnType<typeof setInterval> | null;
  linger: ReturnType<typeof setTimeout> | null;
  /** One read at a time: a cue during a read sets `again`, read once it ends. `runs` counts the reads started. */
  reading: boolean;
  again: boolean;
  runs: number;
  waiters: Waiter[];
  gone: boolean;
}

const sameEntry = (a: Entry, b: Entry) => a === b || JSON.stringify(a) === JSON.stringify(b);
/**
 * The epoch of a conversation that started with no session id (its key's session id is ''): the time now, always later
 * than the last one, so not a key the terminal had before (between followers, the clock has moved on).
 */
const nextStamp = (last: number) => Math.max(Date.now(), last + 1);
const codeOf = (e: unknown) => (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null);

export class ConversationBook {
  private readonly followers = new Map<string, Follower>();
  private readonly watch: (file: string, onChange: () => void) => () => void;
  private readonly pollMs: number;
  private readonly lingerMs: number;
  private disposed = false;

  constructor(private readonly d: ConversationDeps) {
    this.watch = d.watch ?? realHubFs.watch;
    this.pollMs = d.timing?.pollMs ?? 2000;
    this.lingerMs = d.timing?.lingerMs ?? 60_000;
  }

  /** Every terminal list: news for followed sessions (updatedAt moved), new session ids, terminals gone. */
  terminals(list: readonly TerminalInfo[]): void {
    const byId = new Map(list.map((t) => [t.id, t]));
    for (const f of [...this.followers.values()]) {
      const t = byId.get(f.id);
      if (!t) { this.drop(f); continue; }
      const news = (t.session?.sessionId ?? '') !== (f.t.session?.sessionId ?? '') || t.session?.updatedAt !== f.t.session?.updatedAt;
      f.t = t;
      if (news && f.subs.size > 0) this.kick(f);
    }
  }

  /** Calls onChange after each change of that terminal's conversation; returns the unsubscribe. */
  subscribe(t: TerminalInfo, onChange: () => void): () => void {
    if (this.disposed) return () => {};
    const f = this.follower(t);
    const sub = { onChange };
    f.subs.add(sub);
    if (f.subs.size === 1) {
      this.stopLinger(f);
      f.poll = setInterval(() => this.kick(f), this.pollMs);
      this.syncWatch(f);
      // What was written while nobody followed it.
      this.kick(f);
    }
    return () => {
      if (!f.subs.delete(sub) || f.subs.size > 0 || f.gone) return;
      if (f.poll) clearInterval(f.poll);
      f.poll = null;
      this.syncWatch(f);
      this.startLinger(f);
    };
  }

  /** Reads to the end of the transcript now; rejects ConversationUnreadable (a symlink, a folder, a read error). */
  read(t: TerminalInfo): Promise<ConversationSnapshot> {
    if (this.disposed) return Promise.reject(new Error('The conversations are closed'));
    const f = this.follower(t);
    if (f.subs.size === 0) this.startLinger(f);
    // Answered by the first read that starts after this call: one under way may have missed what was just written.
    return new Promise((resolve, reject) => {
      f.waiters.push({ want: f.runs + 1, resolve, reject });
      this.kick(f);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const f of [...this.followers.values()]) this.drop(f);
  }

  private follower(t: TerminalInfo): Follower {
    const known = this.followers.get(t.id);
    if (known) { known.t = t; return known; }
    const f: Follower = {
      id: t.id, t, sid: null, base: '', epoch: 0, key: '', file: null, parser: null, cursor: null, entries: [], versions: [],
      pending: true, failed: false, seq: 0, told: { key: '', pending: true }, subs: new Set(), watched: null, unwatch: null,
      rewatch: false, poll: null, linger: null, reading: false, again: false, runs: 0, waiters: [], gone: false
    };
    this.followers.set(t.id, f);
    return f;
  }

  private kick(f: Follower): void {
    if (f.reading) { f.again = true; return; }
    f.reading = true;
    void this.loop(f);
  }

  private async loop(f: Follower): Promise<void> {
    do {
      f.again = false;
      const run = ++f.runs;
      let error: unknown = null;
      try { await this.readOnce(f); } catch (e) { error = e; }
      this.syncWatch(f);
      const ready = f.waiters.filter((w) => w.want <= run);
      if (ready.length === 0) continue;
      f.waiters = f.waiters.filter((w) => w.want > run);
      // Taken now, before another read can start: the snapshot is the state this read left.
      const snap = error === null ? this.snapshot(f) : null;
      for (const w of ready) if (snap) w.resolve(snap); else w.reject(error);
    } while (f.again);
    f.reading = false;
  }

  private async readOnce(f: Follower): Promise<void> {
    this.followSession(f);
    let changed: readonly number[] = [];
    try {
      const file = f.t.session ? this.d.transcriptOf(f.t) : null;
      // Another path (Claude Code moved the file into a worktree's folder): read from the start, compared.
      if (file !== f.file) { f.file = file; f.parser = null; f.cursor = null; }
      if (file === null) {
        f.pending = true;
      } else {
        let fresh = f.parser === null;
        let parser = f.parser ?? this.parser(f);
        const end = await readJsonLines(file, f.cursor, (line) => parser.push(line), undefined, (fromStart) => {
          // Shorter than what was read: another file, read from the start with a fresh parser and compared.
          if (fromStart && !fresh) { parser = this.parser(f); fresh = true; f.rewatch = true; }
        });
        f.parser = parser;
        f.cursor = { offset: end.offset, size: end.size, partial: end.partial };
        f.pending = false;
        changed = fresh ? this.compare(f, parser) : parser.takeChanged();
        f.entries = parser.entries;
      }
      f.failed = false;
    } catch (e) {
      // The parser goes: the next read starts from the start, compared with the entries read before.
      f.parser = null;
      f.cursor = null;
      const code = codeOf(e);
      if (code !== 'ENOENT') {
        if (!f.failed) this.d.log?.(`conversations: terminal ${f.id}: the transcript can't be read (${code ?? (e instanceof Error ? e.message : 'error')})`);
        f.failed = true;
        throw new ConversationUnreadable('The conversation can\'t be read', { cause: e });
      }
      f.pending = true;
      f.failed = false;
    }
    this.settle(f, changed);
  }

  /**
   * The terminal's session as the conversation follows it. Another session id is another conversation: its own key
   * (epoch 0 of that id), read from nothing. A terminal with no session id (Claude starting) is pending under a key
   * of its own, which the first id it gets keeps: that session's entries follow under it.
   */
  private followSession(f: Follower): void {
    const sid = f.t.session?.sessionId ?? '';
    if (sid === f.sid) return;
    const was = f.sid;
    f.sid = sid;
    if (was === '' && sid !== '') return;
    f.base = sid;
    f.epoch = sid === '' ? nextStamp(f.epoch) : 0;
    f.key = conversationKey(f.id, f.base, f.epoch);
    f.file = null;
    f.parser = null;
    f.cursor = null;
    f.entries = [];
    f.versions = [];
    f.pending = true;
  }

  /**
   * A transcript read from the start against what was read before: the same conversation when every entry read
   * before has the same kind at its `n` (then the entries that differ, and the new ones, are what changed); else a
   * new key, every entry new.
   */
  private compare(f: Follower, parser: ConversationParser): number[] {
    parser.takeChanged();
    const old = f.entries;
    const now = parser.entries;
    if (old.length > now.length || old.some((e, i) => now[i]!.k !== e.k)) {
      f.epoch = f.base === '' ? nextStamp(f.epoch) : f.epoch + 1;
      f.key = conversationKey(f.id, f.base, f.epoch);
      return now.map((e) => e.n);
    }
    return now.filter((e, i) => i >= old.length || !sameEntry(e, old[i]!)).map((e) => e.n);
  }

  /** One change, if this read made one: a new seq for what changed, every subscriber told once. */
  private settle(f: Follower, changed: readonly number[]): void {
    const keyed = f.key !== f.told.key;
    if (!keyed && f.pending === f.told.pending && changed.length === 0) return;
    f.seq += 1;
    if (keyed) f.versions = f.entries.map(() => f.seq);
    else for (const n of changed) f.versions[n - 1] = f.seq;
    f.told = { key: f.key, pending: f.pending };
    for (const s of [...f.subs]) {
      try { s.onChange(); } catch (e) { this.d.log?.(`conversations: a subscriber failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  private snapshot(f: Follower): ConversationSnapshot {
    const entries = f.pending ? [] : f.entries.slice();
    const versions = f.versions.slice(0, entries.length);
    return {
      key: f.key, pending: f.pending, entries, seq: f.seq,
      versionOf: (n) => versions[n - 1] ?? 0,
      running: !f.pending && f.parser ? f.parser.running() : []
    };
  }

  private parser(f: Follower): ConversationParser {
    return new ConversationParser({ projectRoot: f.t.projectRoot, home: this.d.home });
  }

  /** The watch follows the file read last, while someone is subscribed and the file is there. */
  private syncWatch(f: Follower): void {
    const want = !f.gone && f.subs.size > 0 && !f.pending && !f.failed ? f.file : null;
    if (want === f.watched && !(want !== null && f.rewatch)) return;
    f.rewatch = false;
    f.unwatch?.();
    f.unwatch = null;
    f.watched = want;
    if (want !== null) f.unwatch = this.watch(want, () => { if (!f.gone && f.watched === want) this.kick(f); });
  }

  private startLinger(f: Follower): void {
    this.stopLinger(f);
    f.linger = setTimeout(() => { if (f.subs.size === 0) this.drop(f); }, this.lingerMs);
  }

  private stopLinger(f: Follower): void {
    if (f.linger) clearTimeout(f.linger);
    f.linger = null;
  }

  private drop(f: Follower): void {
    f.gone = true;
    if (this.followers.get(f.id) === f) this.followers.delete(f.id);
    this.stopLinger(f);
    if (f.poll) clearInterval(f.poll);
    f.poll = null;
    f.subs.clear();
    this.syncWatch(f);
  }
}
