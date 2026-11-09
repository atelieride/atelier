import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DbActivity, DbOverview, DbResult } from '@shared/databases';
import {
  activityFor, addSample, askable, fmtDuration, fmtPct, fmtRate, fmtSize, foreignSql, isLong, maskForeignSql, NO_SAMPLES, OverviewPoller, ovLayout, POLL_MS,
  pushSample, rowStep, sessionMenu, shortVersion, sparkPoints, sqlSpans, stateTone, txRate, watchWindow, windowActive, wireOverview, type OvInputs
} from './overview';

// The overview tab's decisions: transactions per second from two samples,
// the last 30 of them, durations, the layout at every width, Mask values on the queries, which rows are long or can be
// asked about, and when it reads — every 5 s while shown in a focused window, one read at a time, paused on an error.

describe('txRate: commits + rollbacks per second between two polls', () => {
  test('the counter\'s delta over the seconds between the two reads', () => {
    expect(txRate({ xacts: 1000, at: 10_000 }, { xacts: 1710, at: 15_000 })).toBe(142);
    expect(txRate({ xacts: 0, at: 0 }, { xacts: 1, at: 4000 })).toBe(0.25);
  });
  test('no rate from one sample, from the same read twice, or across a stats reset', () => {
    expect(txRate(null, { xacts: 10, at: 1 })).toBeNull();
    expect(txRate({ xacts: 10, at: 5000 }, { xacts: 20, at: 5000 })).toBeNull();
    expect(txRate({ xacts: 10, at: 6000 }, { xacts: 20, at: 5000 })).toBeNull();
    expect(txRate({ xacts: 500, at: 0 }, { xacts: 20, at: 5000 })).toBeNull();
  });
});

describe('pushSample: the sparkline\'s last 30 samples', () => {
  test('appends, keeps the newest 30, never changes the series it was given', () => {
    const s = [1, 2, 3];
    expect(pushSample(s, 4)).toEqual([1, 2, 3, 4]);
    expect(s).toEqual([1, 2, 3]);
    const full = Array.from({ length: 30 }, (_, i) => i);
    const next = pushSample(full, 99);
    expect(next).toHaveLength(30);
    expect(next[0]).toBe(1);
    expect(next[29]).toBe(99);
    expect(pushSample([1, 2, 3], 4, 2)).toEqual([3, 4]);
  });
});

describe('addSample: one sample per read', () => {
  const ov = (xacts: number, at: number) => ({ xacts, at });
  test('the first read only remembers; the next ones add a rate to the series', () => {
    const a = addSample(NO_SAMPLES, ov(100, 0));
    expect(a.rate).toBeNull();
    expect(a.series).toEqual([]);
    const b = addSample(a, ov(600, 5000));
    expect(b.rate).toBe(100);
    expect(b.series).toEqual([100]);
    expect(addSample(b, ov(1100, 10_000)).series).toEqual([100, 100]);
  });
  test('the same shared read again (another window\'s, within main\'s 2 s) adds nothing', () => {
    const b = addSample(addSample(NO_SAMPLES, ov(100, 0)), ov(600, 5000));
    expect(addSample(b, ov(600, 5000))).toBe(b);
  });
  test('a stats reset: no rate until the next read, the series kept', () => {
    const b = addSample(addSample(NO_SAMPLES, ov(100, 0)), ov(600, 5000));
    const c = addSample(b, ov(3, 10_000));
    expect(c.rate).toBeNull();
    expect(c.series).toEqual([100]);
    expect(addSample(c, ov(53, 15_000)).rate).toBe(10);
  });
});

describe('fmtDuration', () => {
  test('the queries it is made for', () => {
    expect(fmtDuration(0.042)).toBe('42 ms');
    expect(fmtDuration(72)).toBe('1m 12s');
    expect(fmtDuration(243)).toBe('4m 03s');
    expect(fmtDuration(2 * 3600 + 5 * 60 + 9)).toBe('2h 5m');
  });
  test('seconds, a decimal under 10, days, and nothing negative', () => {
    expect(fmtDuration(0.0004)).toBe('0 ms');
    expect(fmtDuration(0.9996)).toBe('1s');
    expect(fmtDuration(1.5)).toBe('1.5s');
    expect(fmtDuration(8)).toBe('8s');
    expect(fmtDuration(42.7)).toBe('42s');
    expect(fmtDuration(60)).toBe('1m 00s');
    expect(fmtDuration(3600)).toBe('1h 0m');
    expect(fmtDuration(21 * 86400 + 3 * 3600 + 59)).toBe('21d 3h');
    expect(fmtDuration(-3)).toBe('0 ms');
    expect(fmtDuration(Number.NaN)).toBe('0 ms');
  });
  test('a session\'s time in its state: whole seconds from Postgres, under one second said so', () => {
    expect(activityFor(0)).toBe('<1s');
    expect(activityFor(72)).toBe('1m 12s');
    expect(activityFor(null)).toBe('—');
  });
});

describe('numbers as the tiles show them', () => {
  test('sizes as people read them', () => {
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(38 * 1024 * 1024)).toBe('38 MB');
    expect(fmtSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(fmtSize(820 * 1024 * 1024)).toBe('820 MB');
    expect(fmtSize(4.2 * 1024 ** 3)).toBe('4.2 GB');
    expect(fmtSize(3 * 1024 ** 4)).toBe('3 TB');
  });
  test('the cache hit ratio never rounds up to 100% it isn\'t', () => {
    expect(fmtPct(0.994)).toBe('99.4%');
    expect(fmtPct(0.99996)).toBe('99.9%');
    expect(fmtPct(1)).toBe('100%');
    expect(fmtPct(0.5)).toBe('50%');
    expect(fmtPct(null)).toBe('—');
  });
  test('transactions per second', () => {
    expect(fmtRate(0.2)).toBe('0.2');
    expect(fmtRate(3)).toBe('3');
    expect(fmtRate(141.6)).toBe('142');
    expect(fmtRate(1234)).toBe('1.2k');
    expect(fmtRate(null)).toBe('—');
  });
  test('the server version\'s number, without its build line', () => {
    expect(shortVersion('17.2')).toBe('17.2');
    expect(shortVersion('16.4 (Debian 16.4-1.pgdg120+2)')).toBe('16.4');
  });
});

describe('ovLayout: the overview at every width', () => {
  test('tiles go 5 → 3 → 2 → 1 columns; the last tile fills its row; the cards stack; the header\'s chips go under the name', () => {
    expect(ovLayout(1600)).toEqual({ cols: 5, lastSpan: 1, split: true, stacked: false });
    expect(ovLayout(900)).toEqual({ cols: 5, lastSpan: 1, split: true, stacked: false });
    expect(ovLayout(640)).toEqual({ cols: 3, lastSpan: 2, split: false, stacked: true });
    expect(ovLayout(430)).toEqual({ cols: 2, lastSpan: 2, split: false, stacked: true });
    expect(ovLayout(280)).toEqual({ cols: 1, lastSpan: 1, split: false, stacked: true });
  });
  test('not measured yet (hidden): one column', () => {
    expect(ovLayout(0).cols).toBe(1);
  });
});

describe('maskForeignSql: Mask values on SQL other sessions sent', () => {
  // Every literal goes; identifiers (bare and quoted), keywords, operators, casts and $n parameters stay.
  const CORPUS: [string, string][] = [
    ['SELECT * FROM cards WHERE card = 4111111111111111', 'SELECT * FROM cards WHERE card = ••••'],
    ['SELECT 1 WHERE x = 1e3 AND y = 1.5E-3 AND z = .5 AND w = 3.', 'SELECT •••• WHERE x = •••• AND y = •••• AND z = •••• AND w = ••••'],
    ['SELECT t1.id FROM t1 JOIN x2 ON x2.t1_id = t1.id WHERE t1.id = 42', 'SELECT t1.id FROM t1 JOIN x2 ON x2.t1_id = t1.id WHERE t1.id = ••••'],
    ["SELECT $$secret$$, $fn$ it's $x$ 42 $fn$ FROM t", 'SELECT $$••••$$, $fn$••••$fn$ FROM t'],
    ["WHERE note = E'a\\'b' AND k = 1", "WHERE note = E'••••' AND k = ••••"],
    ["WHERE x = e'\\\\' AND y = 'z'", "WHERE x = E'••••' AND y = '••••'"],
    ['WHERE "col2" = \'x@y.z\' AND "a""b" = 7', 'WHERE "col2" = \'••••\' AND "a""b" = ••••'],
    ["WHERE name = 'it''s' AND kind = 'a'", "WHERE name = '••••' AND kind = '••••'"],
    ['WHERE id = $1 AND k = $12 AND j = $3::int', 'WHERE id = $1 AND k = $12 AND j = $3::int'],
    ["SELECT data #> ARRAY['secret','key'], data #>> '{a,0}' FROM t", "SELECT data #> ARRAY['••••','••••'], data #>> '••••' FROM t"],
    ["SELECT '2024-01-01'::date, 42::int8, x::float4", "SELECT '••••'::date, ••••::int8, x::float4"],
    ['WHERE x = -42 AND y = 0x1F AND z = 1_000 AND b = 0b101 AND o = 0o17', 'WHERE x = -•••• AND y = •••• AND z = •••• AND b = •••• AND o = ••••'],
    ['SELECT a$b$, t$1, café1, _2 FROM x2', 'SELECT a$b$, t$1, café1, _2 FROM x2'],
    ["WHERE b = B'0101' AND u = U&'d\\0061t' AND n = N'x'", "WHERE b = B'••••' AND u = U&'••••' AND n = N'••••'"],
    ['SELECT x[1:2], y[3] FROM t', 'SELECT x[••••:••••], y[••••] FROM t'],
    // Comments are masked whole — they can carry values, and their quotes must never shift the scanner.
    ["/* controller='users',id=7 */ SELECT 1", '/* •••• */ SELECT ••••'],
    ["/* it's */ SELECT 'a'", "/* •••• */ SELECT '••••'"],
    ["-- it's\nWHERE a = 'secret'", "-- ••••\nWHERE a = '••••'"],
    ['-- "x\nWHERE b = 42', '-- ••••\nWHERE b = ••••'],
    ["/* it's */ 'secret'", "/* •••• */ '••••'"],
    ["/* a /* nested */ 'x' */ 'y'", "/* •••• */ '••••'"],
    ["SELECT 1 /* never closed 'z", 'SELECT •••• /* •••• */'],
    ['SELECT id FROM users -- jane@acme.test', 'SELECT id FROM users -- ••••'],
    ["WHERE a = '--not a comment' AND b = '/* nor this */' AND c = 1", "WHERE a = '••••' AND b = '••••' AND c = ••••"],
    ['SELECT "a--b", $$ -- x $$ FROM t', 'SELECT "a--b", $$••••$$ FROM t'],
    ['INSERT INTO t ("v1", v2) VALUES (12.50, true, NULL)', 'INSERT INTO t ("v1", v2) VALUES (••••, true, NULL)']
  ];
  test.each(CORPUS)('%s', (sql, masked) => {
    expect(maskForeignSql(sql)).toBe(masked);
  });
  test('a query cut mid-literal (main keeps 300 characters) is masked to the end', () => {
    expect(maskForeignSql("UPDATE users SET token = 'abcdef")).toBe("UPDATE users SET token = '••••'");
    expect(maskForeignSql("WHERE a = E'abc\\'")).toBe("WHERE a = E'••••'");
    expect(maskForeignSql('SELECT $$abcdef')).toBe('SELECT $$••••$$');
    expect(maskForeignSql('SELECT $t$abc $t')).toBe('SELECT $t$••••$t$');
    expect(maskForeignSql('WHERE card = 41111111')).toBe('WHERE card = ••••');
    // A name cut short is still a name.
    expect(maskForeignSql('SELECT "unfinished')).toBe('SELECT "unfinished');
  });
  test('nothing of a value survives anywhere in the corpus', () => {
    for (const [sql] of CORPUS) {
      const out = maskForeignSql(sql);
      for (const secret of ['4111', 'secret', 'x@y.z', "it''s", '2024', '1e3', '0x1F', '12.50', 'users\'', 'jane@', "'x'", "'z", 'it\'s']) {
        if (sql.includes(secret)) expect(out, sql).not.toContain(secret);
      }
    }
  });
  test('foreignSql: Mask values off shows the text as it is', () => {
    const q = "SELECT * FROM users WHERE email = 'a@b.c' LIMIT 20";
    expect(foreignSql(q, false)).toBe(q);
    expect(foreignSql(q, true)).toBe("SELECT * FROM users WHERE email = '••••' LIMIT ••••");
  });
});

describe('sqlSpans: the query on one line, its keywords, strings and numbers tinted', () => {
  test('keywords, strings, numbers and the rest, all of the text in order', () => {
    const s = sqlSpans("SELECT * FROM orders WHERE id = 20 AND note = 'x'");
    expect(s.map((p) => p.text).join('')).toBe("SELECT * FROM orders WHERE id = 20 AND note = 'x'");
    expect(s.filter((p) => p.kind === 'kw').map((p) => p.text)).toEqual(['SELECT', 'FROM', 'WHERE', 'AND']);
    expect(s.filter((p) => p.kind === 'str').map((p) => p.text)).toEqual(["'x'"]);
    expect(s.filter((p) => p.kind === 'num').map((p) => p.text)).toEqual(['20']);
  });
  test('names that look like keywords inside identifiers stay plain; lower case keywords count', () => {
    const s = sqlSpans('select order_id from "select" where t1.x = $1');
    expect(s.filter((p) => p.kind === 'kw').map((p) => p.text)).toEqual(['select', 'from', 'where']);
    expect(s.filter((p) => p.kind === 'num')).toEqual([]);
  });
});

describe('sessions in Now running', () => {
  const a = (o: Partial<DbActivity>): DbActivity => ({ pid: 1, role: 'app', app: 'api', state: 'active', seconds: 0, query: 'SELECT 1', ours: false, ...o });
  test('✦ Ask Claude: an active query over 5 s that Postgres shows, never ours', () => {
    expect(askable(a({ seconds: 6 }))).toBe(true);
    expect(askable(a({ seconds: 5 }))).toBe(false);
    expect(askable(a({ seconds: 60, state: 'idle in transaction' }))).toBe(false);
    expect(askable(a({ seconds: 60, query: null }))).toBe(false);
    expect(askable(a({ seconds: 60, ours: true }))).toBe(false);
  });
  test('long: active or idle in a transaction over 30 s', () => {
    expect(isLong(a({ seconds: 31 }))).toBe(true);
    expect(isLong(a({ seconds: 30 }))).toBe(false);
    expect(isLong(a({ seconds: 243, state: 'idle in transaction' }))).toBe(true);
    expect(isLong(a({ seconds: 243, state: 'idle in transaction (aborted)' }))).toBe(true);
    expect(isLong(a({ seconds: 900, state: 'idle' }))).toBe(false);
    expect(isLong(a({ seconds: 900, ours: true }))).toBe(false);
  });
  test('the state chip\'s tone: ours, working, waiting in a transaction, the rest quiet', () => {
    expect(stateTone(a({ ours: true }))).toBe('ours');
    expect(stateTone(a({}))).toBe('sky');
    expect(stateTone(a({ state: 'idle in transaction' }))).toBe('amber');
    expect(stateTone(a({ state: 'idle' }))).toBe('grey');
    expect(stateTone(a({ state: null }))).toBe('grey');
  });
});

test('sparkPoints: the samples across the box, scaled to their peak with headroom; one sample draws nothing', () => {
  expect(sparkPoints([5], 100, 20)).toBe('');
  const pts = sparkPoints([0, 10], 100, 20).split(' ');
  expect(pts).toHaveLength(2);
  expect(pts[0]).toBe('1.5,18.5');
  expect(Number(pts[1]!.split(',')[0])).toBe(98.5);
  // The peak sits below the top (headroom), never above it.
  expect(Number(pts[1]!.split(',')[1])).toBeGreaterThan(1.5);
});

describe('the window in front', () => {
  test('focused and visible', () => {
    expect(windowActive({ hasFocus: () => true, visibilityState: 'visible' })).toBe(true);
    expect(windowActive({ hasFocus: () => false, visibilityState: 'visible' })).toBe(false);
    expect(windowActive({ hasFocus: () => true, visibilityState: 'hidden' })).toBe(false);
  });
  test('watchWindow listens to focus, blur and visibility, and lets go of all three', () => {
    const win = new EventTarget();
    const doc = new EventTarget();
    const on = vi.fn();
    const stop = watchWindow(win, doc, on);
    win.dispatchEvent(new Event('focus'));
    win.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(on).toHaveBeenCalledTimes(3);
    stop();
    win.dispatchEvent(new Event('focus'));
    win.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(on).toHaveBeenCalledTimes(3);
  });
});

describe('OverviewPoller: when the overview reads', () => {
  const OV = { xacts: 1, at: 1 } as DbOverview;
  let replies: DbResult<DbOverview>[];
  let pending: ((r: DbResult<DbOverview>) => void)[];
  let read: ReturnType<typeof vi.fn>;
  let held: boolean;
  let p: OverviewPoller;
  const make = () => new OverviewPoller({
    read: read as unknown as () => Promise<DbResult<DbOverview>>,
    reply: (r) => replies.push(r),
    held: () => held,
    now: () => Date.now(),
    later: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
  });
  /** The read in flight answers. */
  const answer = async (r: DbResult<DbOverview> = { ok: true, value: OV }) => { pending.shift()!(r); await vi.advanceTimersByTimeAsync(0); };
  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    pending = [];
    held = false;
    read = vi.fn(() => new Promise<DbResult<DbOverview>>((res) => pending.push(res)));
    p = make();
  });
  afterEach(() => { p.dispose(); vi.useRealTimers(); });

  test('the first read on show, then every 5 s while shown in a focused window', async () => {
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(1);
    await answer();
    expect(replies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('one read in flight at a time: a slow server is never asked again before it answers', async () => {
    p.update({ shown: true, focused: true });
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    p.update({ shown: true, focused: false });
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(1);
    await answer();
    // The next one counts from the answer.
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('a window in the background: the read on show, no polling until it is in front again', async () => {
    p.update({ shown: true, focused: false });
    expect(read).toHaveBeenCalledTimes(1);
    await answer();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
    // In front again: the data is old, so at once; then every 5 s.
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('focus coming back early waits for the rest of the 5 s (focus flickers never hammer)', async () => {
    p.update({ shown: true, focused: true });
    await answer();
    await vi.advanceTimersByTimeAsync(2000);
    p.update({ shown: true, focused: false });
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('hidden: the timer stops; shown again with old data, it reads at once; with fresh data, it waits', async () => {
    p.update({ shown: true, focused: true });
    await answer();
    p.update({ shown: false, focused: true });
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    p.update({ shown: false, focused: true });
    await vi.advanceTimersByTimeAsync(1000);
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('an error pauses it: no more reads until Retry (no hammering a failing server)', async () => {
    p.update({ shown: true, focused: true });
    await answer({ ok: false, problem: { kind: 'refused', message: 'refused' } });
    expect(replies.at(-1)).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    p.update({ shown: false, focused: true });
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(1);
    p.retry();
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('the connection back after a failure (a password typed, the server up): it reads again — when shown, else on show', async () => {
    p.update({ shown: true, focused: true });
    await answer({ ok: false, problem: { kind: 'password', message: 'Needs a password' } });
    p.update({ shown: false, focused: true });
    p.resume();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(2);
    await answer({ ok: false, problem: { kind: 'other', message: 'x' } });
    // Shown: at once. Not paused: nothing to resume.
    p.resume();
    expect(read).toHaveBeenCalledTimes(3);
    await answer();
    p.resume();
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('a read that rejects (never got to main) is an error too, never a read waiting forever', async () => {
    read.mockImplementationOnce(() => Promise.reject(new Error('ipc')));
    p.update({ shown: true, focused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: false, problem: { kind: 'other' } });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('a connection the user disconnected is never read by itself, even when a timer was due', async () => {
    p.update({ shown: true, focused: true });
    await answer();
    held = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('held while a read is in flight: its reply is dropped; Connect reads once, right away', async () => {
    p.update({ shown: true, focused: true });
    held = true;
    p.drop();
    p.update({ shown: false, focused: true });
    // The user's Connect (the hold released first) while the dropped read is still out: one read, once that one is
    // back.
    held = false;
    p.retry();
    expect(read).toHaveBeenCalledTimes(1);
    await answer({ ok: false, problem: { kind: 'lost', message: 'Disconnected' } });
    expect(replies).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true });
  });

  test('stale replies are dropped: nothing reaches a disposed view', async () => {
    p.update({ shown: true, focused: true });
    p.dispose();
    await answer();
    expect(replies).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('a dropped read\'s answer counts for nothing: a hold released (from the sidebar) reads at once on show', async () => {
    p.update({ shown: true, focused: true });
    await answer();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    // Held while the second read is out: its answer comes back dropped.
    held = true;
    p.drop();
    p.update({ shown: false, focused: true });
    await answer();
    // Released elsewhere (no retry here): shown again, it reads at once — the dropped answer stamped nothing.
    held = false;
    p.update({ shown: true, focused: true });
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('Retry pressed while a read is out that then fails: their Retry still reads, the failure before it isn\'t shown', async () => {
    p.update({ shown: true, focused: true });
    p.retry();
    await answer({ ok: false, problem: { kind: 'timeout', message: 'No answer' } });
    expect(replies).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true });
    // Not paused: polling goes on.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('Retry while a read is in flight asks nothing more: that read\'s answer is the one', async () => {
    p.update({ shown: true, focused: true });
    p.retry();
    expect(read).toHaveBeenCalledTimes(1);
    await answer();
    expect(replies).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('wireOverview: the view\'s effects as one step (what OverviewView\'s effect calls when its inputs change)', () => {
  const OV = { xacts: 1, at: 1 } as DbOverview;
  let replies: DbResult<DbOverview>[];
  let pending: ((r: DbResult<DbOverview>) => void)[];
  let read: ReturnType<typeof vi.fn>;
  let held: boolean;
  let p: OverviewPoller;
  let last: OvInputs | null;
  const answer = async (r: DbResult<DbOverview> = { ok: true, value: OV }) => { pending.shift()!(r); await vi.advanceTimersByTimeAsync(0); };
  /** The component's inputs change: shown is visible, known and not held, as OverviewView computes it. */
  const wire = (o: Partial<OvInputs> & { visible?: boolean }) => {
    const base = last ?? { shown: false, focused: true, held: false, connState: 'connected' as const };
    const h = o.held ?? base.held;
    held = h;
    const next: OvInputs = { focused: o.focused ?? base.focused, held: h, connState: o.connState ?? base.connState, shown: (o.visible ?? true) && !h };
    wireOverview(p, last, next);
    last = next;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    pending = [];
    held = false;
    last = null;
    read = vi.fn(() => new Promise<DbResult<DbOverview>>((res) => pending.push(res)));
    p = new OverviewPoller({
      read: read as unknown as () => Promise<DbResult<DbOverview>>, reply: (r) => replies.push(r), held: () => held, now: () => Date.now(),
      later: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    });
  });
  afterEach(() => { p.dispose(); vi.useRealTimers(); });

  test('held → released starts a read, at once, even right after the last answer', async () => {
    wire({});
    expect(read).toHaveBeenCalledTimes(1);
    await answer();
    wire({ held: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    // The user's Connect (here or in the sidebar) a second after the last answer: a read now, not in 4 s.
    wire({ held: false });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('held: nothing reads, however long', async () => {
    wire({});
    await answer();
    wire({ held: true });
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('held while a read is out: its answer is dropped; released, it reads again', async () => {
    wire({});
    wire({ held: true });
    await answer({ ok: false, problem: { kind: 'lost', message: 'Disconnected' } });
    expect(replies).toEqual([]);
    wire({ held: false });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('connState → connected resumes after an error; a connection that stays connected changes nothing', async () => {
    wire({ connState: 'connected' });
    await answer({ ok: false, problem: { kind: 'password', message: 'Needs a password' } });
    wire({ connState: 'password' });
    expect(read).toHaveBeenCalledTimes(1);
    wire({ connState: 'connecting' });
    wire({ connState: 'connected' });
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    wire({ focused: false });
    wire({ focused: true });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('the window losing the focus stops the polling; hidden stops it too', async () => {
    wire({});
    await answer();
    wire({ focused: false });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    wire({ focused: true });
    expect(read).toHaveBeenCalledTimes(2);
    await answer();
    wire({ visible: false });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('Now running by keyboard: one row in the Tab order, arrows between rows, its menu on Shift+F10', () => {
  test('rowStep: ↓ ↑ Home End, held at the ends; other keys are not its', () => {
    expect(rowStep('ArrowDown', 0, 5)).toBe(1);
    expect(rowStep('ArrowDown', 4, 5)).toBe(4);
    expect(rowStep('ArrowUp', 0, 5)).toBe(0);
    expect(rowStep('ArrowUp', 3, 5)).toBe(2);
    expect(rowStep('Home', 3, 5)).toBe(0);
    expect(rowStep('End', 1, 5)).toBe(4);
    expect(rowStep('ArrowDown', -1, 5)).toBe(0);
    expect(rowStep('Enter', 1, 5)).toBeNull();
    expect(rowStep('ArrowDown', 0, 0)).toBeNull();
  });
  test('sessionMenu: Copy Query (the text as shown) and Copy pid; a query Postgres hides can\'t be copied', () => {
    const copied: string[] = [];
    const items = sessionMenu("SELECT '••••'", 48213, (s) => copied.push(s));
    expect(items.map((i) => (i === 'sep' ? i : `${i.label}${i.disabled ? ' (disabled)' : ''}`))).toEqual(['Copy Query', 'Copy pid']);
    for (const i of items) if (i !== 'sep') i.run();
    expect(copied).toEqual(["SELECT '••••'", '48213']);
    const hidden = sessionMenu(null, 7, () => {});
    expect(hidden[0]).toMatchObject({ label: 'Copy Query', disabled: true });
    // A statement (no session): its query only.
    expect(sessionMenu('SELECT 1', null, () => {}).map((i) => (i === 'sep' ? i : i.label))).toEqual(['Copy Query']);
  });
});

test('sqlSpans: a masked value reads as a value (tinted), quoted or bare', () => {
  const s = sqlSpans("WHERE card = •••• AND note = '••••'");
  expect(s.filter((p) => p.kind === 'num').map((p) => p.text)).toEqual(['••••']);
  expect(s.filter((p) => p.kind === 'str').map((p) => p.text)).toEqual(["'••••'"]);
});
