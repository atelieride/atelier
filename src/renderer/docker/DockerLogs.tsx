// Docker logs: one container or a whole compose stack merged in time; levels, access-line
// statuses, one-line JSON folded to its message, stack traces folded after two frames, frames that open the file;
// lines selected and sent to Claude.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DockerContainer, Mount } from '@shared/docker';
import { clock, foldTraces, frameOf, hostPath, httpOf, isFrame, jsonSummary, type DockerLevel } from '@shared/docker-logs';
import { parseLogLine, stripAnsi, type LogLine } from '@shared/logline';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { openBelow } from '../menus';
import { copyText } from '../clipboard';
import { useDocker } from './store';
import { useDockerWatch } from './watch';
import { filterLines, levelCounts, levelOf, mergeStack, stackLabels, svcColor, type LevelFilter, type StackLine } from './view';
import { askAboutLines, sendLines, sendTarget } from './actions';
import { isBelow } from '@shared/paths';
import { isMod } from '@shared/keys';
import { kbd } from '../kbd';

const SHOWN = 1500;
const SINCE_MS: Record<string, number> = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 3_600_000 };
const LEAD = /^(?:info|warn(?:ing)?|error|debug|trace)(?::\s*|\s+(?=\S))/i;
const LABEL: Record<DockerLevel, string> = { error: 'error', warn: 'warn', info: 'info', debug: 'debug', http: 'http', plain: '' };

const cache = new Map<string, LogLine>();
function parsed(raw: string): LogLine {
  let l = cache.get(raw);
  if (!l) {
    l = parseLogLine(raw);
    if (cache.size > 20000) cache.clear();
    cache.set(raw, l);
  }
  return l;
}

interface Opener { open(path: string, line: number): void; where(text: string, cid: string): { path: string; rel: string; line: number } | null }

/** A line's message cut by the pane's width (ellipsis), measured from the DOM. */
const isCut = (msg: Element | null | undefined) => !!msg && msg.scrollWidth > msg.clientWidth + 1;

/**
 * One line. Too long for the pane (measured on hover: thousands of lines are never measured up front), it shows a
 * chevron that shows it whole, as a service's log line does; a click on the line still picks it. `onExpand` absent:
 * every line wraps already.
 */
const Line = memo(function Line({ l, svcIndex, stack, ts, selected, jsonOpen, onJson, opener, onPick, expanded, onExpand }: {
  l: StackLine; svcIndex: number; stack: boolean; ts: boolean; selected: boolean; jsonOpen: boolean; onJson: (key: string) => void; opener: Opener; onPick: (key: string, e: React.MouseEvent) => void;
  expanded: boolean; onExpand?: (key: string) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const msg = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const measure = () => { if (!expanded) setCut(isCut(msg.current)); };
  const canExpand = !!onExpand && (cut || expanded);
  // Shown whole near the bottom: the pane scrolls so the rest is in view too, never past the line's start.
  const was = useRef(expanded);
  useLayoutEffect(() => {
    const el = row.current;
    const pane = el?.closest('.dk-lines');
    if (expanded && !was.current && el && pane) {
      const r = el.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      const over = r.bottom - (p.bottom - 12);
      if (over > 0) pane.scrollTop += Math.min(over, r.top - p.top);
    }
    was.current = expanded;
  }, [expanded]);
  const frame = isFrame(l.text);
  const level: DockerLevel = frame ? 'plain' : levelOf(l);
  const text = stripAnsi(l.text);
  const http = !frame ? httpOf(text) : null;
  const json = !frame && !http ? jsonSummary(text) : null;
  const target = frame ? opener.where(text, l.cid) : null;
  let body: React.ReactNode;
  if (http) {
    // The status after the path (an IP or a size before it can hold the same digits).
    const i = text.indexOf(String(http.status), text.indexOf(http.path) + http.path.length);
    body = i < 0 ? text : <>{text.slice(0, i)}<span className={`dk-status s${String(http.status)[0]}`}>{http.status}</span>{text.slice(i + 3)}</>;
  } else if (json) {
    body = <>{json.message ?? text}{json.keys > 0 && json.message !== null && <button type="button" className={`dk-json-chip ${jsonOpen ? 'is-on' : ''}`} aria-expanded={jsonOpen} onClick={(e) => { e.stopPropagation(); onJson(l.key); }}>{t.docker.logs.keys(json.keys)}</button>}</>;
  } else {
    // "info: …" under an INFO label says it twice: the logger's own word goes (plain lines only, colors kept otherwise).
    const lead = level !== 'plain' && l.text === text ? LEAD.exec(text) : null;
    body = lead ? text.slice(lead[0].length) : parsed(l.text).segs.map((s, i) => <span key={i} style={{ color: s.color ?? undefined, fontWeight: s.bold ? 600 : undefined }}>{s.text}</span>);
  }
  return (
    <>
      <div ref={row} className={`dk-ln lv-${level} ${frame ? 'is-frame' : ''} ${selected ? 'is-sel' : ''} ${canExpand && expanded ? 'is-expanded' : ''} ${canExpand ? 'can-expand' : ''}`} data-key={l.key}
        onClick={(e) => onPick(l.key, e)} onMouseEnter={measure}
        // ⇧ and ⌘ pick lines: the browser must not extend a text selection with them.
        onMouseDown={(e) => { if (e.shiftKey || isMod(e)) { e.preventDefault(); window.getSelection()?.removeAllRanges(); } }}>
        {ts && <span className="dk-ln-t">{l.at !== null && !frame ? clock(l.at) : ''}</span>}
        {stack && <span className="dk-ln-svc"><span className={`dk-svc c-${svcIndex}`}>{l.svc}</span></span>}
        <span className={`dk-lv lv-${level}`}>{LABEL[level]}</span>
        <span ref={msg} className="dk-ln-msg">
          {body}
          {target && (
            <button type="button" className="dk-frame-open" data-tip={t.docker.logs.openFrame(target.rel, target.line)} aria-label={t.docker.logs.openFrame(target.rel, target.line)}
              onClick={(e) => { e.stopPropagation(); opener.open(target.path, target.line); }}><Icon name="externalLink" size={11} stroke={1.9} /></button>
          )}
        </span>
        {canExpand && (
          // Over the end of the line, on hover or keyboard focus: it never takes room from the text.
          <button type="button" className="dk-more" aria-expanded={expanded} aria-label={expanded ? t.logs.foldLine : t.logs.showLine} data-tip={expanded ? t.logs.foldLine : t.logs.showLine}
            onClick={(e) => { e.stopPropagation(); onExpand!(l.key); }}
            onKeyDown={(e) => { if (e.key === 'Escape' && expanded) { e.stopPropagation(); onExpand!(l.key); } }}>
            <Icon name="chevron" size={11} stroke={2} />
          </button>
        )}
      </div>
      {jsonOpen && json && <pre className="dk-json">{JSON.stringify(JSON.parse(text.trim()), null, 2)}</pre>}
    </>
  );
});

export function DockerLogs({ containers, stack, viewKey, visible, focused }: { containers: DockerContainer[]; stack: boolean; viewKey: string; visible: boolean; focused: boolean }) {
  const ids = useMemo(() => containers.map((c) => c.id), [containers]);
  // Only while on screen: a Docker tab behind another tab streams nothing; main keeps the lines a minute.
  useDockerWatch('logs', viewKey, visible ? ids : []);
  const logs = useDocker((s) => s.logs);
  const details = useDocker((s) => s.details);
  const project = useApp((s) => s.project);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [ts, setTs] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [since, setSince] = useState('all');
  const [limit, setLimit] = useState(SHOWN);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [folds, setFolds] = useState<ReadonlySet<string>>(() => new Set());
  const [jsons, setJsons] = useState<ReadonlySet<string>>(() => new Set());
  // Lines shown whole (by key) while not wrapping.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [paused, setPaused] = useState(false);
  const pausedAt = useRef(0);

  // Frames open in the editor through the container's bind mounts: its inspect, read once.
  useEffect(() => { for (const id of ids) if (!useDocker.getState().details[id]) void useDocker.getState().loadDetail(id); }, [ids]);

  // Replicas of one service (--scale) get their own tag; lines are keyed by container, never by name.
  const labels = useMemo(() => stackLabels(containers), [containers]);
  const all = useMemo<StackLine[]>(() => {
    if (stack) return mergeStack(containers.map((c) => ({ id: c.id, name: labels[c.id] ?? c.name, lines: logs[c.id]?.lines ?? [] })));
    const c = containers[0];
    return c ? (logs[c.id]?.lines ?? []).map((l) => ({ ...l, svc: c.name, cid: c.id, key: `${c.id}:${l.seq}` })) : [];
  }, [containers, logs, stack, labels]);
  const names = useMemo(() => Object.values(labels), [labels]);
  // Lines received since the reader scrolled up: by sequence, as the kept buffer stops growing once full.
  const received = containers.reduce((n, c) => n + (logs[c.id]?.lines.at(-1)?.seq ?? 0), 0);
  const windowed = useMemo(() => {
    const span = SINCE_MS[since];
    if (!span) return all;
    const from = Date.now() - span;
    return all.filter((l) => l.at === null || l.at >= from);
  }, [all, since]);
  const counts = useMemo(() => levelCounts(windowed), [windowed]);
  const filtered = useMemo(() => filterLines(windowed, level, query), [windowed, level, query]);
  const shown = filtered.length > limit ? filtered.slice(-limit) : filtered;
  const rows = useMemo(() => foldTraces(shown.map((l) => l.text), (i) => folds.has(shown[i]!.key)), [shown, folds]);
  const loaded = containers.every((c) => logs[c.id]?.loaded);
  const ended = !stack && containers[0] && containers[0].state !== 'running' && logs[containers[0].id]?.ended;

  const opener: Opener = useMemo(() => {
    const mountsOf = (cid: string): { mounts: Mount[]; workdir: string } | null => {
      const d = details[cid];
      return d ? { mounts: d.detail.mounts, workdir: d.detail.workingDir || '/' } : null;
    };
    return {
      where: (text, cid) => {
        const f = frameOf(text);
        const m = f && project ? mountsOf(cid) : null;
        if (!f || !m || !project) return null;
        const abs = f.path.startsWith('/') ? f.path : `${m.workdir.replace(/\/+$/, '')}/${f.path.replace(/^\.\//, '')}`;
        const host = hostPath(abs, m.mounts, project.root) ?? (project.realRoot !== project.root ? hostPath(abs, m.mounts, project.realRoot) : null);
        if (!host) return null;
        const base = isBelow(project.root, host) ? project.root : project.realRoot;
        return { path: host, rel: host.slice(base.length + 1), line: f.line };
      },
      open: (path, line) => {
        if (!project) return;
        const base = isBelow(project.root, path) ? project.root : project.realRoot;
        useApp.getState().openFile(path, path.slice(base.length + 1), line, undefined, { preview: true });
      }
    };
  }, [details, project]);

  // Stay at the bottom while there; someone reading further up is not dragged down (and sees how much arrived).
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown, wrap, ts]);
  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (bottom !== stick.current) {
      stick.current = bottom;
      setPaused(!bottom);
      if (!bottom) pausedAt.current = received;
    }
  };
  const toBottom = () => { const el = body.current; if (el) { stick.current = true; setPaused(false); el.scrollTop = el.scrollHeight; } };

  const keys = shown.map((l) => l.key);
  // Stable callbacks (the rows are memoized): they read the shown keys through a ref.
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const cursor = useRef<string | null>(null);
  const pick = useCallback((key: string, e: React.MouseEvent) => {
    // A drag that selected text in this line is a text selection, not a pick (a selection left elsewhere doesn't
    // count); links and chips inside handle themselves.
    const sel = window.getSelection();
    if ((e.target as HTMLElement).closest('button') || (sel && !sel.isCollapsed && sel.anchorNode && (e.currentTarget as HTMLElement).contains(sel.anchorNode))) return;
    sel?.removeAllRanges();
    const ks = keysRef.current;
    cursor.current = key;
    setSelected((cur) => {
      if (e.shiftKey && anchor.current && ks.includes(anchor.current)) {
        const [a, b] = [ks.indexOf(anchor.current), ks.indexOf(key)].sort((x, y) => x - y);
        return new Set(ks.slice(a!, b! + 1));
      }
      anchor.current = key;
      if (isMod(e)) { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; }
      return cur.size === 1 && cur.has(key) ? new Set() : new Set([key]);
    });
  }, []);
  const onJson = useCallback((k: string) => setJsons((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);
  const onExpand = useCallback((k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);
  /** → shows the picked lines that are cut whole, ← folds them back. */
  const expandPicked = (show: boolean) => setOpen((s) => {
    const n = new Set(s);
    for (const l of picked) {
      if (!show) n.delete(l.key);
      else if (isCut(body.current?.querySelector(`[data-key="${CSS.escape(l.key)}"] .dk-ln-msg`))) n.add(l.key);
    }
    return n;
  });
  /** ↑/↓ move the picked line (from the last one at first), ⇧ extends from the anchor; the line scrolls into view. */
  const step = (dir: 1 | -1, extend: boolean) => {
    if (!keys.length) return;
    const from = cursor.current && keys.includes(cursor.current) ? keys.indexOf(cursor.current) : dir === 1 ? -1 : keys.length;
    const at = Math.max(0, Math.min(keys.length - 1, from + dir));
    const key = keys[at]!;
    cursor.current = key;
    if (extend && anchor.current && keys.includes(anchor.current)) {
      const [a, b] = [keys.indexOf(anchor.current), at].sort((x, y) => x - y);
      setSelected(new Set(keys.slice(a!, b! + 1)));
    } else { anchor.current = key; setSelected(new Set([key])); }
    body.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  // Lines leaving the view (filters) leave the selection.
  const picked = shown.filter((l) => selected.has(l.key));
  const pickedText = () => picked.map((l) => `${ts && l.at !== null ? `${clock(l.at)} ` : ''}${stack ? `${l.svc} | ` : ''}${stripAnsi(l.text)}`);
  const subject = stack ? containers.find((c) => picked.some((l) => l.cid === c.id)) ?? containers[0] : containers[0];
  const target = sendTarget();
  const send = () => { if (subject && picked.length) { sendLines(subject, pickedText()); setSelected(new Set()); } };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape' && selected.size) { e.preventDefault(); e.stopPropagation(); setSelected(new Set()); }
    else if (e.key === 'a' && isMod(e)) { e.preventDefault(); setSelected(new Set(keys)); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.metaKey && !e.altKey) { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !wrap && picked.length && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); expandPicked(e.key === 'ArrowRight'); }
    else if (e.key === 'Enter' && e.altKey && picked.length) { e.preventDefault(); send(); }
    else if (e.key === 'c' && isMod(e) && picked.length && window.getSelection()?.isCollapsed) { e.preventDefault(); void copyText(pickedText().join('\n')); }
  };
  useEffect(() => { if (focused) body.current?.focus({ preventScroll: true }); }, [focused]);

  const newer = paused ? Math.max(0, received - pausedAt.current) : 0;
  const sinceLabel = t.docker.logs.sinceLabel(since);
  return (
    <div className={`dk-logs ${wrap ? 'is-wrap' : ''} ${ts ? '' : 'no-ts'} ${stack ? 'is-stack' : ''}`} onKeyDown={onKey}>
      <div className="dk-toolbar">
        <label className="dk-search">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.docker.logs.filter} aria-label={t.docker.logs.filter} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
        </label>
        <div className="dk-seg" role="radiogroup" aria-label={t.docker.logs.level}>
          {(['all', 'warn', 'err'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={level === v} className={level === v ? 'is-on' : ''} onClick={() => setLevel(v)}>
              {v === 'all' ? t.docker.logs.all : v === 'warn' ? t.docker.logs.warnings : t.docker.logs.errors}
              {v !== 'all' && <span className={`mono dk-seg-n ${v === 'warn' ? 'is-warn' : 'is-err'}`}>{v === 'warn' ? counts.warn : counts.err}</span>}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button type="button" className={`dk-chip ${ts ? 'is-on' : ''}`} aria-pressed={ts} aria-label={t.docker.logs.timestamps} data-tip={t.docker.logs.timestamps} onClick={() => setTs(!ts)}><Icon name="clock" size={12} /><span className="dk-chip-label">{t.docker.logs.timestamps}</span></button>
        <button type="button" className={`dk-chip ${wrap ? 'is-on' : ''}`} aria-pressed={wrap} aria-label={t.docker.logs.wrap} data-tip={t.docker.logs.wrap} onClick={() => setWrap(!wrap)}><Icon name="wrap" size={12} /><span className="dk-chip-label">{t.docker.logs.wrap}</span></button>
        <button type="button" className={`dk-chip mono ${since !== 'all' ? 'is-on' : ''}`} aria-haspopup="menu" aria-label={`${t.docker.logs.since}: ${sinceLabel}`}
          onClick={(e) => openBelow(e.currentTarget, Object.entries(t.docker.logs.sinceOpts).map(([k, label]) => ({ id: k, label, icon: k === since ? 'check' as const : undefined, run: () => setSince(k) })))}>
          {sinceLabel}<Icon name="chevronDown" size={10} stroke={2} />
        </button>
        {paused
          ? <button type="button" className="dk-live is-paused" onClick={toBottom}><i aria-hidden="true" />{t.docker.logs.paused}</button>
          : ended ? null : <span className="dk-live"><i className="pulse-live" aria-hidden="true" />{t.docker.logs.live}</span>}
      </div>
      <div ref={body} className="dk-lines mono" tabIndex={0} role="log" aria-label={t.docker.views.logs} onScroll={onScroll}>
        {filtered.length > limit && (
          <button type="button" className="dk-earlier" onClick={() => setLimit(limit + SHOWN)}>{t.docker.logs.earlier(filtered.length - limit)}</button>
        )}
        {rows.map((r) => {
          if (r.kind === 'fold') {
            const key = shown[r.index]!.key;
            return (
              <button key={`fold:${key}`} type="button" className="dk-fold" onClick={() => setFolds((s) => new Set(s).add(key))}>
                <Icon name="chevronDown" size={10} stroke={2} />{t.docker.logs.moreFrames(r.hidden)}
              </button>
            );
          }
          const l = shown[r.index]!;
          return <Line key={l.key} l={l} svcIndex={svcColor(l.svc, names)} stack={stack} ts={ts} selected={selected.has(l.key)} jsonOpen={jsons.has(l.key)} opener={opener} onPick={pick} onJson={onJson}
            expanded={!wrap && open.has(l.key)} onExpand={wrap ? undefined : onExpand} />;
        })}
        {!loaded && all.length === 0 && <p className="dk-lines-note">{t.docker.logs.loading}</p>}
        {loaded && all.length === 0 && <p className="dk-lines-note">{t.docker.logs.empty}</p>}
        {all.length > 0 && filtered.length === 0 && <p className="dk-lines-note">{t.docker.logs.emptyFiltered}</p>}
        {ended && all.length > 0 && <p className="dk-lines-end"><Icon name="stop" size={11} />{t.docker.logs.ended}</p>}
      </div>
      {paused && newer > 0 && <button type="button" className="dk-newer" onClick={toBottom}><Icon name="chevronDown" size={12} stroke={2} />{t.docker.logs.newLines(newer)}</button>}
      {picked.length > 0 && subject && (
        <div className="dk-selbar" role="toolbar" aria-label={t.docker.logs.selected(picked.length)}>
          <span className="dk-selbar-n">{t.docker.logs.selected(picked.length)}</span>
          <span className="dk-selbar-sep" aria-hidden="true" />
          <button type="button" className="btn-primary sm sel-send" disabled={!target} data-tip={target ? t.docker.logs.sendTip : t.docker.noSession} onClick={send}>
            <span className="dk-ellipsis">{target ? t.docker.logs.sendTo(target.title) : t.docker.logs.sendNone}</span><span className="kbd-in">{kbd('⌥↩')}</span>
          </button>
          <button type="button" className="btn-ghost sm" aria-label={t.docker.logs.askNew} data-tip={t.docker.logs.askNew} onClick={() => { askAboutLines(subject, pickedText()); setSelected(new Set()); }}><Icon name="sparkle" size={12} /><span className="dk-sel-long">{t.docker.logs.askNew}</span><span className="dk-sel-short">{t.docker.logs.askShort}</span></button>
          <button type="button" className="btn-ghost sm" aria-label={t.docker.logs.copy} onClick={() => void copyText(pickedText().join('\n')).then(() => useApp.getState().showToast(t.docker.copied(t.docker.logs.selected(picked.length)), undefined, 'info'))}><Icon name="copy" size={12} /><span className="dk-sel-long">{t.docker.logs.copy}</span></button>
          <button type="button" className="icon-btn" aria-label={t.docker.logs.clear} data-tip={t.docker.logs.clear} onClick={() => setSelected(new Set())}><Icon name="x" size={12} /></button>
        </div>
      )}
    </div>
  );
}
