// The ref picker: a centered top sheet like the palette. Enter shows that branch or tag in
// the History tab (never checks it out); ⌥Enter compares it with the default branch; in compare mode Enter picks the
// other side. In switch mode ("Switch to Branch…") it lists branches only and Enter switches the
// selected repository to the one picked, asking first when a session works there.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ScmRef } from '@shared/scm';
import { Icon } from '../components/Icon';
import { idStyle, initialOf } from '../avatar';
import { relativeTime } from '../history';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { startSwitch } from '../git/branches';
import { defaultRef, showCompare, showHistory } from './actions';
import { liveSessions, loadRefs } from './data';
import { usePointerGate } from '../pointer-hover';
import { checkedOutIn, pickerGroups, rowCursor, type PickerItem } from './picker';
import { repoLabel, shortRef } from './view';
import { isBelow } from '@shared/paths';

const RECENT_KEY = 'atelier.scmRecentRefs';
const loadRecent = (root: string): string[] => { try { const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, unknown>; const l = all[root]; return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string').slice(0, 5) : []; } catch { return []; } };
const pushRecent = (root: string, name: string) => {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>;
    all[root] = [name, ...(all[root] ?? []).filter((x) => x !== name)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-50))));
  } catch { /* not saved */ }
};

type Row = { kind: 'ref'; key: string; item: PickerItem } | { kind: 'action'; key: string; id: 'compare' | 'all'; label: string };

function Hl({ text, match }: { text: string; match: number[] }) {
  if (!match.length) return <>{text}</>;
  const set = new Set(match);
  return <>{[...text].map((ch, i) => (set.has(i) ? <b key={i} className="rp-hit">{ch}</b> : <Fragment key={i}>{ch}</Fragment>))}</>;
}

export function RefPicker() {
  const picker = useApp((s) => s.refPicker)!;
  const switching = picker.mode === 'switch';
  // A switch is for the repository Source Control shows; viewing history follows the History tab's.
  const root = useApp((s) => (s.refPicker?.mode === 'switch' ? s.scmRepo : s.historyTab?.repo ?? s.scmRepo));
  const refs = useApp((s) => (root ? s.scmRefs[root] : undefined));
  const entry = useApp((s) => s.scmRepos?.find((e) => e.root === root));
  const [query, setQuery] = useState('');
  // The highlighted row by its key, not its place: a refs reload (a session's commit) reorders Local while open.
  const [at, setAt] = useState<string | null>(null);
  const moved = usePointerGate();
  // "N ahead" counts belong to one refs read: a newer one (a commit while the picker is open) starts them again.
  const [aheadOf, setAheadOf] = useState<{ refs: unknown; map: Record<string, number | null> }>({ refs: undefined, map: {} });
  const list = useRef<HTMLDivElement>(null);
  const close = () => useApp.getState().setRefPicker(null);
  useEffect(() => { if (root && !refs) void loadRefs(root); }, [root, refs]);
  const def = defaultRef(root);
  // Switching: branches only (a tag would detach HEAD).
  const groups = useMemo(() => (refs && root ? pickerGroups(switching ? { ...refs, refs: refs.refs.filter((r) => r.kind !== 'tag') } : refs, query, loadRecent(root)) : null), [refs, query, root, switching]);
  const placeholder = switching ? t.git.branch.switchPicker : t.scm.picker.placeholder;
  const sections: { title: string; rows: Row[] }[] = [];
  if (groups) {
    const refRows = (group: string, items: PickerItem[]) => items.map((item): Row => ({ kind: 'ref', key: `${group}:${item.ref.name}`, item }));
    if (groups.recent.length) sections.push({ title: t.scm.picker.recent, rows: refRows('recent', groups.recent) });
    if (groups.local.length) sections.push({ title: t.scm.picker.local, rows: refRows('local', groups.local) });
    if (groups.remote.length) sections.push({ title: t.scm.picker.remote, rows: refRows('remote', groups.remote) });
    if (groups.tags.length) sections.push({ title: t.scm.picker.tags, rows: refRows('tags', groups.tags) });
  }
  const flat = sections.flatMap((s) => s.rows);
  // Compare is offered for the ref highlighted last, kept while the cursor is on the actions below.
  const lastRef = useRef<string | null>(null);
  if (!at?.startsWith('action:')) lastRef.current = at;
  const cur = flat[rowCursor(flat.map((r) => r.key), lastRef.current)];
  const curRef = cur?.kind === 'ref' ? cur.item.ref : null;
  const actions: Row[] = picker.mode === 'scope' ? [
    ...(curRef && def && curRef.name !== def.name ? [{ kind: 'action' as const, key: 'action:compare', id: 'compare' as const, label: t.scm.picker.compare(curRef.short, def.base) }] : []),
    { kind: 'action', key: 'action:all', id: 'all', label: t.scm.picker.showAll }
  ] : [];
  const rows = [...flat, ...actions];
  const active = rowCursor(rows.map((r) => r.key), at);
  const setActive = (i: number) => setAt(rows[i]?.key ?? null);
  useEffect(() => { setAt(null); }, [query]);
  // The first ref shown is pinned by its key at once: Enter before any arrow must still pick what was highlighted. Only a
  // ref: before the refs are read the actions are the only rows, and the cursor must not stay on one once they come.
  useEffect(() => {
    if (at !== null && rows.some((r) => r.key === at)) return;
    const first = flat[0]?.key ?? null;
    if (first !== at) setAt(first);
  });
  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  // "N ahead of main" for the local branches on screen (at most 8 asked), cached per refs read.
  const visibleLocals = flat.filter((r): r is Extract<Row, { kind: 'ref' }> => r.kind === 'ref' && r.item.ref.kind === 'head').slice(0, 8).map((r) => r.item.ref.name);
  const askKey = visibleLocals.join(',');
  const ahead = aheadOf.refs === refs ? aheadOf.map : {};
  useEffect(() => {
    if (!root || !def || !refs) return;
    let alive = true;
    for (const name of visibleLocals) {
      if (name === def.name || name in ahead) continue;
      void window.atelier.scm.aheadBehind(root, def.name, name).then((ab) => {
        if (alive) setAheadOf((a) => ({ refs, map: { ...(a.refs === refs ? a.map : {}), [name]: ab?.ahead ?? null } }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [askKey, refs]);

  const choose = (r: Row | undefined, alt: boolean) => {
    if (!r || !root) return;
    close();
    if (r.kind === 'action') {
      if (r.id === 'all') showHistory('all');
      else if (curRef && def) showCompare(def.name, curRef.name);
      return;
    }
    const ref = r.item.ref;
    pushRecent(root, ref.name);
    if (switching) { if (!ref.current) void startSwitch(root, ref.name); return; }
    if (picker.mode === 'compare' && picker.head) { showCompare(ref.name, picker.head); return; }
    if (picker.mode === 'compare' && picker.base) { showCompare(picker.base, ref.name); return; }
    if (alt && def && def.name !== ref.name) showCompare(def.name, ref.name);
    else showHistory(ref.name);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) setActive((active + 1) % rows.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) setActive((active - 1 + rows.length) % rows.length); return; }
    if (e.key === 'Enter') { e.preventDefault(); choose(rows[active], e.altKey); }
  };
  const worktreeOf = (r: ScmRef) => {
    if (r.kind !== 'head') return null;
    const e = checkedOutIn(useApp.getState().scmRepos, root, r.short);
    return e && e.root !== root ? repoLabel(e).name : null;
  };
  const sessionOn = (r: ScmRef) => {
    const e = r.kind === 'head' ? checkedOutIn(useApp.getState().scmRepos, root, r.short) : null;
    return e ? liveSessions().find((s) => s.cwd === e.root || isBelow(e.root, s.cwd)) ?? null : null;
  };
  let n = -1;
  const branch = refs?.head.branch;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`palette ref-picker ${switching ? 'is-switch' : ''}`} role="dialog" aria-label={placeholder} onKeyDown={onKey}>
        <div className="palette-search">
          <Icon name={picker.mode === 'compare' ? 'compare' : switching ? 'swap' : 'git'} size={15} />
          <input className="palette-input" autoFocus value={query} placeholder={picker.mode === 'compare' && picker.head ? t.scm.picker.compare(shortRef(picker.head), '…') : placeholder}
            aria-label={placeholder} spellCheck={false} onChange={(e) => setQuery(e.currentTarget.value)} />
          {entry && <span className="palette-mode rp-repo">{repoLabel(entry).name}</span>}
        </div>
        <div className="palette-list" ref={list}>
          {sections.map((s) => (
            <div key={s.title}>
              <div className="palette-section">{s.title}</div>
              {s.rows.map((r) => {
                n++;
                const idx = n;
                if (r.kind !== 'ref') return null;
                const ref = r.item.ref;
                const wt = worktreeOf(ref);
                const who = sessionOn(ref);
                const a = ahead[ref.name];
                return (
                  <button key={r.key} type="button" className={`palette-item rp-item ${idx === active ? 'is-active' : ''}`} onMouseMove={(e) => { if (moved(e)) setActive(idx); }} onClick={(e) => choose(r, e.altKey)}>
                    <span className={`palette-cmd rp-icon is-${ref.kind}`}><Icon name={ref.kind === 'tag' ? 'tag' : 'git'} size={11} stroke={2} /></span>
                    <span className="rp-main">
                      <span className="palette-label mono"><Hl text={ref.short} match={r.item.match} /></span>
                      <span className="rp-sub">
                        {ref.current && <span className="ref-head-pill">HEAD</span>}
                        {who && <span className="ref-session" style={idStyle(who.color)}>{initialOf(who.title)}</span>}
                        {wt && <span>{t.scm.worktreeOf(wt)}</span>}
                        {a !== undefined && a !== null && a > 0 && def && <span>{t.scm.picker.ahead(a, def.base)}</span>}
                      </span>
                    </span>
                    <span className="palette-hint">{ref.date ? relativeTime(ref.date * 1000, Date.now()) : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {groups && flat.length === 0 && <p className="empty">{switching ? t.git.branch.noBranch : t.scm.picker.none}</p>}
          {actions.length > 0 && (
            <div>
              <div className="palette-section">{t.scm.picker.actions}</div>
              {actions.map((r) => {
                n++;
                const idx = n;
                return (
                  <button key={r.key} type="button" className={`palette-item ${idx === active ? 'is-active' : ''}`} onMouseMove={(e) => { if (moved(e)) setActive(idx); }} onClick={() => choose(r, false)}>
                    <span className="palette-cmd"><Icon name={r.kind === 'action' && r.id === 'compare' ? 'compare' : 'git'} size={11} stroke={2} /></span>
                    <span className="palette-label">{r.kind === 'action' ? r.label : ''}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="palette-foot">
          {switching
            ? <span className="rp-foot"><Icon name="swap" size={10} stroke={2} />{branch ? t.git.branch.switchFooter(branch) : t.git.branch.switchFooterDetached}</span>
            : <span className="rp-foot"><Icon name="lock" size={10} stroke={2} />{branch ? t.scm.picker.footer(branch) : t.scm.picker.footerDetached}</span>}
          <span className="grow" />
          {picker.mode === 'scope' && <span className="mono">{t.scm.picker.compareHint}</span>}
          <span className="mono">↑↓ ↵</span>
        </div>
      </div>
    </div>
  );
}
