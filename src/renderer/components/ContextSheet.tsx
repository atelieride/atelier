import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { ContextErrorKind, ContextGroupId, ContextProgress, ContextReport } from '@shared/context-usage';
import { tc } from '../i18n/context';
import { useApp } from '../store';
import { agoLower } from '../connectors-view';
import { useAgo } from '../minute';
import { analyzeContext, contextReportOf, compactFromContext, runContextCommand } from '../context-actions';
import { conversationNote, donutArcs, formatShare, formatTokens, groupDetail, rankedGroups, sinceAnalyzed, tiles, windowBar, windowLabel, type ArcId, type DetailRow, type GroupDetail, type ServerRow } from '../context-view';
import { panelAvailability, panelReason } from '../session-panel';
import { Icon } from './Icon';
import '../context.css';

// Context usage: a sheet over the window with what fills a session's context —
// numbers, the whole window, a donut of what is in use, the groups ranked, and the selected group's detail. Opening it
// analyses the session (a private copy main starts); Refresh again; the conversation keeps counting live meanwhile.

const R = 72;
const C = 2 * Math.PI * R;
const GAP = 2.5;
const LIVE_MS = 1_000;

type Run = { phase: 'running' } | { phase: 'done' } | { phase: 'failed'; kind: ContextErrorKind; message: string };

const color = (id: ArcId) => `var(--ctx-${id === 'since' ? 'messages' : id})`;

/** Why it failed, in words: a stop with Claude Code's own line, the service's own reasons as they are. */
function failureText(kind: ContextErrorKind, message: string): string {
  if (kind === 'exit') return message && message !== 'Stopped' ? tc.exitWith(message) : tc.errors.exit!;
  if (kind === 'no-session' && message && message !== 'This terminal runs no Claude session') return message;
  return tc.errors[kind] ?? message;
}

function Bar({ row, tint }: { row: DetailRow; tint: string }) {
  return <span className="cxu-rbar"><i className={row.hatch ? 'is-since' : ''} style={{ width: `${row.bar}%`, background: tint }} /></span>;
}

function Rows({ d, onOpen }: { d: GroupDetail; onOpen: (path: string) => void }) {
  const tint = color(d.id);
  return (
    <div className="cxu-rows">
      {d.rows!.map((r, i) => (
        <div key={`${r.name}-${i}`} className={`cxu-row${r.sub ? ' is-sub' : ''}${r.muted ? ' is-muted' : ''}`}>
          <span className="cxu-row-name">
            <span className={r.mono ? 'mono' : ''} title={r.name}>{r.name}</span>
            {r.chip && <span className={`cxu-chip${r.live ? ' is-live' : ''}`}>{r.chip}</span>}
          </span>
          <Bar row={r} tint={tint} />
          <span className="cxu-num mono">{formatTokens(r.tokens)}</span>
          {r.open
            ? <button type="button" className="cxu-ibtn" aria-label={tc.open(r.name)} data-tip={tc.openTip} onClick={() => onOpen(r.open!)}><Icon name="externalLink" size={13} stroke={1.8} /></button>
            : <span />}
        </div>
      ))}
    </div>
  );
}

function Servers({ d, open, toggle, onOpen }: { d: GroupDetail; open: ReadonlySet<string>; toggle: (key: string) => void; onOpen: (path: string) => void }) {
  if (d.servers!.length === 0 && !d.offline && !d.pending) return <p className="cxu-empty">{tc.noServers}</p>;
  const h = tc.mcpHead;
  return (
    <div className="cxu-servers">
      {d.servers!.length > 0 && <div className="cxu-srv-head" aria-hidden="true"><span /><span>{h.server}</span><span>{h.inContext}</span><span>{h.loaded}</span><span>{h.deferred}</span></div>}
      {d.servers!.map((s: ServerRow) => {
        const isOpen = open.has(s.key);
        return (
          <div key={s.key} className={`cxu-srv${isOpen ? ' is-open' : ''}`}>
            <button type="button" className="cxu-srv-row" aria-expanded={isOpen} aria-label={s.label} onClick={() => toggle(s.key)}>
              <span className="cxu-chev"><Icon name="chevron" size={11} stroke={2.2} /></span>
              <span className="cxu-srv-name"><span className="mono" title={s.name}>{s.name}</span>{s.scope && <span className="cxu-chip">{s.scope}</span>}</span>
              <span className="cxu-mbar"><em><i style={{ width: `${s.bar}%` }} /></em><b className="mono">{s.inContext}</b></span>
              <span className="cxu-num mono">{s.loadedLabel}</span>
              <span className="cxu-num mono is-dim">{s.deferred}</span>
            </button>
            {isOpen && (
              <div className="cxu-tools">
                <div className="cxu-tool is-dim"><span>{tc.instructions}</span><span className="mono">{s.instructions}</span><span /></div>
                {s.tools.map((x) => (
                  <div key={x.name} className="cxu-tool"><span className="mono" title={x.name}>{x.name}</span><span className="mono">{x.tokens}</span><span className="cxu-chip">{tc.loadedChip}</span></div>
                ))}
                {s.waiting && <div className="cxu-tool is-dim"><span>{s.waiting}</span><span className="mono">{s.deferred}</span><span className="cxu-chip is-quiet">{tc.deferredChip}</span></div>}
                {(s.config || s.where) && (
                  <div className="cxu-where">
                    {s.config && <button type="button" className="cxu-btn" onClick={() => onOpen(s.config!.path)}><Icon name="externalLink" size={12} stroke={1.8} />{tc.openConfig}</button>}
                    <span className="mono">{s.config?.shown ?? s.where}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {d.pending && <p className="cxu-offline is-pending" data-tip={d.pending.names}><i aria-hidden="true" />{d.pending.label}</p>}
      {d.offline && <p className="cxu-offline" data-tip={d.offline.names}><i aria-hidden="true" />{d.offline.label}</p>}
    </div>
  );
}

function Steps({ progress }: { progress: ContextProgress | null }) {
  const s = tc.steps;
  const at = progress?.phase ?? 'start';
  const order = ['start', 'mcp', 'count'] as const;
  const idx = order.indexOf(at);
  const label = (p: (typeof order)[number]) => (p === 'start' ? s.start : p === 'count' ? s.count
    : progress?.phase === 'mcp' && progress.total ? s.mcpCount(progress.connected ?? 0, progress.total) : s.mcp);
  return (
    <ol className="cxu-steps" aria-live="polite">
      {order.map((p, i) => (
        <li key={p} className={i < idx ? 'is-done' : i === idx ? 'is-now' : 'is-wait'}>
          <span className="cxu-step-mark" aria-hidden="true">{i < idx ? <Icon name="check" size={12} stroke={2.4} /> : i === idx ? <span className="cxu-spin" /> : null}</span>{label(p)}
        </li>
      ))}
    </ol>
  );
}

export function ContextSheet({ terminalId }: { terminalId: string }) {
  const term = useApp((st) => st.terminals.find((x) => x.id === terminalId) ?? null);
  const report = useApp((st) => (term ? contextReportOf(st, term) : null));
  const sessionId = term?.session?.sessionId ?? null;
  const [run, setRun] = useState<Run>({ phase: 'running' });
  const [progress, setProgress] = useState<ContextProgress | null>(null);
  const [selected, setSelected] = useState<ContextGroupId>('mcp');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [live, setLive] = useState<number | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const close = () => useApp.getState().setContextSheet(null);
  const now = useAgo(report?.at ?? null);

  const analyze = useCallback(() => {
    if (!sessionId) return;
    setRun({ phase: 'running' });
    setProgress(null);
    // Only the newest request reports back (one the session's change replaced comes back Stopped: dropped).
    analyzeContext(terminalId, sessionId, {
      done: (r) => {
        setLive(null);
        setRun({ phase: 'done' });
        // The largest server opens by itself the first time: the reason most people come.
        setOpen((o) => (o.size === 0 && r.servers[0] ? new Set([r.servers[0].key]) : o));
      },
      failed: (kind, message) => setRun({ phase: 'failed', kind, message })
    });
  }, [terminalId, sessionId]);

  // Opening it analyses; a progress event is this terminal's only.
  useEffect(() => { analyze(); }, [analyze]);
  useEffect(() => window.atelier.on.contextProgress((p) => { if (p.terminalId === terminalId) setProgress(p); }), [terminalId]);

  // The conversation counts live — every change of the session (a hook, its status line) reads the transcript's
  // last input, at most once a second.
  const state = term?.session?.state;
  const pct = term?.session?.contextPct;
  const updated = term?.session?.updatedAt;
  const lastLive = useRef(0);
  useEffect(() => {
    if (!report) return;
    let alive = true;
    const wait = Math.max(0, lastLive.current + LIVE_MS - Date.now());
    const timer = setTimeout(() => {
      lastLive.current = Date.now();
      window.atelier.claude.contextLive(terminalId).then((n) => { if (alive) setLive(n); }, () => {});
    }, wait);
    return () => { alive = false; clearTimeout(timer); };
  }, [terminalId, report, state, pct, updated]);

  // Esc closes and Tab stays inside, wherever the focus was; nothing reaches the terminal (as What's New).
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.focus();
    return () => {
      const now = document.activeElement;
      if (before && before.isConnected && (!now || now === document.body || !now.isConnected)) before.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = sheet.current;
      if (!root) return;
      const focus = document.activeElement as HTMLElement | null;
      if (focus?.closest('.ctx-menu') || (focus?.closest('[role="dialog"]') && !root.contains(focus))) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      // The groups are one Tab stop (their arrows move inside): only what Tab itself reaches counts.
      const items = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')].filter((x) => x !== root && x.tabIndex >= 0);
      if (items.length === 0) { e.preventDefault(); return; }
      const inside = root.contains(document.activeElement) && document.activeElement !== root;
      if (!inside) { e.preventDefault(); e.stopPropagation(); items[0]!.focus(); return; }
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)!.focus(); }
      else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]!.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const openFile = (path: string) => {
    void window.atelier.claude.contextOpen(terminalId, path).then((o) => {
      const st = useApp.getState();
      if (!o) { st.showToast(tc.openFailed, undefined, 'info'); return; }
      st.setContextSheet(null);
      st.openFile(o.path, o.rel, null, undefined, { preview: true });
    }, () => {});
  };

  if (!term?.session) return null;
  const s = term.session;
  const since = report ? sinceAnalyzed(report, live) : 0;
  const running = run.phase === 'running';
  const failed = run.phase === 'failed' ? run : null;
  const why = panelReason(panelAvailability(term));
  const head = (
    <header className="cxu-head">
      <Icon name="pie" size={16} stroke={1.8} />
      <h2>{tc.title}</h2>
      <span className="cxu-head-sub" title={term.title}>{term.title}</span>
      {report && <span className="cxu-head-model mono">{[s.model, formatTokens(report.max)].filter(Boolean).join(' · ')}</span>}
      <span className="grow" />
      {running
        ? <span className="cxu-analyzing" role="status"><span className="cxu-spin" aria-hidden="true" />{tc.analyzing}</span>
        : report && <span className="cxu-when">{tc.analyzedAgo(agoLower(report.at, now))}</span>}
      <button type="button" className="cxu-btn" disabled={running} data-tip={tc.refreshTip} onClick={analyze}><Icon name="restart" size={12} stroke={2} />{tc.refresh}</button>
      <button type="button" className="cxu-ibtn" aria-label={tc.close} data-tip={tc.close} data-kbd="Esc" onClick={close}><Icon name="x" size={12} stroke={2} /></button>
    </header>
  );
  const failure = failed && (
    <div className="cxu-failed" role="alert">
      <div className="cxu-failed-text"><strong>{tc.failed}</strong><p>{failureText(failed.kind, failed.message)}</p></div>
      <div className="cxu-failed-acts">
        <button type="button" className="cxu-btn" onClick={analyze}>{tc.tryAgain}</button>
        <button type="button" className="cxu-btn" aria-disabled={why !== null || undefined} data-tip={why ?? tc.runContextTip} onClick={() => { if (why === null) runContextCommand(terminalId); }}>{tc.runContext}</button>
      </div>
    </div>
  );

  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={close}>
      <div ref={sheet} className="cxu-sheet" role="dialog" aria-modal="true" aria-label={tc.label(term.title)} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        {head}
        {report ? <Report report={report} since={since} note={conversationNote(report, live, (s.lastMessageAt ?? null) !== null)} selected={selected} select={setSelected} open={open}
          toggle={(key) => setOpen((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
          onOpen={openFile} failure={failure} compactWhy={why} onCompact={() => compactFromContext(terminalId)} />
          : (
            <div className="cxu-pending">
              <Numbers pct={s.contextPct} />
              {failure ?? (
                <div className="cxu-body">
                  <div className="cxu-left">
                    <svg className="cxu-donut is-waiting" width="184" height="184" viewBox="0 0 184 184" aria-hidden="true">
                      <circle cx="92" cy="92" r={R} className="cxu-track" />
                    </svg>
                    <Steps progress={progress} />
                  </div>
                  <div className="cxu-right" aria-hidden="true">{[180, 420, 0, 0, 0, 0].map((w, i) => <i key={i} className="cxu-skel" style={w ? { width: w } : undefined} />)}</div>
                </div>
              )}
            </div>
          )}
        <footer className="cxu-foot"><Icon name="info" size={12} stroke={2} /><span>{tc.foot}</span></footer>
      </div>
    </div>
  );
}

/** Before any report: the In use tile from the panel's percentage, skeletons for the rest. */
function Numbers({ pct }: { pct: number | null }) {
  return (
    <div className="cxu-tiles">
      <div className="cxu-tile"><span className="cxu-k">{tc.tiles.inUse}</span><b className="mono">{pct === null ? '—' : `${pct}%`}</b><span /></div>
      {[tc.tiles.before, tc.tiles.conversation, tc.tiles.untilCompact].map((k) => (
        <div key={k} className="cxu-tile"><span className="cxu-k">{k}</span><i className="cxu-skel is-num" /><span /></div>
      ))}
    </div>
  );
}

function Report({ report, since, note, selected, select, open, toggle, onOpen, failure, compactWhy, onCompact }: {
  report: ContextReport; since: number; note: { kind: string; text: string }; selected: ContextGroupId; select: (id: ContextGroupId) => void;
  open: ReadonlySet<string>; toggle: (key: string) => void; onOpen: (path: string) => void;
  failure: ReactNode; compactWhy: string | null; onCompact: () => void;
}) {
  const n = tiles(report, since);
  const bar = windowBar(report, since);
  const ranked = rankedGroups(report, since);
  const arcs = donutArcs(report, since, C, GAP);
  const d = groupDetail(report, selected, since);
  const used = n.inUse;
  const max = formatTokens(report.max);
  const list = useRef<HTMLDivElement>(null);
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = ranked.findIndex((g) => g.id === selected);
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? ranked.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const g = ranked[Math.max(0, Math.min(ranked.length - 1, next))]!;
    select(g.id);
    list.current?.querySelector<HTMLElement>(`[data-group="${g.id}"]`)?.focus();
  };
  return (
    <>
      <div className="cxu-tiles">
        <div className="cxu-tile"><span className="cxu-k">{tc.tiles.inUse}</span><b className="mono">{formatTokens(n.inUse)}</b><span>{tc.tiles.inUseSub(n.share, max)}</span></div>
        <div className="cxu-tile"><span className="cxu-k">{tc.tiles.before}</span><b className="mono">{formatTokens(n.before)}</b><span>{tc.tiles.beforeSub}</span></div>
        <div className="cxu-tile"><span className="cxu-k">{tc.tiles.conversation}</span><b className="mono">{formatTokens(n.conversation)}</b><span className={note.kind === 'missing' || note.kind === 'compacted' ? 'is-note' : ''}>{note.text}</span></div>
        {n.untilCompact !== null
          ? <div className="cxu-tile"><span className="cxu-k">{tc.tiles.untilCompact}</span><b className="mono">{formatTokens(n.untilCompact)}</b><span>{tc.tiles.untilCompactSub(formatTokens(n.compactAt!))}</span></div>
          : <div className="cxu-tile"><span className="cxu-k">{tc.tiles.free}</span><b className="mono">{formatTokens(n.free)}</b><span>{tc.tiles.freeSub}</span></div>}
      </div>
      <div className="cxu-window">
        <div className="cxu-wbar" role="img" aria-label={windowLabel(report, since)}>
          {bar.segments.map((x) => <i key={x.id} className={x.id === 'since' ? 'is-since' : ''} style={{ width: `${x.pct}%`, background: color(x.id) }} />)}
          <span className="grow" />
          {bar.bufferPct > 0 && <i className="is-buffer" style={{ width: `${bar.bufferPct}%` }} />}
        </div>
        <div className="cxu-wlabels"><span className="mono">0</span><span>{tc.freeSpace} <b className="mono">{formatTokens(n.free)}</b></span><span>{report.buffer > 0 && <>{tc.buffer} <b className="mono">{formatTokens(report.buffer)}</b> · </>}<span className="mono">{max}</span></span></div>
      </div>
      {failure}
      <div className="cxu-body">
        <div className="cxu-left">
          <div className="cxu-donut-box">
            <svg className="cxu-donut" width="184" height="184" viewBox="0 0 184 184" role="img" aria-label={tc.chart(formatTokens(used))}>
              <circle cx="92" cy="92" r={R} className="cxu-track" />
              <g transform="rotate(-90 92 92)">
                {arcs.map((a) => {
                  const group: ContextGroupId = a.id === 'since' ? 'messages' : a.id;
                  const tokens = a.id === 'since' ? since : report.groups[a.id];
                  return (
                    <circle key={a.id} cx="92" cy="92" r={R} className={`cxu-arc${group === selected ? ' is-on' : ''}${a.id === 'since' ? ' is-since' : ''}`}
                      stroke={color(a.id)} strokeDasharray={`${a.len} ${C}`} strokeDashoffset={a.offset} onClick={() => select(group)}>
                      <title>{a.id === 'since' ? tc.sinceTip(formatTokens(since)) : tc.sliceTip(tc.groups[a.id], formatTokens(tokens), formatShare(tokens, used))}</title>
                    </circle>
                  );
                })}
              </g>
            </svg>
            <div className="cxu-donut-center"><b className="mono">{formatTokens(used)}</b><span>{tc.inUseCenter(n.share)}</span></div>
          </div>
          <div ref={list} className="cxu-groups" role="listbox" aria-label={tc.groupsLabel} onKeyDown={onListKey}>
            {ranked.map((g) => (
              <button key={g.id} type="button" role="option" data-group={g.id} aria-selected={g.id === selected} tabIndex={g.id === selected ? 0 : -1}
                className={`cxu-group${g.id === selected ? ' is-on' : ''}`} onClick={() => select(g.id)}>
                <i className="cxu-sw" style={{ background: color(g.id) }} />
                <span>{g.name}</span>
                <span className="cxu-num mono">{formatTokens(g.tokens)}</span>
                <span className="cxu-pct mono">{formatShare(g.tokens, report.max)}</span>
              </button>
            ))}
          </div>
          <p className="cxu-note">{tc.note(max)}</p>
        </div>
        <div className="cxu-right" key={selected}>
          <div className="cxu-dhead">
            <h3>{d.title}</h3>
            <span className="cxu-dtok mono">{formatTokens(d.tokens)}</span>
            <span className="cxu-dsub">{d.sub}</span>
            <span className="grow" />
            {d.compact && <button type="button" className="cxu-btn" aria-disabled={compactWhy !== null || undefined} data-tip={compactWhy ?? tc.compactTip}
              onClick={() => { if (compactWhy === null) onCompact(); }}><Icon name="compact" size={12} stroke={1.9} />{tc.compact}</button>}
          </div>
          <p className="cxu-hint">{d.hint}</p>
          {d.servers ? <Servers d={d} open={open} toggle={toggle} onOpen={onOpen} />
            : d.rows!.length === 0 ? <p className="cxu-empty">{d.id === 'memory' ? tc.noMemory : tc.noSkills}</p>
            : <Rows d={d} onOpen={onOpen} />}
        </div>
      </div>
    </>
  );
}
