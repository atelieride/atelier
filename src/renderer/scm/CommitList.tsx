// The History commit list: virtualized rows (only the window on screen plus overscan are in
// the DOM), the graph layer beside them, ref pills, conventional prefixes, authors and Claude co-authors.
import { Fragment, forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { ScmCommit, ScmHead, ScmRef } from '@shared/scm';
import { graphWidth } from '@shared/git-graph';
import { Icon } from '../components/Icon';
import { initialOf } from '../avatar';
import { relativeTime } from '../history';
import { t } from '../i18n/en';
import { GraphLayer } from './GraphLayer';
import { COMPARE_ROW, WORKTREE_ROW, visibleWindow, type HistoryRows } from './history-model';
import { conventional, isClaude, personColor, refPills } from './view';

export const ROW_H = 28;
/** Load more when the window gets this close to the end. */
const NEAR_END = 100;

export interface CommitListHandle { scroller(): HTMLDivElement | null; scrollToRow(i: number): void }

const absolute = (s: number) => new Date(s * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const Row = memo(function Row({ c, i, selected, isNew, byOid, head, extra, onPick, onOpen, onMenu, now }: {
  c: ScmCommit; i: number; selected: boolean; isNew: boolean; byOid: Map<string, ScmRef[]>; head: ScmHead; extra: ReactNode;
  onPick: (i: number) => void; onOpen: (i: number) => void; onMenu: (i: number, e: ReactMouseEvent) => void; now: number;
}) {
  const style = { top: i * ROW_H };
  if (c.oid === WORKTREE_ROW || c.oid === COMPARE_ROW) {
    return (
      <div role="row" aria-selected={selected} className={`hv-row is-pseudo ${c.oid === WORKTREE_ROW ? 'is-worktree' : 'is-compare'} ${selected ? 'is-selected' : ''}`} style={style}
        onMouseDown={() => onPick(i)} onContextMenu={(e) => onMenu(i, e)}>
        <span className="hv-msg">{extra}</span>
      </div>
    );
  }
  const pills = refPills(c.oid, byOid, head);
  const { prefix, rest } = conventional(c.subject);
  const claude = c.coAuthors.find(isClaude) ?? (isClaude(c.author) ? c.author : null);
  return (
    <div role="row" aria-selected={selected} data-oid={c.oid} className={`hv-row ${selected ? 'is-selected' : ''} ${isNew ? 'is-new' : ''}`} style={style}
      onMouseDown={() => onPick(i)} onDoubleClick={() => onOpen(i)} onContextMenu={(e) => onMenu(i, e)}>
      <span className="hv-msg">
        {pills.map((p) => <Fragment key={p.kind + p.label}><span className={`hv-pill is-${p.kind}`}>{p.kind === 'tag' && <Icon name="tag" size={10} stroke={1.8} />}{p.label}</span>{' '}</Fragment>)}
        {prefix && <><span className="hv-prefix mono">{prefix}</span>{' '}</>}
        <span className="hv-subject">{rest}</span>
      </span>
      <span className="hv-author">
        <span className="hv-avatar" style={{ ['--person' as string]: personColor(c.author.email) }}>{initialOf(c.author.name || '?')}</span>
        <span className="hv-author-name">{c.author.name}</span>
        {claude && <span className="hv-claude" data-tip={t.scm.history.coAuthored(claude.name)}><Icon name="sparkle" size={11} stroke={1.8} /></span>}
      </span>
      <span className="hv-date mono" data-tip={absolute(c.authorAt)}>{relativeTime(c.authorAt * 1000, now)}</span>
      <span className="hv-sha mono">{c.oid.slice(0, 7)}</span>
    </div>
  );
});

export const CommitList = memo(forwardRef<CommitListHandle, {
  rows: HistoryRows; graph: boolean; selected: number | null; byOid: Map<string, ScmRef[]>; head: ScmHead; fresh: ReadonlySet<string>;
  pseudo: (oid: string) => ReactNode; footer: ReactNode; label: string;
  onPick: (i: number) => void; onOpen: (i: number) => void; onMenu: (i: number, e: ReactMouseEvent) => void;
  onNearEnd: () => void; onScrollTop: (top: number) => void; onKey: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}>(function CommitList({ rows, graph, selected, byOid, head, fresh, pseudo, footer, label, onPick, onOpen, onMenu, onNearEnd, onScrollTop, onKey }, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useImperativeHandle(ref, () => ({
    scroller: () => scroller.current,
    scrollToRow: (i) => {
      const el = scroller.current;
      if (!el) return;
      const top = i * ROW_H; const bottom = top + ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }
  }), []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const total = rows.commits.length;
  const { start, end } = visibleWindow(view.top, view.height, total, ROW_H);
  useEffect(() => { if (!rows.done && end > total - NEAR_END) onNearEnd(); }, [end, total, rows.done]);
  // Minutes: rows keep their memo between scrolls.
  const now = Math.floor(Date.now() / 60000) * 60000;
  const width = graph ? graphWidth(rows.maxLanes) : 0;
  const oids = rows.commits.map((c) => c.oid);
  const merges = rows.commits.map((c) => c.parents.length > 1);
  return (
    <div ref={scroller} className="hv-scroll" role="grid" aria-label={label} aria-rowcount={total} tabIndex={0} onKeyDown={onKey}
      style={{ ['--graph-w' as string]: `${width}px` }}
      onScroll={(e) => { const el = e.currentTarget; setView({ top: el.scrollTop, height: el.clientHeight }); onScrollTop(el.scrollTop); }}>
      <div className="hv-canvas" style={{ height: total * ROW_H + (footer ? ROW_H : 0) }}>
        {graph && <GraphLayer rows={rows.graph} oids={oids} merges={merges} start={start} end={end} rowH={ROW_H} width={width} selected={selected} />}
        {rows.commits.slice(start, end).map((c, k) => {
          const i = start + k;
          return <Row key={c.oid} c={c} i={i} selected={i === selected} isNew={fresh.has(c.oid)} byOid={byOid} head={head} extra={c.oid === WORKTREE_ROW || c.oid === COMPARE_ROW ? pseudo(c.oid) : null}
            onPick={onPick} onOpen={onOpen} onMenu={onMenu} now={now} />;
        })}
        {footer && <div className="hv-row is-footer" style={{ top: total * ROW_H }}>{footer}</div>}
      </div>
    </div>
  );
}));
