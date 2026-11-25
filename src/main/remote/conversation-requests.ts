// What a phone asks of Claude sessions' conversations, with no terminal attached: following one as data (the entries
// ConversationBook reads from its transcript), the newest page first, then what Claude Code adds or changes as it
// writes, coalesced; an older page on request. Only sessions the state lists, Claude sessions only, at most
// MAX_FOLLOWED at once per phone. A followed session counts as open on the phone's badge in the windows.
import { chunks as entryChunks, pageOf } from '@shared/conversation/pages';
import type { Entry } from '@shared/conversation/types';
import type { TerminalInfo } from '@shared/protocol';
import type { AnswerBook } from './answers';
import type { ConversationBook, ConversationSnapshot } from './conversations';
import type { DeviceMessage, ErrorCode, HostMessage } from './messages';
import type { RemoteTerminals } from './remote-hub';
import type { WaitBook } from './rows';

/** Sessions one phone follows at once, at most. */
export const MAX_FOLLOWED = 16;

const UNREADABLE = 'The conversation can\'t be read. Open the terminal.';

export type ConversationRequest = Extract<DeviceMessage, { t: 'follow' | 'unfollow' | 'say' | 'stop' | 'escape' | 'dialog' | 'choose' }>;

/** What the conversations need of the hub. */
export interface ConversationHost {
  terminal(id: string): TerminalInfo | undefined;
  listed(id: string): boolean;
  /** A Claude session, or a terminal launched as one whose Claude is starting. */
  claude(id: string): boolean;
  /** The keys of every wait sessions are in (a row's `ask`). */
  asks: WaitBook;
  /** The answers given to waits, every phone's. */
  answers: AnswerBook;
  /** What the windows show of the phones may have changed (the sessions followed). */
  statusChanged(): void;
}

export interface ConversationTiming {
  /** A followed session's changes go at most this often (what comes in between goes together). */
  chatMs: number;
  /** Typing into a session: the pause between keys, before an Enter, and the longest an Enter waits for. */
  keyMs: number;
  enterMs: number;
  enterCapMs: number;
}

/** One followed session: what its phone holds of it, and the reads that send to it. */
interface Followed {
  readonly id: string;
  /** Ends the book's calls for it. */
  stop: () => void;
  /** The follow asked last: a transcript that stops reading while followed answers it. */
  rid: number;
  /** Follows waiting for the newest page. */
  asked: number[];
  /**
   * The key the phone holds, the book's seq its entries are as of, and whether it was told pending; null until the
   * first page went. A seq counts changes within the book's reading of the session, which this subscription keeps
   * going: a follow made anew (after an unfollow, or by a phone back) starts from its own page, never from a seq of
   * before.
   */
  sent: { key: string; seq: number; pending: boolean } | null;
  /** The phone was told the transcript can't be read (once, until it reads again). */
  failed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the last read for a send began: the next one waits for chatMs after it. */
  at: number;
  /** One read at a time: a change during one sets `again`. */
  busy: boolean;
  again: boolean;
  gone: boolean;
}

/** One phone's conversations. */
export class PhoneConversations {
  private readonly recs = new Map<string, Followed>();
  private disposed = false;

  constructor(private readonly o: {
    send(m: HostMessage): void;
    host: ConversationHost;
    terms: RemoteTerminals;
    book: ConversationBook;
    timing: ConversationTiming;
  }) {}

  /** The sessions followed now. */
  get followed(): ReadonlySet<string> { return new Set(this.recs.keys()); }

  handle(m: ConversationRequest): void {
    switch (m.t) {
      case 'follow': this.follow(m); return;
      case 'unfollow': {
        const rec = this.recs.get(m.id);
        if (!rec) return;
        this.drop(rec);
        this.o.host.statusChanged();
        return;
      }
      case 'say':
      case 'stop':
      case 'escape':
      case 'dialog':
      case 'choose':
        // Not served yet: answered as an Atelier that doesn't know them answers.
        this.error(m.rid, 'invalid', 'This message is not one Atelier understands.');
    }
  }

  /** Every terminal list: a followed session no longer in it is followed no more. */
  terminalsChanged(list: readonly TerminalInfo[]): void {
    const ids = new Set(list.map((t) => t.id));
    let left = false;
    for (const rec of [...this.recs.values()]) {
      if (ids.has(rec.id)) continue;
      this.drop(rec);
      left = true;
    }
    if (left) this.o.host.statusChanged();
  }

  dispose(): void {
    this.disposed = true;
    for (const rec of [...this.recs.values()]) this.drop(rec);
  }

  private follow(m: Extract<ConversationRequest, { t: 'follow' }>): void {
    const { rid, id } = m;
    const t = this.o.host.listed(id) ? this.o.host.terminal(id) : undefined;
    if (!t) { this.error(rid, 'not-found', 'This session is not on this computer any more.'); return; }
    if (!this.o.host.claude(id)) { this.error(rid, 'invalid', 'This is not a Claude session.'); return; }
    if (m.before !== undefined) {
      // A page older than what the phone shows: read, nothing followed by it.
      const before = m.before;
      this.o.book.read(t).then(
        (snap) => this.sendPage(id, snap, pageOf(snap.entries, before), rid),
        () => this.error(rid, 'failed', UNREADABLE)
      );
      return;
    }
    let rec = this.recs.get(id);
    if (!rec) {
      if (this.recs.size >= MAX_FOLLOWED) { this.error(rid, 'busy', 'Too many conversations open.'); return; }
      const r: Followed = { id, stop: () => {}, rid, asked: [], sent: null, failed: false, timer: null, at: 0, busy: false, again: false, gone: false };
      r.stop = this.o.book.subscribe(t, () => this.schedule(r));
      this.recs.set(id, r);
      this.o.host.statusChanged();
      rec = r;
    }
    rec.rid = rid;
    rec.asked.push(rid);
    this.run(rec);
  }

  /** A change: the next send at most chatMs after the last one began. */
  private schedule(rec: Followed): void {
    if (rec.gone || rec.timer) return;
    rec.timer = setTimeout(() => { rec.timer = null; this.run(rec); }, Math.max(0, rec.at + this.o.timing.chatMs - Date.now()));
    rec.timer.unref?.();
  }

  // A send that throws (no message here comes near the channel's limit) must not leave a rejection behind.
  private run(rec: Followed): void { void this.pump(rec).catch(() => {}); }

  /** Reads the conversation and sends what the phone lacks: the newest page to the follows waiting, else the changes. */
  private async pump(rec: Followed): Promise<void> {
    if (rec.busy) { rec.again = true; return; }
    rec.busy = true;
    try {
      do {
        rec.again = false;
        rec.at = Date.now();
        const asked = rec.asked.splice(0);
        // Always the terminal as listed now: the book follows its session by it.
        const t = this.o.host.terminal(rec.id);
        if (!t) return;
        let snap: ConversationSnapshot;
        try { snap = await this.o.book.read(t); } catch {
          if (!rec.gone) this.unreadable(rec, asked);
          continue;
        }
        if (rec.gone) return;
        if (asked.length > 0) this.answer(rec, snap, asked);
        else this.changes(rec, snap);
      } while (!rec.gone && (rec.again || rec.asked.length > 0));
    } finally {
      rec.busy = false;
    }
  }

  /** The follows waiting get the newest page; the phone holds it from now on. */
  private answer(rec: Followed, snap: ConversationSnapshot, asked: number[]): void {
    const page = pageOf(snap.entries);
    for (const rid of asked) this.sendPage(rec.id, snap, page, rid);
    rec.sent = { key: snap.key, seq: snap.seq, pending: snap.pending };
    rec.failed = false;
  }

  /** What changed since the phone's last message, as the conversation is now. */
  private changes(rec: Followed, snap: ConversationSnapshot): void {
    const sent = rec.sent;
    // The page that answers the follow is still to come: it holds it all.
    if (!sent) return;
    if (snap.key !== sent.key) {
      // Another conversation: its newest page, which replaces everything the phone holds.
      this.sendPage(rec.id, snap, pageOf(snap.entries));
    } else if (snap.pending) {
      // The transcript isn't there (moved, not written yet): said once, under the key the phone holds, which keeps
      // its entries; when it is back, only what changed comes.
      if (!sent.pending || rec.failed) this.sendPage(rec.id, snap, pageOf([]));
    } else if (rec.failed) {
      // Read again after the phone was told it can't be: the newest page, and what changed older than it.
      const page = pageOf(snap.entries);
      const first = page.entries[0]?.n ?? Infinity;
      this.sendEntries(rec.id, snap, [...snap.entries.filter((e) => e.n < first && snap.versionOf(e.n) > sent.seq), ...page.entries]);
    } else {
      this.sendEntries(rec.id, snap, snap.entries.filter((e) => snap.versionOf(e.n) > sent.seq));
    }
    rec.sent = { key: snap.key, seq: snap.seq, pending: snap.pending };
    rec.failed = false;
  }

  /**
   * The transcript can't be read: each follow waiting is told. A session followed already stays followed and is told
   * once (answering its follow); one that never got a page isn't followed (a refused follow is never unfollowed).
   */
  private unreadable(rec: Followed, asked: number[]): void {
    for (const rid of asked) this.error(rid, 'failed', UNREADABLE);
    if (!rec.sent) {
      this.drop(rec);
      this.o.host.statusChanged();
      return;
    }
    if (!rec.failed && asked.length === 0) this.error(rec.rid, 'failed', UNREADABLE);
    rec.failed = true;
  }

  /** A page (the answer to `rid`, or live): `start` when it holds entry 1, `pending` while there is no transcript. */
  private sendPage(id: string, snap: ConversationSnapshot, page: { entries: Entry[]; start: boolean }, rid?: number): void {
    this.send({
      t: 'chat', id, ...(rid !== undefined ? { rid } : {}), conversation: snap.key, entries: page.entries,
      ...(page.start ? { start: true as const } : {}), ...(snap.pending ? { pending: true as const } : {})
    });
  }

  /** Entries added or changed, in order of `n`, in as many messages as their size takes. */
  private sendEntries(id: string, snap: ConversationSnapshot, entries: Entry[]): void {
    for (const part of entryChunks(entries)) this.send({ t: 'chat', id, conversation: snap.key, entries: part });
  }

  private error(rid: number, code: ErrorCode, message: string): void {
    this.send({ t: 'error', rid, code, message });
  }

  private send(m: HostMessage): void {
    if (!this.disposed) this.o.send(m);
  }

  private drop(rec: Followed): void {
    rec.gone = true;
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    rec.stop();
    if (this.recs.get(rec.id) === rec) this.recs.delete(rec.id);
  }
}
