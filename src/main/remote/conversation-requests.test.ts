import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Entry } from '@shared/conversation/types';
import type { TerminalInfo } from '@shared/protocol';
import { AnswerBook } from './answers';
import { PhoneConversations, SESSION_GAP_MS, type ConversationHost } from './conversation-requests';
import type { ConversationBook, ConversationSnapshot } from './conversations';
import type { HostMessage } from './messages';
import type { PromptOutbox } from './prompt-outbox';
import type { RemoteTerminals } from './remote-hub';
import { WaitBook } from './rows';

const claudeTerm = (id: string): TerminalInfo => ({
  id, projectRoot: '/work/app', cwd: '/work/app', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 1,
  session: { sessionId: 's', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 1 } as never
});
const entry = (n: number): Entry => ({ n, at: null, k: 'prompt', text: `Prompt ${n}.` });
const snap = (entries: Entry[]): ConversationSnapshot => ({ key: 'K'.repeat(16), pending: false, entries, seq: 1, versionOf: () => 1, running: [] });

/**
 * The conversations of one phone over a book whose reads wait until the test settles them, one at a time, and a send
 * that refuses `chat`s while `refuse` is set (as one too large for the channel would throw).
 */
function setup(opts: { chatMs?: number } = {}) {
  let list = [claudeTerm('a')];
  const reads: { resolve(s: ConversationSnapshot): void; reject(e: unknown): void }[] = [];
  /** What the book tells of a change, by its subscribers. */
  const changes: (() => void)[] = [];
  const book = {
    subscribe: (_t: TerminalInfo, onChange: () => void) => { changes.push(onChange); return () => {}; },
    read: () => new Promise<ConversationSnapshot>((resolve, reject) => { reads.push({ resolve, reject }); })
  } as unknown as ConversationBook;
  const sent: HostMessage[] = [];
  const o = { refuse: false };
  const log = vi.fn<(message: string) => void>();
  const statusChanged = vi.fn();
  const host: ConversationHost = {
    terminal: (id) => list.find((t) => t.id === id),
    listed: (id) => list.some((t) => t.id === id),
    claude: (id) => !!list.find((t) => t.id === id)?.session,
    asks: new WaitBook(), answers: new AnswerBook(), statusChanged, log
  };
  const c = new PhoneConversations({
    send: (m) => { if (o.refuse && m.t === 'chat') throw new Error('message too large'); sent.push(m); },
    host, terms: {} as RemoteTerminals, book, timing: { chatMs: opts.chatMs ?? 0, keyMs: 0, enterMs: 0, enterCapMs: 0, imageCapMs: 0, typingCapMs: 0 },
    outbox: {} as PromptOutbox, device: 'phone', images: { pathsOf: () => null, use: () => {} }
  });
  return { c, sent, reads, changes, log, o, statusChanged, setList: (l: TerminalInfo[]) => { list = l; c.terminalsChanged(l); } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const GONE = { t: 'error', code: 'not-found', message: 'This session is not on this computer any more.' };
const FAILED = { t: 'error', code: 'failed', message: 'The conversation can\'t be read. Open the terminal.' };

describe('PhoneConversations: every follow is answered', () => {
  test('the terminal leaves while its page is being read: not found, and nothing after', async () => {
    const s = setup();
    s.c.handle({ t: 'follow', rid: 1, id: 'a' });
    expect(s.reads).toHaveLength(1);
    s.setList([]);
    expect(s.sent).toEqual([{ ...GONE, rid: 1 }]);
    expect(s.c.followed.size).toBe(0);
    s.reads[0]!.resolve(snap([entry(1)]));
    await flush();
    expect(s.sent).toEqual([{ ...GONE, rid: 1 }]);
  });

  test('a second follow during a read that fails: both told, nothing followed', async () => {
    const s = setup();
    s.c.handle({ t: 'follow', rid: 1, id: 'a' });
    s.c.handle({ t: 'follow', rid: 2, id: 'a' });
    s.reads[0]!.reject(new Error('unreadable'));
    await flush();
    expect(s.sent).toEqual([{ ...FAILED, rid: 1 }, { ...FAILED, rid: 2 }]);
    expect(s.c.followed.size).toBe(0);
  });

  test('a page that can\'t go is logged and its follow told; an older page too', async () => {
    const s = setup();
    s.o.refuse = true;
    s.c.handle({ t: 'follow', rid: 1, id: 'a' });
    s.reads[0]!.resolve(snap([entry(1)]));
    await flush();
    expect(s.sent).toEqual([{ ...FAILED, rid: 1 }]);
    expect(s.log).toHaveBeenCalledWith('conversations: terminal a: message too large');
    expect(s.c.followed.size).toBe(0);
    s.c.handle({ t: 'follow', rid: 2, id: 'a', before: 5 });
    s.reads[1]!.resolve(snap([entry(1)]));
    await flush();
    expect(s.sent).toEqual([{ ...FAILED, rid: 1 }, { ...FAILED, rid: 2 }]);
    expect(s.log).toHaveBeenLastCalledWith('conversations: an older page of terminal a didn\'t go (message too large)');
  });
});

describe('PhoneConversations: a terminal with no Claude session', () => {
  afterEach(() => { vi.useRealTimers(); });
  const tick = () => vi.advanceTimersByTimeAsync(0);
  /** Terminal `a` with no session, `foreground` in front. */
  const sessionless = (foreground: string): TerminalInfo => ({ ...claudeTerm('a'), foreground, session: null });

  test('Claude still in front (between /clear\'s end and its next session): followed on; another session within the gap keeps it', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.c.handle({ t: 'follow', rid: 1, id: 'a' });
    s.reads[0]!.resolve(snap([entry(1)]));
    await tick();
    s.setList([sessionless('2.1.332')]);
    await vi.advanceTimersByTimeAsync(1000);
    // The next session, then its own end a second later: the gap counts from that end.
    s.setList([claudeTerm('a')]);
    await vi.advanceTimersByTimeAsync(1000);
    s.setList([sessionless('2.1.332')]);
    await vi.advanceTimersByTimeAsync(SESSION_GAP_MS - 1);
    expect(s.c.followed.has('a')).toBe(true);
    s.setList([claudeTerm('a')]);
    await vi.advanceTimersByTimeAsync(2 * SESSION_GAP_MS);
    expect(s.c.followed.has('a')).toBe(true);
  });

  test('Claude still in front but no session for the whole gap: the follow ends then, quietly; the shell in front ends it at once', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.c.handle({ t: 'follow', rid: 1, id: 'a' });
    s.reads[0]!.resolve(snap([entry(1)]));
    await tick();
    const sentBefore = s.sent.length;
    s.setList([sessionless('2.1.332')]);
    await vi.advanceTimersByTimeAsync(SESSION_GAP_MS - 1);
    expect(s.c.followed.has('a')).toBe(true);
    s.statusChanged.mockClear();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.c.followed.has('a')).toBe(false);
    expect(s.statusChanged).toHaveBeenCalledTimes(1);
    expect(s.sent).toHaveLength(sentBefore);
    // Followed again, then Claude exits: the shell in front, at once.
    s.setList([claudeTerm('a')]);
    s.c.handle({ t: 'follow', rid: 2, id: 'a' });
    s.reads[1]!.resolve(snap([entry(1)]));
    await tick();
    s.setList([sessionless('-zsh')]);
    expect(s.c.followed.has('a')).toBe(false);
  });

  test('one answer per follow: a failure while a follow waits is told to it alone, never to it twice', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.c.handle({ t: 'follow', rid: 1, id: 'a' });
    s.reads[0]!.resolve(snap([entry(1)]));
    await tick();
    // A change: its read is under way when a second follow comes; that read fails, the next one reads.
    s.changes[0]!();
    await tick();
    s.c.handle({ t: 'follow', rid: 2, id: 'a' });
    s.reads[1]!.reject(new Error('unreadable'));
    await tick();
    s.reads[2]!.resolve(snap([entry(1), entry(2)]));
    await tick();
    const answers = (rid: number) => s.sent.filter((m) => 'rid' in m && m.rid === rid).map((m) => m.t);
    expect(answers(1)).toEqual(['chat', 'error']);
    expect(answers(2)).toEqual(['chat']);
  });
});

describe('PhoneConversations: changes coalesce', () => {
  afterEach(() => { vi.useRealTimers(); });

  test('changes within chatMs of the last read go in one read and one message, nothing lost; later ones wait chatMs after it', async () => {
    vi.useFakeTimers();
    const s = setup({ chatMs: 200 });
    s.c.handle({ t: 'follow', rid: 1, id: 'a' });
    s.reads[0]!.resolve(snap([entry(1)]));
    await vi.advanceTimersByTimeAsync(0);
    // Ten changes 5 ms apart, the first right after the page went.
    for (let i = 0; i < 10; i++) {
      s.changes[0]!();
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(200 - 50 - 1);
    expect(s.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.reads).toHaveLength(2);
    const all = Array.from({ length: 11 }, (_, i) => entry(i + 1));
    s.reads[1]!.resolve({ ...snap(all), seq: 2, versionOf: (n) => (n > 1 ? 2 : 1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.sent.slice(1)).toEqual([{ t: 'chat', id: 'a', conversation: 'K'.repeat(16), entries: all.slice(1) }]);
    // One more change right after: its read waits for chatMs after the last one began.
    s.changes[0]!();
    await vi.advanceTimersByTimeAsync(199);
    expect(s.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.reads).toHaveLength(3);
  });
});
