// A connection's overview tab: the header — glyph, name, environment, provider, the
// version line, the role chip, Mask values —, five tiles, the biggest tables, schemas and extensions, Now running and
// the slowest statements (or the hint). Read every 5 s while shown in a focused window (overview.ts OverviewPoller),
// paused on an error until Retry; a connection the user disconnected this session shows the Disconnected card instead.
// Mask values masks every value in the queries (maskForeignSql). Now running's rows take the keyboard
// (one in the Tab order, ↑ ↓ between, their menu on Shift+F10). Laid out by its own width. Behind DbTabView's lazy
// boundary with its stylesheet and strings; production's 2 px hairline is the tab's (databases.css).
import './overview.css';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react';
import { envLabel, type DbActivity, type DbConnView, type DbConnection, type DbOverview, type DbProblem, type DbServerInfo } from '@shared/databases';
import { Icon } from '../components/Icon';
import { copyText } from '../clipboard';
import { tdb } from '../i18n/db';
import { tdt } from '../i18n/db-table';
import { tov } from '../i18n/db-overview';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { connectHeld, isHeld, useHeld } from './hold';
import {
  activityFor, askable, barPct, EMPTY_OV, fmtDuration, fmtPct, fmtRate, fmtSize, foreignSql, isLong, LONG_SEC, ovLayout, ovReply, OverviewPoller, rowStep,
  sessionMenu, shortVersion, sparkPoints, sqlSpans, stateTone, totals, watchWindow, windowActive, wireOverview, type OvInputs, type OvLayout, type OvSamples,
  type OvState
} from './overview';
import { endpointOf } from './side';
import { useDb } from './store';
import { isRefreshKey } from './table-view';
import type { DbTabRef } from './tabs';
import { envClass } from './view';

export type { OvState } from './overview';

/**
 * ✦ Ask Claude on an active query running past 5 s, shown only when given. `query` is the text as shown —
 * masked with Mask values on (what you see is what is sent).
 */
export interface OverviewActions { ask?(a: DbActivity, query: string): void }

const api = () => window.atelier.databases;
const toast = (text: string, info = false) => useApp.getState().showToast(text, undefined, info ? 'info' : undefined);

function copy(text: string): void {
  void copyText(text).then((ok) => toast(ok ? tdt.copied : tdt.copyFailed, ok), () => toast(tdt.copyFailed));
}

/** The window in front (focused, its page visible), followed while the view is mounted. */
function useWindowActive(): boolean {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && windowActive(document));
  useEffect(() => {
    const check = () => setOn(windowActive(document));
    check();
    return watchWindow(window, document, check);
  }, []);
  return on;
}

/**
 * The view's width as drawn; a hidden tab keeps the last one (0 until first measured). `ready`: the view's own box is
 * drawn (before main's first snapshot a placeholder stands in its place: measured again once the box replaces it).
 */
function useWidth(el: { current: HTMLElement | null }, ready: boolean): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const box = el.current;
    if (!box) return;
    const measure = () => { if (box.clientWidth > 0) setW(box.clientWidth); };
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    measure();
    return () => ro.disconnect();
  }, [el, ready]);
  return w;
}

export function OverviewView({ tab, conn, visible, focused = visible, actions }: {
  tab: DbTabRef; conn: DbConnection | null; visible: boolean; focused?: boolean; actions?: OverviewActions;
}) {
  const view = useDb((s) => s.snap.connections.find((v) => v.conn.id === tab.connId) ?? null);
  // Main's hold: one truth for every window.
  const held = useHeld(tab.connId);
  const connState = view?.state ?? 'idle';
  const inFront = useWindowActive();
  const [st, setSt] = useState<OvState>(EMPTY_OV);
  const poller = useRef<OverviewPoller | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const ready = conn !== null;
  const width = useWidth(root, ready);
  // The row of Now running (or of the slowest statements) in the Tab order: the one last focused.
  const [focusRow, setFocusRow] = useState<string | null>(null);

  const inputs = useRef<OvInputs | null>(null);
  useEffect(() => {
    const p = new OverviewPoller({
      read: () => api().overview(tab.connId),
      reply: (r) => setSt((s) => ovReply(s, r)),
      held: () => isHeld(tab.connId),
      now: () => Date.now(),
      later: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (h) => window.clearTimeout(h as number)
    });
    poller.current = p;
    inputs.current = null;
    return () => p.dispose();
  }, [tab.connId]);
  // On screen: in front in its pane, its connection known and not held (never connected by itself). Every change
  // goes to the poller as one step (overview.ts wireOverview: the hold, the release, the focus, the connection back).
  const shown = visible && ready && !held;
  useEffect(() => {
    const next: OvInputs = { shown, focused: inFront, held, connState };
    if (poller.current) wireOverview(poller.current, inputs.current, next);
    inputs.current = next;
  }, [shown, inFront, held, connState, tab.connId]);
  // In front with the keyboard (as the other views): the overview takes the focus, so ⌘R and the arrows reach it.
  useEffect(() => {
    const el = root.current;
    if (visible && focused && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [visible, focused, ready]);

  // The user's own read (Retry, Connect, ⌘R): on a connection main holds it is their Connect — main lets the hold
  // go, and the snapshot saying so reads at once (wireOverview); else one read now.
  const read = () => {
    if (isHeld(tab.connId)) connectHeld(tab.connId);
    else poller.current?.retry();
  };
  const onMask = () => {
    if (conn) void api().setMask(conn.id, !conn.mask).catch(() => toast(tdt.fail.mask));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isRefreshKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    read();
  };
  // Before main's first snapshot the connection isn't known yet: the place, quiet.
  if (!conn) return <div ref={root} className="dbo" tabIndex={-1} aria-busy="true" />;
  return (
    <OverviewBody boxRef={root} conn={conn} view={view} st={st} held={held} width={width} actions={actions}
      onRetry={read} onConnect={read} onMask={onMask} onKeyDown={onKeyDown} rows={{ focus: focusRow, onFocus: setFocusRow }} />
  );
}

/** A table's rows by keyboard: the row in the Tab order (by key; none: the first), told when another takes the focus. */
interface RowFocus { focus: string | null; onFocus(key: string): void }
const NO_ROW_FOCUS: RowFocus = { focus: null, onFocus: () => {} };

/** ↓ ↑ Home End between a table's rows (the focused row's own keys; a button inside a row keeps them). */
function onRowsKey(e: KeyboardEvent<HTMLTableSectionElement>): void {
  if (!(e.target instanceof HTMLTableRowElement)) return;
  const rows = Array.from(e.currentTarget.rows);
  const next = rowStep(e.key, rows.indexOf(e.target), rows.length);
  if (next === null) return;
  e.preventDefault();
  rows[next]?.focus();
}

/** The overview as drawn from what it was given (markup tests render it with a fixture overview). */
export function OverviewBody({ boxRef, conn, view, st, held, width, actions, onRetry, onConnect, onMask, onKeyDown, rows = NO_ROW_FOCUS }: {
  boxRef?: Ref<HTMLDivElement>; conn: DbConnection; view: DbConnView | null; st: OvState; held: boolean; width: number; actions?: OverviewActions;
  onRetry: () => void; onConnect: () => void; onMask: () => void; onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void; rows?: RowFocus;
}) {
  const layout = ovLayout(width);
  const data = st.data;
  const server = data?.server ?? view?.server ?? null;
  let body: ReactNode;
  // Held, or a read main answered 'held' (another window disconnected it meanwhile): the calm card, never an error.
  if (held || (!data && st.problem?.kind === 'held')) body = <Disconnected conn={conn} onConnect={onConnect} />;
  else if (!data && st.problem) body = <ProblemCard problem={st.problem} onRetry={onRetry} />;
  else {
    body = (
      <>
        {data && st.problem && (
          <div className="dbo-paused" role="status">
            <Icon name="pause" size={13} />
            <span data-tip={st.problem.message}>{tov.paused(st.problem.message)}</span>
            <button type="button" className="btn-ghost sm" onClick={onRetry}>{tov.retry}</button>
          </div>
        )}
        <Tiles data={data} samples={st.samples} layout={layout} masked={conn.mask} />
        {data && (
          <>
            <div className={`dbo-mid${layout.split ? ' is-split' : ''}`}>
              <Biggest conn={conn} data={data} />
              <Schemas data={data} />
            </div>
            <Running data={data} masked={conn.mask} actions={actions} rows={rows} />
            {data.slowest && <Slowest list={data.slowest} masked={conn.mask} rows={rows} />}
          </>
        )}
      </>
    );
  }
  return (
    <div ref={boxRef} className={`dbo${conn.env === 'prod' ? ' is-prod' : ''}`} tabIndex={-1} onKeyDown={onKeyDown}>
      <Head conn={conn} provider={view?.provider ?? null} server={server} uptime={data?.uptimeSec ?? null} stacked={layout.stacked} onMask={onMask} />
      {body}
    </div>
  );
}

/** "PostgreSQL 17.2 · host:port/database · up 21d 3h · TLS verified" (the version in full in the tooltip). */
function serverLine(conn: DbConnection, server: DbServerInfo | null, uptime: number | null, full: boolean): string {
  const where = `${endpointOf({ ...conn, ssh: null })}/${conn.database}${conn.ssh ? ` · ${tdb.side.viaSsh(conn.ssh.host)}` : ''}`;
  const tls = server ? (server.tls ? (conn.tls === 'verify' ? tov.tls.verified : tov.tls.on) : tov.tls.off) : null;
  const version = server ? tov.version(full ? server.version : shortVersion(server.version)) : null;
  return [version, where, uptime !== null ? tov.up(fmtDuration(uptime)) : null, tls].filter((x): x is string => x !== null).join(' · ');
}

function Head({ conn, provider, server, uptime, stacked, onMask }: {
  conn: DbConnection; provider: string | null; server: DbServerInfo | null; uptime: number | null; stacked: boolean; onMask: () => void;
}) {
  const role = server ? (server.canWrite ? tov.roleWrite(server.role) : tov.roleRead(server.role)) : null;
  return (
    <header className={`dbo-head${stacked ? ' is-stacked' : ''}`}>
      <span className="dbo-glyph" aria-hidden="true"><Icon name="databases" size={20} /></span>
      <div className="dbo-title">
        <div className="dbo-name-row">
          <h2 className="dbo-name" data-tip={conn.name}>{conn.name}</h2>
          <span className={`db-env ${envClass(conn.env)}`}>{envLabel(conn.env)}</span>
          {provider && <span className="dbo-provider">{provider}</span>}
        </div>
        <p className="dbo-sub mono" data-tip={serverLine(conn, server, uptime, true)}>{serverLine(conn, server, uptime, false)}</p>
      </div>
      <div className="dbo-chips">
        {server && role && (
          <span className={`dbo-role ${server.canWrite ? 'is-write' : 'is-read'}`} data-tip={`${role}. ${server.canWrite ? tov.roleWriteTip : tov.roleReadTip}`}>
            <Icon name={server.canWrite ? 'warning' : 'lock'} size={13} /><span>{role}</span>
          </span>
        )}
        <button type="button" className={`dbo-mask${conn.mask ? ' is-on' : ''}`} aria-pressed={conn.mask} data-tip={tov.maskTip(conn.mask)} onClick={onMask}>
          <span className="dbo-switch" aria-hidden="true"><i /></span><span>{tov.mask}</span>
        </button>
      </div>
    </header>
  );
}

function Tile({ label, value, of, sub, tip, long = false, span, children }: {
  label: string; value: string; of?: string; sub: string | null; tip?: string; long?: boolean; span: number; children?: ReactNode;
}) {
  return (
    <div className={`dbo-tile${long ? ' is-long' : ''}`} style={span > 1 ? { gridColumn: `span ${span}` } : undefined}>
      <span className="section-label">{label}</span>
      <span className="dbo-v" data-tip={tip ?? (of ? `${value} ${of}` : value)}>{value}{of && <span className="dbo-of">{of}</span>}</span>
      {sub !== null && <span className="dbo-s" data-tip={sub}>{sub}</span>}
      {children}
    </div>
  );
}

const SPARK_W = 150;
const SPARK_H = 22;

/** Transactions per second, the last 30 reads: one line, no axes (one sample: its baseline). */
function Spark({ series }: { series: readonly number[] }) {
  const pts = sparkPoints(series, SPARK_W, SPARK_H);
  return (
    <svg className="dbo-spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" role="img"
      aria-label={tov.tiles.spark(series.length)}>
      {pts ? <polyline points={pts} /> : <line x1={1.5} x2={SPARK_W - 1.5} y1={SPARK_H - 1.5} y2={SPARK_H - 1.5} className="is-flat" />}
    </svg>
  );
}

function Tiles({ data, samples, layout, masked }: { data: DbOverview | null; samples: OvSamples; layout: OvLayout; masked: boolean }) {
  const T = tov.tiles;
  const style = { '--dbo-cols': layout.cols } as CSSProperties;
  if (!data) {
    // Before the first read: the tiles' places, quiet.
    return (
      <div className="dbo-tiles" style={style} aria-busy="true">
        {[T.size, T.connections, T.cache, T.longest, T.tx].map((label, i) => <Tile key={label} label={label} value="—" sub={null} span={i === 4 ? layout.lastSpan : 1} />)}
      </div>
    );
  }
  const sum = totals(data.schemas);
  const c = data.connections;
  const longest = data.longest;
  return (
    <div className="dbo-tiles" style={style}>
      <Tile label={T.size} value={fmtSize(data.sizeBytes)} sub={T.sizeSub(sum.tables, sum.views)} span={1} />
      <Tile label={T.connections} value={c.total.toLocaleString('en-US')} of={T.of(c.max)} sub={T.connSub(c.active, c.idleInTx)} span={1} />
      <Tile label={T.cache} value={fmtPct(data.cacheHit)} sub={data.cacheHit === null ? T.cacheNone : T.cacheSub} span={1} />
      {longest ? (
        <Tile label={T.longest} value={fmtDuration(longest.seconds)} sub={T.longestSub(longest.pid)} tip={foreignSql(longest.query, masked) || undefined}
          long={longest.seconds > LONG_SEC} span={1} />
      ) : <Tile label={T.longest} value="—" sub={T.longestNone} span={1} />}
      <Tile label={T.tx} value={fmtRate(samples.rate)} of={samples.rate === null ? undefined : T.perSec} sub={samples.rate === null ? T.measuring : null}
        tip={samples.rate === null ? undefined : T.txTip(fmtRate(samples.rate))} span={layout.lastSpan}>
        {samples.rate !== null && samples.series.length > 0 && <Spark series={samples.series} />}
      </Tile>
    </div>
  );
}

/**
 * The biggest tables (top 6) as bars; a click opens its table as the preview, like a single click anywhere else —
 * it takes the pane, so there is no second click to keep it: investing in the table keeps it.
 */
function Biggest({ conn, data }: { conn: DbConnection; data: DbOverview }) {
  const max = data.biggest.reduce((m, b) => Math.max(m, b.bytes), 0);
  const multi = new Set(data.biggest.map((b) => b.schema)).size > 1;
  const open = (b: DbOverview['biggest'][number]) => {
    const cat = useDb.getState().snap.catalog;
    const kind = cat?.connId === conn.id ? cat.rels.find((r) => r.schema === b.schema && r.name === b.name)?.kind ?? 'table' : 'table';
    useApp.getState().openDbTab({ connId: conn.id, schema: b.schema, name: b.name, kind, view: 'data' }, { preview: true });
  };
  return (
    <section className="dbo-card dbo-biggest" aria-label={tov.biggest}>
      <div className="dbo-card-head"><span className="section-label">{tov.biggest}</span><span className="dbo-sp" /><span className="dbo-count">{tov.tables(totals(data.schemas).tables)}</span></div>
      {data.biggest.length === 0 ? <p className="dbo-empty">{tov.biggestNone}</p> : data.biggest.map((b) => {
        const size = fmtSize(b.bytes);
        return (
          <button key={`${b.schema}.${b.name}`} type="button" className="dbo-bar" data-tip={tov.openTip(`${b.schema}.${b.name}`, size)}
            onClick={() => open(b)}>
            <span className="dbo-bar-name">{multi ? `${b.schema}.${b.name}` : b.name}</span>
            <span className="dbo-bar-track"><i style={{ width: `${barPct(b.bytes, max)}%` }} /></span>
            <span className="dbo-bar-size">{size}</span>
          </button>
        );
      })}
    </section>
  );
}

function Schemas({ data }: { data: DbOverview }) {
  const statements = data.extensions.some((e) => e.name === 'pg_stat_statements');
  return (
    <section className="dbo-card dbo-schemas" aria-label={tov.schemas}>
      <div className="dbo-card-head"><span className="section-label">{tov.schemas}</span></div>
      <div className="dbo-kv">
        {data.schemas.map((s) => {
          const val = tov.schemaSub(fmtSize(s.bytes), s.tables, s.views);
          return <div key={`s:${s.name}`} className="dbo-kv-row"><span className="dbo-kv-name" data-tip={s.name}>{s.name}</span><span className="dbo-kv-val" data-tip={val}>{val}</span></div>;
        })}
        {data.extensions.map((e, i) => (
          <div key={`e:${e.name}`} className={`dbo-kv-row is-ext${i === 0 && data.schemas.length > 0 ? ' is-first' : ''}`}>
            <span className="dbo-kv-name" data-tip={e.name}>{e.name}</span><span className="dbo-kv-val">{e.version}</span>
          </div>
        ))}
      </div>
      {data.slowest === null && (statements
        ? <p className="dbo-hint">{tov.hint.unreadable}</p>
        : <p className="dbo-hint">{tov.hint.before}<code>pg_stat_statements</code>{tov.hint.after}</p>)}
    </section>
  );
}

/** A query on one line: keywords, strings and numbers tinted. */
function QueryText({ q }: { q: string }) {
  return <span className="dbo-q-text">{sqlSpans(q).map((s, i) => (s.kind === 'plain' ? s.text : <span key={i} className={`dbo-${s.kind}`}>{s.text}</span>))}</span>;
}

/** The row in the Tab order: the one last focused while it is still listed, else the first. */
const tabbable = (keys: readonly string[], focus: string | null): string | undefined => (focus !== null && keys.includes(focus) ? focus : keys[0]);

/**
 * A row's own handlers: its menu on a right-click, Shift+F10 or the menu key (App sends those as a contextmenu event at
 * the focused element), and the Tab order following the focus.
 */
function rowProps(key: string, tab: string | undefined, rows: RowFocus, menu: () => MenuItem[]) {
  return {
    tabIndex: key === tab ? 0 : -1,
    onFocus: () => rows.onFocus(key),
    onContextMenu: (e: MouseEvent) => useApp.getState().openMenu(e, menu())
  };
}

function Running({ data, masked, actions, rows }: { data: DbOverview; masked: boolean; actions?: OverviewActions; rows: RowFocus }) {
  const C = tov.cols;
  const ask = actions?.ask;
  const tab = tabbable(data.activity.map((a) => `r:${a.pid}`), rows.focus);
  return (
    <section className="dbo-card dbo-running" aria-label={tov.running}>
      <div className="dbo-card-head">
        <span className="section-label">{tov.running}</span><span className="dbo-count">{tov.sessions(data.activity.length)}</span>
        <span className="dbo-sp" /><span className="dbo-note">{tov.runningNote}</span>
      </div>
      {data.activity.length === 0 ? <p className="dbo-empty">{tov.noSessions}</p> : (
        <div className="dbo-scroll">
          <table className="dbo-act mono">
            <colgroup><col className="dbo-c-pid" /><col className="dbo-c-role" /><col className="dbo-c-app" /><col className="dbo-c-state" /><col className="dbo-c-for" /><col /></colgroup>
            <thead><tr><th>{C.pid}</th><th>{C.role}</th><th>{C.app}</th><th>{C.state}</th><th className="dbo-for">{C.for}</th><th>{C.query}</th></tr></thead>
            <tbody onKeyDown={onRowsKey}>
              {data.activity.map((a) => {
                const q = a.query === null ? null : foreignSql(a.query, masked);
                return (
                  <tr key={a.pid} className={a.ours ? 'is-ours' : isLong(a) ? 'is-long' : undefined} {...rowProps(`r:${a.pid}`, tab, rows, () => sessionMenu(q, a.pid, copy))}>
                    <td>{a.pid}</td>
                    <td data-tip={a.role || undefined}>{a.role || '—'}</td>
                    <td className="dbo-app" data-tip={a.app || undefined}>{a.app || '—'}</td>
                    <td><span className={`dbo-st is-${stateTone(a)}`}>{a.ours ? tov.thisView : a.state ?? tov.noState}</span></td>
                    <td className="dbo-for">{activityFor(a.seconds)}</td>
                    {q === null ? <td className="dbo-q is-hidden">{tov.hidden}</td> : (
                      <td className="dbo-q" data-tip={q}>
                        <div className="dbo-q-line">
                          <QueryText q={q} />
                          {ask && askable(a) && (
                            <button type="button" className="dbo-ask" data-tip={tov.askTip} onClick={() => ask(a, q)}><Icon name="sparkle" size={12} /><span>{tov.ask}</span></button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Slowest({ list, masked, rows }: { list: NonNullable<DbOverview['slowest']>; masked: boolean; rows: RowFocus }) {
  const C = tov.slowCols;
  const tab = tabbable(list.map((_, i) => `s:${i}`), rows.focus);
  return (
    <section className="dbo-card dbo-slowest" aria-label={tov.slowest}>
      <div className="dbo-card-head"><span className="section-label">{tov.slowest}</span><span className="dbo-sp" /><span className="dbo-note">{tov.slowestNote}</span></div>
      {list.length === 0 ? <p className="dbo-empty">{tov.slowestNone}</p> : (
        <div className="dbo-scroll">
          <table className="dbo-act dbo-slow mono">
            <colgroup><col /><col className="dbo-c-calls" /><col className="dbo-c-for" /></colgroup>
            <thead><tr><th>{C.query}</th><th className="dbo-for">{C.calls}</th><th className="dbo-for">{C.mean}</th></tr></thead>
            <tbody onKeyDown={onRowsKey}>
              {list.map((r, i) => {
                const q = foreignSql(r.query, masked);
                return (
                  <tr key={i} {...rowProps(`s:${i}`, tab, rows, () => sessionMenu(q, null, copy))}>
                    <td className="dbo-q" data-tip={q}><div className="dbo-q-line"><QueryText q={q} /></div></td>
                    <td className="dbo-for">{r.calls.toLocaleString('en-US')}</td>
                    <td className="dbo-for">{fmtDuration(r.meanMs / 1000)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A connection the user disconnected this session: the calm card; Connect is their read. */
function Disconnected({ conn, onConnect }: { conn: DbConnection; onConnect: () => void }) {
  return (
    <div className="dbo-center">
      <div className="dk-state is-compact">
        <span className="dk-state-icon" aria-hidden="true"><Icon name="databases" size={22} /></span>
        <h3 className="dk-state-title">{tdt.disconnected.title}</h3>
        <p className="dk-state-hint">{tdt.disconnected.body(conn.name)}</p>
        <button type="button" className="btn-primary sm" onClick={onConnect}>{tdt.disconnected.connect}</button>
      </div>
    </div>
  );
}

/** The first read failed: Postgres's message, its detail, the hint, SQLSTATE, Retry. */
function ProblemCard({ problem, onRetry }: { problem: DbProblem; onRetry: () => void }) {
  return (
    <div className="dbo-center">
      <div className="dk-state is-compact dbo-problem" role="alert">
        <span className="dk-state-icon" aria-hidden="true"><Icon name="warning" size={22} /></span>
        <h3 className="dk-state-title">{problem.message}</h3>
        {problem.detail && <p className="dbo-problem-detail">{problem.detail}</p>}
        {problem.hint && <p className="dk-state-hint">{problem.hint}</p>}
        {problem.code && <p className="dbo-problem-code mono">{tdt.sqlState(problem.code)}</p>}
        <button type="button" className="btn-ghost sm" onClick={onRetry}><Icon name="refresh" size={12} />{tov.retry}</button>
      </div>
    </div>
  );
}
