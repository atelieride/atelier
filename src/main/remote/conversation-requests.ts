// What a phone asks of Claude sessions' conversations, with no terminal attached: following one as data (the entries
// ConversationBook reads from its transcript), the newest page first, then what Claude Code adds or changes as it
// writes, coalesced; an older page on request. Only sessions the state lists, Claude sessions only, at most
// MAX_FOLLOWED at once per phone. A followed session counts as open on the phone's badge in the windows.
import { chunks as entryChunks, pageOf } from '@shared/conversation/pages';
import type { Entry } from '@shared/conversation/types';
import type { TerminalInfo } from '@shared/protocol';
import { isClaudeProcess } from '@shared/shells';
import type { AnswerBook } from './answers';
import type { ConversationBook, ConversationSnapshot } from './conversations';
import type { DeviceMessage, ErrorCode, HostMessage } from './messages';
import type { RemoteTerminals } from './remote-hub';
import type { WaitBook } from './rows';

/** Sessions one phone follows at once, at most. */
export const MAX_FOLLOWED = 16;
/**
 * A terminal with no Claude session while Claude is still in front of it (`/clear` ends one session and then starts
 * the next) stays followed this long, for the next session.
 */
export const SESSION_GAP_MS = 5000;

const UNREADABLE = 'The conversation can\'t be read. Open the terminal.';
const GONE = 'This session is not on this computer any more.';
const NOT_CLAUDE = 'This is not a Claude session.';

const codeOf = (e: unknown) => (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null);
/** An error for the log: its code when it has one (fs errors' messages hold paths), else its message. */
const reasonOf = (e: unknown) => codeOf(e) ?? (e instanceof Error ? e.message : 'error');

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
  log(message: string): void;
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
  /** The follow answered last with a page: a transcript that stops reading while followed answers it. */
  rid: number;
  /** Follows not answered yet, oldest first: each gets the newest page, or why not. */
  asked: number[];
  /**
   * The key the phone holds and the book's seq its entries are as of; null until the first page went. A seq counts
   * changes within the book's reading of the session, which this subscription keeps going: a follow made anew (after
   * an unfollow, or by a phone back) starts from its own page, never from a seq of before.
   */
  sent: { key: string; seq: number } | null;
  /** The phone was told the transcript can't be read (once, until it reads again). */
  failed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Running while the terminal has no Claude session but Claude is in front: the follow ends when it fires. */
  gap: ReturnType<typeof setTimeout> | null;
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
        // The phone stopped it: its follows still waiting need no answer.
        this.drop(rec, null);
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

  /**
   * Every terminal list: a followed session no longer in it, or one Claude has left (no session, and the shell or
   * another program in front), is followed no more. With no session but Claude still in front (between `/clear`'s end
   * and its next session), it stays followed for SESSION_GAP_MS. Nothing is sent of a follow that ends: the phone keeps
   * what it shows, and learns the rest from the session's row.
   */
  terminalsChanged(list: readonly TerminalInfo[]): void {
    const byId = new Map(list.map((t) => [t.id, t]));
    let left = false;
    for (const rec of [...this.recs.values()]) {
      const t = byId.get(rec.id);
      if (this.o.host.claude(rec.id)) { this.endGap(rec); continue; }
      if (!t) this.drop(rec, { code: 'not-found', message: GONE });
      else if (!isClaudeProcess(t.foreground)) this.drop(rec, { code: 'invalid', message: NOT_CLAUDE });
      else { this.startGap(rec); continue; }
      left = true;
    }
    if (left) this.o.host.statusChanged();
  }

  private startGap(rec: Followed): void {
    if (rec.gap) return;
    rec.gap = setTimeout(() => {
      rec.gap = null;
      if (rec.gone || this.o.host.claude(rec.id)) return;
      this.drop(rec, { code: 'invalid', message: NOT_CLAUDE });
      this.o.host.statusChanged();
    }, SESSION_GAP_MS);
    rec.gap.unref?.();
  }

  private endGap(rec: Followed): void {
    if (rec.gap) clearTimeout(rec.gap);
    rec.gap = null;
  }

  dispose(): void {
    this.disposed = true;
    for (const rec of [...this.recs.values()]) this.drop(rec, null);
  }

  private follow(m: Extract<ConversationRequest, { t: 'follow' }>): void {
    const { rid, id } = m;
    const t = this.o.host.listed(id) ? this.o.host.terminal(id) : undefined;
    if (!t) { this.error(rid, 'not-found', GONE); return; }
    if (!this.o.host.claude(id)) { this.error(rid, 'invalid', NOT_CLAUDE); return; }
    if (m.before !== undefined) {
      // A page older than what the phone shows: read, nothing followed by it.
      const before = m.before;
      this.o.book.read(t).then(
        (snap) => this.sendPage(id, snap, pageOf(snap.entries, before), rid),
        () => this.error(rid, 'failed', UNREADABLE)
      ).catch((e: unknown) => {
        this.o.host.log(`conversations: an older page of terminal ${id} didn't go (${reasonOf(e)})`);
        this.error(rid, 'failed', UNREADABLE);
      });
      return;
    }
    let rec = this.recs.get(id);
    if (!rec) {
      if (this.recs.size >= MAX_FOLLOWED) { this.error(rid, 'busy', 'Too many conversations open.'); return; }
      const r: Followed = { id, stop: () => {}, rid, asked: [], sent: null, failed: false, timer: null, gap: null, at: 0, busy: false, again: false, gone: false };
      r.stop = this.o.book.subscribe(t, () => this.schedule(r));
      this.recs.set(id, r);
      this.o.host.statusChanged();
      rec = r;
    }
    rec.asked.push(rid);
    this.run(rec);
  }

  /** A change: the next send at most chatMs after the last one began. */
  private schedule(rec: Followed): void {
    if (rec.gone || rec.timer) return;
    rec.timer = setTimeout(() => { rec.timer = null; this.run(rec); }, Math.max(0, rec.at + this.o.timing.chatMs - Date.now()));
    rec.timer.unref?.();
  }

  private run(rec: Followed): void {
    void this.pump(rec).catch((e: unknown) => this.o.host.log(`conversations: terminal ${rec.id}: ${reasonOf(e)}`));
  }

  /** Reads the conversation and sends what the phone lacks: the newest page to the follows waiting, else the changes. */
  private async pump(rec: Followed): Promise<void> {
    if (rec.busy) { rec.again = true; return; }
    rec.busy = true;
    try {
      do {
        rec.again = false;
        rec.at = Date.now();
        // The follows this read answers (those that come during it wait for the next one).
        const n = rec.asked.length;
        try {
          // Always the terminal as listed now: the book follows its session by it.
          const t = this.o.host.terminal(rec.id);
          if (!t) { this.drop(rec, { code: 'not-found', message: GONE }); this.o.host.statusChanged(); return; }
          let snap: ConversationSnapshot;
          try { snap = await this.o.book.read(t); } catch {
            if (!rec.gone) this.unreadable(rec, rec.asked.splice(0, n));
            continue;
          }
          if (rec.gone) return;
          // Waiting until answered: a page that can't go leaves them to be told so.
          if (n > 0) { this.answer(rec, snap, rec.asked.slice(0, n)); rec.asked.splice(0, n); } else this.changes(rec, snap);
        } catch (e) {
          // Never silence for a follow: those this read was for are refused as an unreadable one is.
          this.o.host.log(`conversations: terminal ${rec.id}: ${reasonOf(e)}`);
          const asked = rec.asked.splice(0, n);
          if (asked.length > 0 && !rec.gone) this.unreadable(rec, asked);
        }
      } while (!rec.gone && (rec.again || rec.asked.length > 0));
    } finally {
      rec.busy = false;
    }
  }

  /** The follows waiting get the newest page; the phone holds it from now on. */
  private answer(rec: Followed, snap: ConversationSnapshot, asked: number[]): void {
    const page = pageOf(snap.entries);
    for (const rid of asked) this.sendPage(rec.id, snap, page, rid);
    // One answer per follow: a later failure is told to one already answered, never to one still waiting.
    rec.rid = asked.at(-1) ?? rec.rid;
    rec.sent = { key: snap.key, seq: snap.seq };
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
    } else if (rec.failed && !snap.pending) {
      // Read again after the phone was told it can't be: the newest page, and what changed older than it.
      const page = pageOf(snap.entries);
      const first = page.entries[0]?.n ?? Infinity;
      this.sendEntries(rec.id, snap, [...snap.entries.filter((e) => e.n < first && snap.versionOf(e.n) > sent.seq), ...page.entries]);
    } else {
      // Under the key the phone holds (still pending: nothing, its entries come once the transcript is written).
      this.sendEntries(rec.id, snap, snap.entries.filter((e) => snap.versionOf(e.n) > sent.seq));
    }
    rec.sent = { key: snap.key, seq: snap.seq };
    rec.failed = false;
  }

  /**
   * The transcript can't be read. Follows asking for it are told, and the session isn't followed (a phone never
   * unfollows a refused follow): every follow still waiting is told too. A session only followed, no follow asking,
   * stays followed and is told once, answering its last follow; its entries come again once it reads.
   */
  private unreadable(rec: Followed, asked: number[]): void {
    for (const rid of asked) this.error(rid, 'failed', UNREADABLE);
    if (asked.length > 0) {
      this.drop(rec, { code: 'failed', message: UNREADABLE });
      this.o.host.statusChanged();
      return;
    }
    if (!rec.failed) this.error(rec.rid, 'failed', UNREADABLE);
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

  /** Followed no more; the follows still waiting are told why (none when the phone stopped it or is gone). */
  private drop(rec: Followed, why: { code: ErrorCode; message: string } | null): void {
    if (why) for (const rid of rec.asked) this.error(rid, why.code, why.message);
    rec.asked = [];
    rec.gone = true;
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    this.endGap(rec);
    rec.stop();
    if (this.recs.get(rec.id) === rec) this.recs.delete(rec.id);
  }
}
