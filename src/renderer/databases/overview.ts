// The database overview's decisions: transactions per second from two
// reads and the last 30 of them, durations, sizes and ratios as the tiles say them, the layout at every width, Mask
// values on the queries Postgres shows, which sessions are long or can be asked about, and when the overview reads —
// every 5 s while shown in a focused window, one read at a time, paused on an error. Pure but for the window it is
// handed; lazy, with the table tab's chunk.
import type { DbActivity, DbConnState, DbOverview, DbProblem, DbResult } from '@shared/databases';
import { tov } from '../i18n/db-overview';
import type { MenuItem } from '../menu-model';

/** Refreshed every 5 s while on screen in a focused window. */
export const POLL_MS = 5000;
/** The Longest query tile and a long session's row go amber past this. */
export const LONG_SEC = 30;
/** ✦ Ask Claude shows on an active query past this. */
export const ASK_SEC = 5;
/** The transactions sparkline's length. */
export const SPARK_MAX = 30;

/** One read's transaction counter (commits + rollbacks) and when main took it (ms). */
export interface TxSample { xacts: number; at: number }

/** Transactions per second between two reads; none from one read, from the same read twice or across a stats reset. */
export function txRate(prev: TxSample | null, next: TxSample): number | null {
  if (!prev) return null;
  const dt = (next.at - prev.at) / 1000;
  const dx = next.xacts - prev.xacts;
  return dt > 0 && dx >= 0 ? dx / dt : null;
}

/** The series with `v` at its end, its newest `max` kept (a new array: the one given never changes). */
export function pushSample(series: readonly number[], v: number, max = SPARK_MAX): number[] {
  return [...series, v].slice(-max);
}

/** The reads so far: the last one's counter, the rate it gave, the sparkline's samples. */
export interface OvSamples { readonly prev: TxSample | null; readonly rate: number | null; readonly series: readonly number[] }
export const NO_SAMPLES: OvSamples = Object.freeze({ prev: null, rate: null, series: Object.freeze([]) as readonly number[] });

/**
 * A read's sample. Main shares one read between windows asking within 2 s: the same read again (or an older one) adds
 * nothing. After a stats reset the rate is unknown until the next read; the line keeps what it had.
 */
export function addSample(s: OvSamples, o: TxSample): OvSamples {
  if (s.prev && o.at <= s.prev.at) return s;
  const next = { xacts: o.xacts, at: o.at };
  const rate = txRate(s.prev, next);
  return { prev: next, rate, series: rate === null ? s.series : pushSample(s.series, rate) };
}

/** What the overview shows: the last read, the last problem (a later read clears it), the samples. */
export interface OvState { readonly data: DbOverview | null; readonly problem: DbProblem | null; readonly samples: OvSamples }
export const EMPTY_OV: OvState = Object.freeze({ data: null, problem: null, samples: NO_SAMPLES });

/** A reply: new numbers and their sample, or the problem with the last numbers kept. */
export function ovReply(st: OvState, r: DbResult<DbOverview>): OvState {
  if (!r.ok) return { ...st, problem: r.problem };
  return { data: r.value, problem: null, samples: addSample(st.samples, r.value) };
}

/** '42 ms', '8s', '1.5s', '1m 12s', '4m 03s', '2h 5m', '21d 3h'. Seconds in; nothing negative. */
export function fmtDuration(sec: number): string {
  if (!(sec > 0)) return '0 ms';
  const ms = Math.round(sec * 1000);
  if (ms < 1000) return `${ms} ms`;
  if (sec < 10) return `${Math.round(sec * 10) / 10}s`;
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** A session's time in its state: whole seconds from Postgres (under one is "<1s"), none when Postgres has none. */
export function activityFor(sec: number | null): string {
  if (sec === null) return tov.noState;
  return sec < 1 ? tov.under : fmtDuration(sec);
}

/** A size as people read it: '512 B', '38 MB', '1.5 MB', '4.2 GB' (gigabytes and up keep a decimal). */
export function fmtSize(n: number): string {
  if (n < 1024) return `${Math.round(Math.max(0, n))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i >= 2 || v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ${units[i]}`;
}

/** The cache hit ratio, cut (never rounded up: 99.96% is not 100%). */
export function fmtPct(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return '—';
  const v = Math.floor(r * 1000 + 1e-9) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}

/** Transactions per second: a decimal under 10, thousands as 'k'. */
export function fmtRate(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return '—';
  if (r < 10) return String(Math.round(r * 10) / 10);
  if (r < 999.5) return String(Math.round(r));
  return `${Math.round(r / 100) / 10}k`;
}

/** server_version's number, without the build line some servers add ("16.4 (Debian 16.4-1.pgdg120+2)"). */
export function shortVersion(v: string): string {
  return v.trim().split(/\s+/)[0] ?? v;
}

/** A bar's length: its share of the biggest, one decimal (a table that has pages always shows a sliver). */
export function barPct(bytes: number, max: number): number {
  if (!(max > 0) || !(bytes > 0)) return 0;
  return Math.max(1, Math.round((bytes / max) * 1000) / 10);
}

/** The schemas' tables and views, all together. */
export function totals(schemas: DbOverview['schemas']): { tables: number; views: number } {
  return schemas.reduce((t, s) => ({ tables: t.tables + s.tables, views: t.views + s.views }), { tables: 0, views: 0 });
}

/**
 * The overview at a width: the tiles 5 → 3 → 2 → 1 columns, the last tile filling its row; the biggest
 * tables beside the schemas card or above it; the header's chips beside the name or under it. 0: not measured yet.
 */
export interface OvLayout { cols: 1 | 2 | 3 | 5; lastSpan: number; split: boolean; stacked: boolean }
export function ovLayout(width: number): OvLayout {
  const cols = width >= 860 ? 5 : width >= 560 ? 3 : width >= 380 ? 2 : 1;
  return { cols, lastSpan: cols - (4 % cols), split: width >= 760, stacked: width < 720 };
}

/** What Mask values leaves of a value. */
const DOTS = '••••';

/** The closing quote of the run opened at `i` (`q` doubled inside stays in it); -1 when the text ends first. */
function quotedEnd(s: string, i: number, q: string): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === q) {
      if (s[j + 1] !== q) return j;
      j += 2;
    } else j++;
  }
  return -1;
}

/** The closing quote of an escape string opened at `i` (E'…': a backslash escapes the next character); -1 when cut. */
function escapeEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') j += 2;
    else if (s[j] === "'") {
      if (s[j + 1] !== "'") return j;
      j += 2;
    } else j++;
  }
  return -1;
}

/** Past the block comment opened at `i` (/* … *\/, nested ones included); the text's end when it is never closed. */
function blockEnd(s: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    if (s[j] === '/' && s[j + 1] === '*') {
      depth++;
      j += 2;
    } else if (s[j] === '*' && s[j + 1] === '/') {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else j++;
  }
  return s.length;
}

// Postgres's lexer, as far as values go: names (bare: a letter, _ or any non-ASCII character first, then $ allowed;
// so t1, x2, a$b$ are names), $n parameters, dollar-quote tags, numeric constants (decimal with a fraction and an
// exponent, hex, octal, binary, _ separators).
const NAME_START = /[A-Za-z_\u0080-￿]/;
const NAME_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const PARAM = /\$\d+/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
const NUMBER = /0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?/y;
const matchAt = (re: RegExp, s: string, i: number): string | null => {
  re.lastIndex = i;
  return re.exec(s)?.[0] ?? null;
};

/**
 * SQL another session sent — Now running, the Longest query's tooltip, the slowest statements, what ✦ Ask Claude
 * hands over — with every value as dots: quoted strings, E'' strings, dollar-quoted
 * bodies, B'', X'', U&'' and N'' strings, numeric constants (also in ARRAY[…] paths and subscripts), and comments
 * whole (a line comment to the end of its line, a block comment nested or cut). Names (bare and quoted),
 * keywords, operators, casts and $n parameters stay. A text cut inside a value or a comment (main keeps 300
 * characters) is masked to its end. Not sqlFor: that one reads Atelier's own statements, whose numbers are paging.
 */
export function maskForeignSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    // Comments, masked whole: they can carry values, and their quotes never shift the scanner. A block
    // comment nests, and one never closed runs to the end; a line comment runs to the end of its line.
    if (ch === '/' && sql[i + 1] === '*') {
      out += `/* ${DOTS} */`;
      i = blockEnd(sql, i);
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      out += `-- ${DOTS}`;
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === "'") {
      const end = quotedEnd(sql, i, "'");
      out += `'${DOTS}'`;
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '"') {
      // A quoted name: kept whole, "" inside it too.
      const end = quotedEnd(sql, i, '"');
      const stop = end === -1 ? n : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // Names are read whole, so an E here starts a token: E'…' is an escape string.
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'") {
      const end = escapeEnd(sql, i + 1);
      out += `E'${DOTS}'`;
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(sql[j]!)) j++;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '$') {
      const param = matchAt(PARAM, sql, i);
      if (param) {
        out += param;
        i += param.length;
        continue;
      }
      const tag = matchAt(DOLLAR_TAG, sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        out += tag + DOTS + tag;
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    const num = /\d/.test(ch) || (ch === '.' && /\d/.test(sql[i + 1] ?? '')) ? matchAt(NUMBER, sql, i) : null;
    if (num) {
      out += DOTS;
      i += num.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Foreign SQL as shown: masked with Mask values on, as it is otherwise. */
export function foreignSql(q: string, masked: boolean): string {
  return masked ? maskForeignSql(q) : q;
}

export type SqlSpanKind = 'kw' | 'str' | 'num' | 'plain';
export interface SqlSpan { text: string; kind: SqlSpanKind }

const KEYWORDS = new Set(('SELECT FROM WHERE AND OR NOT NULL IS IN AS ON USING JOIN LEFT RIGHT INNER OUTER FULL CROSS LATERAL GROUP BY ORDER '
  + 'LIMIT OFFSET HAVING DISTINCT UNION INTERSECT EXCEPT ALL ANY INSERT INTO VALUES UPDATE SET DELETE RETURNING WITH RECURSIVE CASE WHEN '
  + 'THEN ELSE END LIKE ILIKE BETWEEN EXISTS ASC DESC NULLS BEGIN COMMIT ROLLBACK START TRANSACTION EXPLAIN ANALYZE VACUUM COPY CREATE '
  + 'ALTER DROP TABLE INDEX VIEW TRUNCATE GRANT REVOKE FETCH FOR LOCK SHOW TRUE FALSE CALL DO LISTEN NOTIFY REFRESH MATERIALIZED').split(' '));
const TOKEN = /('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\$\d+)|([A-Za-z_][\w$]*)|(\d+(?:\.\d+)?)|(•+)|([\s\S])/g;

/** A query cut into the parts that are tinted — keywords, strings, numbers (a masked bare value too) — and the rest. */
export function sqlSpans(q: string): SqlSpan[] {
  const out: SqlSpan[] = [];
  const push = (text: string, kind: SqlSpanKind) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === 'plain') last.text += text;
    else out.push({ text, kind });
  };
  for (const m of q.matchAll(TOKEN)) {
    if (m[1] !== undefined) push(m[1], 'str');
    else if (m[4] !== undefined) push(m[4], KEYWORDS.has(m[4].toUpperCase()) ? 'kw' : 'plain');
    else if (m[5] !== undefined || m[6] !== undefined) push(m[0], 'num');
    else push(m[0], 'plain');
  }
  return out;
}

/** ✦ Ask Claude: an active query Postgres shows, running past 5 s, never this view's own. */
export function askable(a: DbActivity): boolean {
  return a.state === 'active' && !a.ours && a.query !== null && a.seconds !== null && a.seconds > ASK_SEC;
}

const inTransaction = (state: string | null): boolean => state !== null && state.startsWith('idle in transaction');

/** A session to look at: active or idle in a transaction for more than 30 s (amber), never this view's own. */
export function isLong(a: DbActivity): boolean {
  return !a.ours && a.seconds !== null && a.seconds > LONG_SEC && (a.state === 'active' || inTransaction(a.state));
}

export type StateTone = 'ours' | 'sky' | 'amber' | 'grey';
/** The state chip: this view's own, working, waiting inside a transaction, the rest quiet. */
export function stateTone(a: DbActivity): StateTone {
  if (a.ours) return 'ours';
  if (a.state === 'active') return 'sky';
  return inTransaction(a.state) ? 'amber' : 'grey';
}

/** The sparkline's points across a w × h box, scaled to the samples' peak with headroom; '' under two samples. */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return '';
  const pad = 1.5;
  const max = Math.max(1, ...values) * 1.3;
  return values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = h - pad - (Math.max(0, v) / max) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** The window in front: focused, and its page visible. */
export function windowActive(doc: { hasFocus(): boolean; visibilityState: string }): boolean {
  return doc.hasFocus() && doc.visibilityState !== 'hidden';
}

/** Calls `on` when the window gains or loses the focus or its page shows or hides; the returned function lets go. */
export function watchWindow(win: EventTarget, doc: EventTarget, on: () => void): () => void {
  win.addEventListener('focus', on);
  win.addEventListener('blur', on);
  doc.addEventListener('visibilitychange', on);
  return () => {
    win.removeEventListener('focus', on);
    win.removeEventListener('blur', on);
    doc.removeEventListener('visibilitychange', on);
  };
}

/** What the poller needs: the read, where replies go, the hold, a clock and timers. */
export interface PollIo {
  read(): Promise<DbResult<DbOverview>>;
  /** The latest read's reply; a stale one (superseded, dropped, or after dispose) never gets here. */
  reply(r: DbResult<DbOverview>): void;
  /** The user disconnected this connection: nothing reads it by itself. */
  held(): boolean;
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(h: unknown): void;
}

/**
 * When the overview reads. On show, at once (the first read on show — the window in front or not) unless the
 * last answer is fresher than 5 s; then every 5 s, counted from each answer, while shown in a focused window. One read
 * in flight at a time: a slow server is never asked again before it answers. An error pauses it until Retry (theirs, or
 * the connection back): a failing server is never hammered; a Retry pressed while a read is out is never swallowed. A
 * connection the user disconnected is never read by itself; its read in flight is dropped (`drop`) and counts for
 * nothing,
 * and their Connect reads once (`retry`, or `expire` then the show: wireOverview).
 */
export class OverviewPoller {
  private shown = false;
  private focused = false;
  private paused = false;
  private busy = false;
  /** A read asked for while one was in flight: made once that one is back, unless its answer will do. */
  private want = false;
  private dead = false;
  private timer: unknown = null;
  private seq = 0;
  private done = Number.NEGATIVE_INFINITY;

  constructor(private readonly io: PollIo) {}

  /** The tab on screen (visible, its connection known and not held) and the window in front. */
  update(o: { shown: boolean; focused: boolean }): void {
    const showing = o.shown && !this.shown;
    this.shown = o.shown;
    this.focused = o.focused;
    if (!o.shown || this.dead) { this.stop(); return; }
    if (this.paused || this.busy) return;
    const wait = this.done + POLL_MS - this.io.now();
    if (showing && wait <= 0) { this.fire(); return; }
    if (!o.focused) { this.stop(); return; }
    if (this.timer === null) {
      if (wait <= 0) this.fire();
      else this.arm(wait);
    }
  }

  /** The user's Retry or Connect (their hold released first), or the connection back after a failure: one read, now. */
  retry(): void {
    if (this.dead) return;
    this.paused = false;
    if (this.busy) { this.want = true; return; }
    this.stop();
    this.fire();
  }

  /**
   * The connection is back after a failed read (a password typed, the server up again — as the table tab does): paused
   * no more; it reads now when shown, else when shown next. Nothing to do when it isn't paused.
   */
  resume(): void {
    if (this.dead || !this.paused) return;
    this.paused = false;
    if (this.shown && !this.busy) {
      this.stop();
      this.fire();
    }
  }

  /** The user disconnected it: the read in flight's answer is dropped, no error kept, no timer. */
  drop(): void {
    this.seq++;
    this.paused = false;
    this.want = false;
    this.stop();
  }

  /** The numbers are old whatever their age (their hold released: the user connected it): the next show reads at once. */
  expire(): void {
    this.done = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    this.dead = true;
    this.seq++;
    this.stop();
  }

  private stop(): void {
    if (this.timer !== null) this.io.cancel(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    this.stop();
    this.timer = this.io.later(() => { this.timer = null; this.fire(); }, ms);
  }

  private fire(): void {
    if (this.dead || this.busy || this.io.held()) return;
    const id = ++this.seq;
    this.busy = true;
    const failed = (): DbResult<DbOverview> => ({ ok: false, problem: { kind: 'other', message: tov.readFailed } });
    let read: Promise<DbResult<DbOverview>>;
    try {
      read = this.io.read();
    } catch {
      read = Promise.resolve(failed());
    }
    void read.catch(failed).then((r) => {
      this.busy = false;
      if (this.dead) return;
      if (id !== this.seq) {
        // Stale (dropped while it ran): it counts for nothing — no answer, no time stamped. A read the user asked for
        // meanwhile goes now.
        if (this.want) { this.want = false; this.fire(); }
        return;
      }
      this.done = this.io.now();
      // The user's Retry came while this read was out: an answer that failed doesn't swallow it (that failure came
      // before
      // their Retry: not shown), one that worked is the answer they asked for.
      const again = this.want && !r.ok;
      this.want = false;
      if (again) { this.fire(); return; }
      if (!r.ok) this.paused = true;
      this.io.reply(r);
      if (this.shown && this.focused && !this.paused) this.arm(POLL_MS);
    });
  }
}

/** What OverviewView's effect hands the poller: on screen (visible, known, not held), the window in front, the hold, the connection's state. */
export interface OvInputs { shown: boolean; focused: boolean; held: boolean; connState: DbConnState }

/**
 * The view's effects as one step (OverviewView calls it whenever an input changes; `prev` null: the first time): held,
 * the read in flight is dropped; released — their Connect, here or in the sidebar — the numbers are old, so it
 * reads at once; on screen and in front, the poller follows; the connection connected again after a failed read
 * resumes it.
 */
export function wireOverview(p: Pick<OverviewPoller, 'update' | 'drop' | 'expire' | 'resume'>, prev: OvInputs | null, next: OvInputs): void {
  if (next.held && !prev?.held) p.drop();
  if (prev?.held && !next.held) p.expire();
  p.update({ shown: next.shown, focused: next.focused });
  if (prev && prev.connState !== 'connected' && next.connState === 'connected') p.resume();
}

/** Now running's rows by keyboard: ↓ ↑ Home End from row `i` of `n` (-1: none focused yet); null for other keys. */
export function rowStep(key: string, i: number, n: number): number | null {
  if (n === 0) return null;
  if (key === 'ArrowDown') return Math.min(i + 1, n - 1);
  if (key === 'ArrowUp') return Math.max(i - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}

/**
 * A row's menu (right-click, Shift+F10 or the menu key on the focused row): its query as shown — masked with Mask
 * values on — and, for a session, its pid. A query Postgres hides can't be copied.
 */
export function sessionMenu(query: string | null, pid: number | null, copy: (text: string) => void): MenuItem[] {
  const items: MenuItem[] = [{ id: 'copy-query', label: tov.menu.copyQuery, icon: 'copy', disabled: query === null, run: () => { if (query !== null) copy(query); } }];
  if (pid !== null) items.push({ id: 'copy-pid', label: tov.menu.copyPid, run: () => copy(String(pid)) });
  return items;
}
