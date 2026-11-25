import { describe, expect, test, vi } from 'vitest';
import type { Entry } from '@shared/conversation/types';
import type { TerminalInfo } from '@shared/protocol';
import { AnswerBook } from './answers';
import { PhoneConversations, type ConversationHost } from './conversation-requests';
import type { ConversationBook, ConversationSnapshot } from './conversations';
import type { HostMessage } from './messages';
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
function setup() {
  let list = [claudeTerm('a')];
  const reads: { resolve(s: ConversationSnapshot): void; reject(e: unknown): void }[] = [];
  const book = {
    subscribe: () => () => {},
    read: () => new Promise<ConversationSnapshot>((resolve, reject) => { reads.push({ resolve, reject }); })
  } as unknown as ConversationBook;
  const sent: HostMessage[] = [];
  const o = { refuse: false };
  const log = vi.fn<(message: string) => void>();
  const host: ConversationHost = {
    terminal: (id) => list.find((t) => t.id === id),
    listed: (id) => list.some((t) => t.id === id),
    claude: (id) => !!list.find((t) => t.id === id)?.session,
    asks: new WaitBook(), answers: new AnswerBook(), statusChanged: () => {}, log
  };
  const c = new PhoneConversations({
    send: (m) => { if (o.refuse && m.t === 'chat') throw new Error('message too large'); sent.push(m); },
    host, terms: {} as RemoteTerminals, book, timing: { chatMs: 0, keyMs: 0, enterMs: 0, enterCapMs: 0 }
  });
  return { c, sent, reads, log, o, setList: (l: TerminalInfo[]) => { list = l; c.terminalsChanged(l); } };
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
