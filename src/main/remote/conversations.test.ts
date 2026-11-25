import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { ConversationBook, ConversationUnreadable, conversationKey } from './conversations';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const C = 'cccccccc-0000-4000-8000-00000000000c';
const KEY = /^[A-Za-z0-9_-]{16}$/;

const T = '2026-11-25T10:00:00.000Z';
const prompt = (text: string) => ({ type: 'user', timestamp: T, message: { role: 'user', content: text } });
const reply = (text: string) => ({ type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (id: string, command: string) => ({ type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const done = (id: string, out: string) => ({
  type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] }, toolUseResult: { stdout: out, stderr: '' }
});
const jsonl = (...lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

/** A Claude session (or a terminal still starting one, `session` null) in a terminal whose project is `root`. */
const term = (id: string, root: string, session: string | null, updatedAt = 1): TerminalInfo => ({
  id, projectRoot: root, cwd: root, title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 1,
  session: session === null ? null : { sessionId: session, state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt }
});

/** A book over a temp folder: each session's transcript at `<dir>/<id>.jsonl` unless `paths` moves it; the watch in memory. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'conversations-'));
  const paths = new Map<string, string>();
  const fileOf = (session: string) => paths.get(session) ?? join(dir, `${session}.jsonl`);
  const watches = new Map<string, Set<() => void>>();
  const log = vi.fn<(message: string) => void>();
  const transcriptOf = vi.fn((t: TerminalInfo) => (t.session ? fileOf(t.session.sessionId) : null));
  const book = new ConversationBook({
    transcriptOf, home: null, log,
    watch: (file, onChange) => {
      const set = watches.get(file) ?? new Set();
      watches.set(file, set);
      const own = () => onChange();
      set.add(own);
      return () => { set.delete(own); if (set.size === 0) watches.delete(file); };
    }
  });
  books.push(book);
  return {
    dir, paths, fileOf, book, log, transcriptOf,
    t: (id: string, session: string | null, updatedAt = 1) => term(id, dir, session, updatedAt),
    watched: () => [...watches.keys()],
    fire: (file: string) => { for (const f of [...(watches.get(file) ?? [])]) f(); }
  };
}

/** A subscriber that counts its calls; `next()` resolves at the next one. */
function heard() {
  let count = 0;
  let wake: (() => void) | null = null;
  return {
    on: () => { count++; const w = wake; wake = null; w?.(); },
    next: () => new Promise<void>((resolve) => { wake = resolve; }),
    get count() { return count; }
  };
}

const books: ConversationBook[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const b of books.splice(0)) b.dispose();
  vi.useRealTimers();
});

describe('ConversationBook', () => {
  test('a session\'s transcript as entries, then only what is appended; a line still being written waits', async () => {
    const s = setup();
    const t = s.t('t1', A);
    const file = s.fileOf(A);
    const result = JSON.stringify(done('b1', 'hello.txt'));
    writeFileSync(file, jsonl(prompt('List the files.'), reply('Sure.'), call('b1', 'ls')) + result.slice(0, 20));
    const one = await s.book.read(t);
    expect(one).toMatchObject({ key: conversationKey('t1', A, 0), pending: false });
    expect(one.key).toMatch(KEY);
    expect(one.entries.map((e) => [e.n, e.k])).toEqual([[1, 'prompt'], [2, 'reply'], [3, 'tool']]);
    expect(one.entries[2]).toMatchObject({ tool: 'Bash', target: 'ls', status: 'running' });
    expect(one.running).toEqual([expect.objectContaining({ n: 3, k: 'tool', tool: 'Bash' })]);
    expect([1, 2, 3].map((n) => one.versionOf(n))).toEqual([one.seq, one.seq, one.seq]);

    // Changed in place at the same length: a read from the start would see it, a read of what was appended doesn't.
    writeFileSync(file, readFileSync(file, 'utf8').replace('List the files.', 'List the FILES.'));
    appendFileSync(file, `${result.slice(20)}\n${jsonl(reply('One file.'))}`);
    const two = await s.book.read(t);
    expect(two.key).toBe(one.key);
    expect(two.seq).toBeGreaterThan(one.seq);
    expect(two.entries.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(two.entries[0]).toMatchObject({ k: 'prompt', text: 'List the files.' });
    expect(two.entries[2]).toMatchObject({ status: 'ok', detail: 'hello.txt' });
    expect(two.entries[3]).toMatchObject({ k: 'reply', text: 'One file.' });
    expect([1, 2, 3, 4].map((n) => two.versionOf(n))).toEqual([one.seq, one.seq, two.seq, two.seq]);
    expect(two.running).toEqual([]);
    // A snapshot stays as it was read.
    expect(one.entries).toHaveLength(3);
    expect(one.entries[2]).toMatchObject({ status: 'running' });
    // Nothing new: nothing changes.
    expect((await s.book.read(t)).seq).toBe(two.seq);
  });

  test('no transcript yet: pending, then its entries under the same key once Claude writes it', async () => {
    const s = setup();
    // Still starting: no session id yet.
    const starting = await s.book.read(s.t('t1', null));
    expect(starting).toMatchObject({ pending: true, entries: [], running: [] });
    expect(starting.key).toMatch(KEY);
    // Its id arrives before its transcript (Claude Code writes the file at the first prompt): the same key.
    const known = await s.book.read(s.t('t1', A));
    expect(known).toMatchObject({ key: starting.key, pending: true, entries: [] });
    writeFileSync(s.fileOf(A), jsonl(prompt('Hi.'), reply('Hello.')));
    const written = await s.book.read(s.t('t1', A));
    expect(written).toMatchObject({ key: starting.key, pending: false });
    expect(written.entries.map((e) => [e.n, e.k])).toEqual([[1, 'prompt'], [2, 'reply']]);
    // That key goes on like any other: a transcript that no longer continues it gets a new one, the clock unmoved.
    writeFileSync(s.fileOf(A), jsonl(reply('Else.')));
    const replaced = await s.book.read(s.t('t1', A));
    expect(replaced.key).toMatch(KEY);
    expect([starting.key, conversationKey('t1', A, 0), conversationKey('t1', A, 1)]).not.toContain(replaced.key);
    expect(replaced.entries).toEqual([expect.objectContaining({ n: 1, k: 'reply', text: 'Else.' })]);

    // A session known from the start, followed: the poll finds its file once written, under the key it had.
    const t2 = s.t('t2', B);
    const before = await s.book.read(t2);
    expect(before).toMatchObject({ key: conversationKey('t2', B, 0), pending: true, entries: [] });
    const l = heard();
    s.book.subscribe(t2, l.on);
    await s.book.read(t2);
    expect(s.watched()).toEqual([]);
    writeFileSync(s.fileOf(B), jsonl(prompt('Hi.')));
    const next = l.next();
    await vi.advanceTimersByTimeAsync(2000);
    await next;
    expect(await s.book.read(t2)).toMatchObject({ key: before.key, pending: false, entries: [{ n: 1, k: 'prompt', text: 'Hi.' }] });
    expect(s.watched()).toEqual([s.fileOf(B)]);
  });

  test('a new session id: a new key and its own entries from 1', async () => {
    const s = setup();
    writeFileSync(s.fileOf(A), jsonl(prompt('In A.'), reply('A replies.'), prompt('A again.')));
    const a = await s.book.read(s.t('t1', A));
    expect(a.key).toBe(conversationKey('t1', A, 0));
    expect(a.entries).toHaveLength(3);
    const l = heard();
    s.book.subscribe(s.t('t1', A), l.on);
    await s.book.read(s.t('t1', A));

    // `/clear` or a resume: another session id in the same terminal.
    const next = l.next();
    s.book.terminals([s.t('t1', B)]);
    await next;
    const b = await s.book.read(s.t('t1', B));
    expect(b.key).toBe(conversationKey('t1', B, 0));
    expect(b.key).not.toBe(a.key);
    expect(b).toMatchObject({ pending: true, entries: [] });
    writeFileSync(s.fileOf(B), jsonl(prompt('In B.')));
    const b2 = await s.book.read(s.t('t1', B));
    expect(b2).toMatchObject({ key: b.key, pending: false, entries: [{ n: 1, k: 'prompt', text: 'In B.' }] });
    expect(b2.versionOf(1)).toBe(b2.seq);
    expect(b2.versionOf(2)).toBe(0);

    // Claude exits and another one starts in the terminal: a new key while it starts, kept once its id comes.
    const none = await s.book.read(s.t('t1', null));
    expect(none).toMatchObject({ pending: true, entries: [] });
    expect(none.key).toMatch(KEY);
    expect([a.key, b.key]).not.toContain(none.key);
    writeFileSync(s.fileOf(C), jsonl(prompt('In C.')));
    const c = await s.book.read(s.t('t1', C));
    expect(c).toMatchObject({ key: none.key, pending: false, entries: [{ n: 1, k: 'prompt', text: 'In C.' }] });
    expect(l.count).toBe(4);
    // And again, the clock unmoved: never a key this terminal had.
    const again = await s.book.read(s.t('t1', null));
    expect(again).toMatchObject({ pending: true, entries: [] });
    expect([a.key, b.key, none.key]).not.toContain(again.key);
  });

  test('a transcript replaced by a shorter one that doesn\'t continue it: a new key; a moved one that does: the same', async () => {
    const s = setup();
    const t = s.t('t1', A);
    writeFileSync(s.fileOf(A), jsonl(prompt('First.'), reply('One.'), call('b1', 'ls')));
    s.book.subscribe(t, () => {});
    const one = await s.book.read(t);
    expect(s.watched()).toEqual([s.fileOf(A)]);

    // Moved to another folder (Claude Code entering a worktree), its call's result and a reply added: the same key,
    // and only the entries that changed count as changes. The watch follows the file.
    const moved = join(s.dir, 'worktree', `${A}.jsonl`);
    mkdirSync(dirname(moved));
    renameSync(s.fileOf(A), moved);
    appendFileSync(moved, jsonl(done('b1', 'a.txt'), reply('Two.')));
    s.paths.set(A, moved);
    const two = await s.book.read(t);
    expect(two.key).toBe(one.key);
    expect(two.entries.map((e) => e.k)).toEqual(['prompt', 'reply', 'tool', 'reply']);
    expect([1, 2, 3, 4].map((n) => two.versionOf(n))).toEqual([one.seq, one.seq, two.seq, two.seq]);
    expect(s.watched()).toEqual([moved]);

    // Rewritten shorter with the same entries, one output shorter: the same key, only that entry changed.
    writeFileSync(moved, jsonl(prompt('First.'), reply('One.'), call('b1', 'ls'), done('b1', 'b'), reply('Two.')));
    const three = await s.book.read(t);
    expect(three.key).toBe(one.key);
    expect(three.entries[2]).toMatchObject({ status: 'ok', detail: 'b' });
    expect([1, 2, 3, 4].map((n) => three.versionOf(n))).toEqual([one.seq, one.seq, three.seq, two.seq]);

    // Shorter and missing entries, the ones left alike: a new key.
    writeFileSync(moved, jsonl(prompt('First.'), reply('One.')));
    const four = await s.book.read(t);
    expect(four.key).not.toBe(one.key);
    expect(four.key).toMatch(KEY);
    expect(four.entries.map((e) => e.k)).toEqual(['prompt', 'reply']);
    expect([1, 2].map((n) => four.versionOf(n))).toEqual([four.seq, four.seq]);

    // Shorter, its first entry another kind: a new key again, its entries from 1.
    writeFileSync(moved, jsonl(reply('Another.')));
    const five = await s.book.read(t);
    expect([one.key, four.key]).not.toContain(five.key);
    expect(five.entries).toEqual([expect.objectContaining({ n: 1, k: 'reply', text: 'Another.' })]);
    expect(five.versionOf(1)).toBe(five.seq);

    // Moved again, to a longer file that doesn't continue it: read from its start, a new key.
    const other = join(s.dir, 'other', `${A}.jsonl`);
    mkdirSync(dirname(other));
    writeFileSync(other, jsonl(prompt('Elsewhere, from the first line.'), reply('Elsewhere.')));
    s.paths.set(A, other);
    const six = await s.book.read(t);
    expect([one.key, four.key, five.key]).not.toContain(six.key);
    expect(six.entries).toEqual([
      expect.objectContaining({ n: 1, k: 'prompt', text: 'Elsewhere, from the first line.' }),
      expect.objectContaining({ n: 2, k: 'reply', text: 'Elsewhere.' })
    ]);
    expect(s.watched()).toEqual([other]);
  });

  test('news comes from the terminal list, from the file watch and from the poll; subscribers hear each change once', async () => {
    const s = setup();
    const file = s.fileOf(A);
    writeFileSync(file, jsonl(prompt('Go.')));
    let t = s.t('t1', A, 1);
    await s.book.read(t);
    const one = heard();
    const two = heard();
    // Written while nobody followed: the first subscriber hears of it at once, not at the next cue.
    appendFileSync(file, jsonl(reply('Meanwhile.')));
    let next = one.next();
    const offOne = s.book.subscribe(t, one.on);
    await next;
    const offTwo = s.book.subscribe(t, two.on);
    await s.book.read(t);
    expect([one.count, two.count]).toEqual([1, 0]);

    // The terminal list: the followed session's updatedAt moved.
    appendFileSync(file, jsonl(reply('Going.')));
    next = one.next();
    s.book.terminals([t = s.t('t1', A, 2)]);
    await next;
    // The file watch.
    appendFileSync(file, jsonl(prompt('Again.')));
    next = one.next();
    s.fire(file);
    await next;
    // The poll.
    appendFileSync(file, jsonl(reply('Again.')));
    next = one.next();
    await vi.advanceTimersByTimeAsync(2000);
    await next;
    expect((await s.book.read(t)).entries.map((e) => e.n)).toEqual([1, 2, 3, 4, 5]);
    expect([one.count, two.count]).toEqual([4, 3]);

    // One change, many cues at once: heard once, each line read once (reads never overlap).
    appendFileSync(file, jsonl(prompt('Last.')));
    next = one.next();
    s.fire(file);
    s.fire(file);
    s.book.terminals([t = s.t('t1', A, 3)]);
    const reads = await Promise.all([s.book.read(t), s.book.read(t), vi.advanceTimersByTimeAsync(2000).then(() => s.book.read(t))]);
    await next;
    const all = [1, 2, 3, 4, 5, 6];
    expect(reads.map((r) => r.entries.map((e) => e.n))).toEqual([all, all, all]);
    expect([one.count, two.count]).toEqual([5, 4]);

    // A list with nothing new for it reads nothing.
    const reads0 = s.transcriptOf.mock.calls.length;
    s.book.terminals([t]);
    expect(s.transcriptOf.mock.calls.length).toBe(reads0);
    // Nobody subscribed any more: no watch, no poll, no read on the list's news.
    offOne();
    expect(s.watched()).toEqual([file]);
    offTwo();
    expect(s.watched()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    s.book.terminals([s.t('t1', A, 4)]);
    expect(s.transcriptOf.mock.calls.length).toBe(reads0);
    expect([one.count, two.count]).toEqual([5, 4]);
  });

  test('a symlink or a folder in the transcript\'s place is unreadable', async () => {
    const s = setup();
    const t = s.t('t1', A);
    const file = s.fileOf(A);
    writeFileSync(file, jsonl(prompt('Here.'), reply('Yes.')));
    const one = await s.book.read(t);
    // A symlink, even to a transcript: never followed.
    const elsewhere = join(s.dir, 'elsewhere.jsonl');
    writeFileSync(elsewhere, jsonl(prompt('Here.'), reply('Through a link.')));
    rmSync(file);
    symlinkSync(elsewhere, file);
    await expect(s.book.read(t)).rejects.toBeInstanceOf(ConversationUnreadable);
    rmSync(file);
    mkdirSync(file);
    await expect(s.book.read(t)).rejects.toBeInstanceOf(ConversationUnreadable);
    expect(s.log).toHaveBeenCalledTimes(1);
    expect(readFileSync(elsewhere, 'utf8')).toBe(jsonl(prompt('Here.'), reply('Through a link.')));

    // A regular file again: read from the start (its reply changed in place shows), compared with what was read before.
    rmSync(file, { recursive: true });
    writeFileSync(file, jsonl(prompt('Here.'), reply('Yes!'), prompt('More.')));
    const back = await s.book.read(t);
    expect(back).toMatchObject({ key: one.key, pending: false });
    expect(back.entries.map((e) => [e.k, 'text' in e ? e.text : null])).toEqual([['prompt', 'Here.'], ['reply', 'Yes!'], ['prompt', 'More.']]);
    expect([1, 2, 3].map((n) => back.versionOf(n))).toEqual([one.seq, back.seq, back.seq]);
  });

  test('a follower nobody follows or read for a minute goes, with its watch', async () => {
    const s = setup();
    const t = s.t('t1', A);
    writeFileSync(s.fileOf(A), jsonl(prompt('One.')));
    await s.book.read(t);
    appendFileSync(s.fileOf(A), jsonl(reply('Two.')));
    const kept = await s.book.read(t);
    expect(kept.seq).toBe(2);
    // Each read within the minute keeps the same follower: its seq goes on.
    await vi.advanceTimersByTimeAsync(59_000);
    expect((await s.book.read(t)).seq).toBe(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect((await s.book.read(t)).seq).toBe(2);
    // A minute with no read: dropped, the next read starts afresh (the same conversation, the same key).
    await vi.advanceTimersByTimeAsync(60_000);
    const fresh = await s.book.read(t);
    expect(fresh).toMatchObject({ seq: 1, key: kept.key });
    expect(fresh.entries).toHaveLength(2);

    // Followed for five minutes: kept all along. Then left: its watch goes at once, the follower a minute later.
    appendFileSync(s.fileOf(A), jsonl(prompt('Three.')));
    expect((await s.book.read(t)).seq).toBe(2);
    const off = s.book.subscribe(t, () => {});
    expect(s.watched()).toEqual([s.fileOf(A)]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.watched()).toEqual([s.fileOf(A)]);
    expect((await s.book.read(t)).seq).toBe(2);
    off();
    expect(s.watched()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await s.book.read(t)).toMatchObject({ seq: 1, key: kept.key });

    // A terminal gone from the list takes its follower at once, subscribed or not.
    const l = heard();
    s.book.subscribe(t, l.on);
    await s.book.read(t);
    expect(s.watched()).toEqual([s.fileOf(A)]);
    s.book.terminals([]);
    expect(s.watched()).toEqual([]);
    const reads = s.transcriptOf.mock.calls.length;
    appendFileSync(s.fileOf(A), jsonl(prompt('Four.')));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.transcriptOf.mock.calls.length).toBe(reads);
    expect(l.count).toBe(0);
    expect((await s.book.read(t)).seq).toBe(1);
  });
});
