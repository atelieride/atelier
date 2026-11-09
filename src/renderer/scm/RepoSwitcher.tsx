// The repository switcher: one large card for the selected repository; with more than one,
// it opens a dropdown with a filter and two groups (Active, All repositories). Never checks anything out.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { ScmRepoEntry } from '@shared/scm';
import { trackedCounts } from '@shared/git-write';
import { Icon } from '../components/Icon';
import { idStyle, initialOf } from '../avatar';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { repoMenu } from './actions';
import { liveSessions } from './data';
import { branchLine, branchTip, cursorIndex, repoLabel, switcherGroups, type SwitcherRow } from './view';

const CLOSE_MS = 120;

/** The label, its folder part dimmed and the filter's matched characters highlighted. */
function Label({ e, match }: { e: ScmRepoEntry; match: [number, number][] }) {
  const { dir, name } = repoLabel(e);
  const text = dir + name;
  const cuts = [...new Set([0, dir.length, text.length, ...match.flat()])].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  const seg = (from: number, to: number) => {
    const out: ReactNode[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]!; const b = cuts[i + 1]!;
      if (a < from || b > to || a === b) continue;
      const hit = match.some(([x, y]) => a >= x && b <= y);
      out.push(hit ? <mark key={a} className="sw-match">{text.slice(a, b)}</mark> : <Fragment key={a}>{text.slice(a, b)}</Fragment>);
    }
    return out;
  };
  return <span className="sw-label">{dir && <span className="sw-dir">{seg(0, dir.length)}</span>}<b>{seg(dir.length, text.length)}</b></span>;
}

function Chip({ e }: { e: ScmRepoEntry }) {
  const st = e.status;
  if (!st) return null;
  if (st.changes > 0) return <span className="sw-chip is-changes">{t.scm.changes(st.changes)}</span>;
  const { behind } = trackedCounts(st);
  if (behind > 0) return <span className="sw-chip is-behind">{t.scm.behindChip(behind)}</span>;
  return <span className="sw-chip is-clean" data-tip={t.scm.cleanTip} aria-label={t.scm.cleanTip}><Icon name="check" size={11} stroke={2.6} /></span>;
}

function Row({ row, index, cursor, selected, onPick, onHover }: { row: SwitcherRow; index: number; cursor: boolean; selected: boolean; onPick: (root: string) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (cursor) ref.current?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  const note = repoLabel(row.entry).note;
  const shown = row.sessions.slice(0, 3);
  return (
    <button ref={ref} type="button" role="option" aria-selected={selected} tabIndex={-1} className={`sw-row ${cursor ? 'is-cursor' : ''} ${selected ? 'is-selected' : ''}`}
      style={{ animationDelay: `${Math.min(index, 13) * 16}ms` }} onClick={() => onPick(row.entry.root)} onMouseMove={() => onHover(index)}
      onContextMenu={(e) => useApp.getState().openMenu(e, repoMenu(row.entry.root))}>
      <span className="sw-row-main">
        <span className="sw-row-title"><Label e={row.entry} match={row.match} />{note && <span className="sw-wt">{note}</span>}</span>
        <span className="sw-branch mono" data-tip={branchTip(row.entry.status)}>{branchLine(row.entry.status)}</span>
      </span>
      {shown.map((s) => <span key={s.id} className="sw-avatar" style={idStyle(s.color)} data-tip={s.title}>{initialOf(s.title)}</span>)}
      {row.sessions.length > 3 && <span className="sw-more">+{row.sessions.length - 3}</span>}
      <Chip e={row.entry} />
    </button>
  );
}

export function RepoSwitcher() {
  const entries = useApp((s) => s.scmRepos) ?? [];
  const selected = useApp((s) => s.scmRepo);
  const open = useApp((s) => s.scmSwitcherOpen);
  const setOpen = useApp((s) => s.setScmSwitcherOpen);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState('');
  // The cursor is the repository it is on, not a row number: the list may reorder while open.
  const [at, setAt] = useState<string | null>(null);
  const card = useRef<HTMLButtonElement>(null);
  const many = entries.length > 1;
  const cur = entries.find((e) => e.root === selected) ?? null;
  const pos = cur ? entries.indexOf(cur) + 1 : 0;
  // Sessions are read when the list opens (and as it filters): the closed card never follows them.
  const groups = useMemo(() => (open ? switcherGroups(entries, selected, liveSessions(), query) : null), [open, entries, selected, query]);
  const rows = groups ? [...groups.active, ...groups.all] : [];
  const cursor = cursorIndex(rows, at);
  const setCursor = (i: number) => setAt(rows[i]?.entry.root ?? null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setClosing(false);
  }, [open]);
  useEffect(() => {
    // On open the cursor starts on the selected repository; filtering puts it on the first match.
    setAt(query ? rows[0]?.entry.root ?? null : selected);
  }, [query, open]);

  const close = (focusCard: boolean) => {
    if (!open || closing) return;
    setClosing(true);
    const reduced = document.documentElement.dataset.motion === 'reduced';
    setTimeout(() => { setOpen(false); setClosing(false); if (focusCard) card.current?.focus(); }, reduced ? 0 : CLOSE_MS);
  };
  const pick = (root: string) => {
    if (root !== selected) useApp.getState().selectScmRepo(root);
    close(true);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) setCursor((cursor + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[cursor];
      if (r) pick(r.entry.root);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  if (!cur) return null;
  const label = repoLabel(cur);
  const changes = cur.status?.changes ?? 0;
  const body = (
    <>
      <span className="sw-tile" aria-hidden="true"><Icon name="git" size={16} stroke={1.8} /></span>
      <span className="sw-card-main">
        <span className="sw-card-title">
          <span className="sw-label">{label.dir && <span className="sw-dir">{label.dir}</span>}<b>{label.name}</b></span>
          {label.note && <span className="sw-wt">{label.note}</span>}
          {/* A narrow card keeps the count alone: the name needs the room. */}
          {changes > 0 && <span className="sw-chip is-changes" data-tip={t.scm.changes(changes)}>{changes}<span className="sw-chip-word"> {t.scm.changesWord(changes)}</span></span>}
        </span>
        <span className="sw-branch mono" data-tip={branchTip(cur.status)}>{branchLine(cur.status)}</span>
      </span>
      {many && (
        <span className="sw-card-side">
          <span className="sw-chev" aria-hidden="true"><Icon name="chevronDown" size={14} stroke={2} /></span>
          <span className="sw-pos mono">{t.scm.position(pos, entries.length)}</span>
        </span>
      )}
    </>
  );
  const shown = open && groups;
  return (
    <div className={`sw ${shown ? 'is-open' : ''}`}>
      {many ? (
        <button ref={card} type="button" className="sw-card" aria-haspopup="listbox" aria-expanded={!!shown} data-tip={shown ? undefined : t.scm.switchTip}
          onClick={() => (shown ? close(false) : setOpen(true))} onContextMenu={(e) => useApp.getState().openMenu(e, repoMenu(cur.root))}>{body}</button>
      ) : <div className="sw-card is-single" onContextMenu={(e) => useApp.getState().openMenu(e, repoMenu(cur.root))}>{body}</div>}
      {shown && (
        <>
          <button type="button" className={`scm-dim ${closing ? 'is-closing' : ''}`} aria-label={t.close} tabIndex={-1} onClick={() => close(false)} />
          <div className={`scm-drop ${closing ? 'is-closing' : ''}`} role="listbox" aria-label={t.scm.switchTip} onKeyDown={onKey}>
            <label className="sw-filter">
              <Icon name="search" size={12} stroke={1.8} />
              <input autoFocus value={query} placeholder={t.scm.filterRepos(groups.total)} aria-label={t.scm.filterRepos(groups.total)} spellCheck={false}
                onChange={(e) => setQuery(e.currentTarget.value)} />
            </label>
            <div className="sw-list">
              {groups.active.length > 0 && (
                <div className="sw-group" data-group="active">
                  <span className="sw-group-label">{t.scm.active}</span>
                  {groups.active.map((r, i) => <Row key={r.entry.root} row={r} index={i} cursor={cursor === i} selected={r.entry.root === selected} onPick={pick} onHover={setCursor} />)}
                </div>
              )}
              {groups.all.length > 0 && (
                <div className="sw-group" data-group="all">
                  <span className="sw-group-label">{t.scm.allRepos(groups.all.length)}</span>
                  {groups.all.map((r, j) => { const i = groups.active.length + j; return <Row key={r.entry.root} row={r} index={i} cursor={cursor === i} selected={r.entry.root === selected} onPick={pick} onHover={setCursor} />; })}
                </div>
              )}
              {rows.length === 0 && <p className="sw-empty">{t.scm.noMatch(query)}</p>}
            </div>
            <div className="sw-foot mono">{t.scm.switcherKeys}</div>
          </div>
        </>
      )}
    </div>
  );
}
