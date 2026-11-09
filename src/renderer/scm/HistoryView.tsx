// The History tab: toolbar (scope, filter, Graph | First parent, fetch age), the banner of a
// ref scope, the virtualized commit list with its graph, and the commit detail under it. Live: a change of refs or
// HEAD reloads the list in place.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { HISTORY_PAGE, type ScmCommit, type ScmLogPage, type ScmScope } from '@shared/scm';
import { isFilterEmpty, parseHistoryFilter } from '@shared/git-history';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import type { MenuItem } from '../menu-model';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { copy, defaultRef, showCompare, showHistory } from './actions';
import { loadRefs, loadRepos, useRepoStatus } from './data';
import type { RepoStatus } from '@shared/git';
import { CommitList, ROW_H, type CommitListHandle } from './CommitList';
import { CommitDetail } from './CommitDetail';
import { COMPARE_ROW, WORKTREE_ROW, appendPage, emptyRows, historyFooter, isPseudo, jumpNext, mergeReload, reloadChunks, stepSelection, type HistoryRows } from './history-model';
import { saveScmPrefs } from './prefs';
import { refsByOid, scopeTitle, shortRef } from './view';
import { FetchChip } from './FetchControls';
import { useViewFetch } from './view-fetch';
import { isMod } from '@shared/keys';
import { kbd } from '../kbd';

const scopeKey = (s: ScmScope) => (s.kind === 'compare' ? `c:${s.base}..${s.head}` : `r:${s.refs}:${s.firstParent}`);

export function HistoryView({ visible, focused = visible, place }: { visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const tab = useApp((s) => s.historyTab);
  if (!tab) return null;
  return <History key={tab.repo} visible={visible} focused={focused} place={place} />;
}

function History({ visible, focused, place }: { visible: boolean; focused: boolean; place?: CSSProperties }) {
  const tab = useApp((s) => s.historyTab)!;
  const repo = tab.repo;
  const scope = tab.scope;
  const refs = useApp((s) => s.scmRefs[repo]);
  const entry = useApp((s) => s.scmRepos?.find((e) => e.root === repo));
  const status = useRepoStatus(repo);
  const dirty = (status?.changes.length ?? 0) > 0;
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<HistoryRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [pill, setPill] = useState(0);
  // A compare's merge base: undefined until the first page says, null when the two sides share no history.
  const [mergeBase, setMergeBase] = useState<string | null | undefined>(undefined);
  const [moreFailed, setMoreFailed] = useState(false);
  // Commits that arrived with the last reload (they fade in), and the rows the old top moved by (applied after render).
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const pendingShift = useRef(0);
  // The fade is a one-time entrance: a row scrolled out and back in later doesn't fade again.
  useEffect(() => { if (!fresh.size) return; const id = setTimeout(() => setFresh(new Set()), 1500); return () => clearTimeout(id); }, [fresh]);
  const [compareCount, setCompareCount] = useState<number | null>(null);
  const list = useRef<CommitListHandle>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const rootEl = useRef<HTMLElement>(null);
  const loading = useRef(false);
  const gen = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => { if (!refs) void loadRefs(repo); }, [repo, refs]);
  // "When viewing": the History's repository while the tab is shown, and on window focus.
  useViewFetch(repo, visible);
  // Opened from Changes or a session before the sidebar was ever shown: the entries live events are matched against.
  useEffect(() => { if (useApp.getState().scmRepos === null) void loadRepos(); }, []);
  // Debounced filter (200 ms); main aborts the older log of the same view.
  useEffect(() => { const id = setTimeout(() => setFilter(filterText.trim()), 200); return () => clearTimeout(id); }, [filterText]);

  const parsed = useMemo(() => parseHistoryFilter(filter), [filter]);
  // A hex word alone: when it names a commit the list stays whole and jumps there; otherwise it is searched for.
  const shaOnly = !!parsed.sha && !parsed.words.length && !parsed.authors.length && !parsed.paths.length;
  const [jump, setJump] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setJump(undefined);
    if (!shaOnly || !parsed.sha) return;
    let alive = true;
    void window.atelier.scm.resolve(repo, parsed.sha).then((oid) => { if (alive) setJump(oid); }).catch(() => { if (alive) setJump(null); });
    return () => { alive = false; };
  }, [repo, filter]);
  const logFilter = isFilterEmpty(parsed) ? '' : shaOnly ? (jump === null ? filter : '') : filter;
  const filtered = logFilter !== '';
  const graphOn = !filtered;
  const firstParent = scope.kind === 'refs' && scope.firstParent;
  const headOid = !refs ? null : scope.kind === 'compare' ? (refs.refs.find((r) => r.name === scope.head)?.oid ?? (/^[0-9a-f]{40,64}$/.test(scope.head) ? scope.head : null))
    : scope.refs === 'all' ? refs.head.oid : refs.refs.find((r) => r.name === scope.refs)?.oid ?? null;
  const currentRef = refs?.refs.find((r) => r.current)?.name ?? null;
  const withWorktree = dirty && !filtered && scope.kind === 'refs' && (scope.refs === 'all' || scope.refs === currentRef) && !!refs?.head.oid;
  const byOid = useMemo(() => refsByOid(refs?.refs ?? []), [refs]);
  const head = refs?.head ?? { branch: null, oid: null, detached: false };

  /** The list read again down to `depth` commits (in pages main accepts), kept in place when `keep`. */
  const build = useCallback(async (depth: number, keep: boolean) => {
    if (!refs) return;
    const g = ++gen.current;
    loading.current = true;
    const fail = (e: Error): ScmLogPage => ({ commits: [], done: true, capped: false, error: e.message });
    let page: ScmLogPage = { commits: [], done: true, capped: false };
    const commits: ScmCommit[] = [];
    for (const [i, chunk] of reloadChunks(depth).entries()) {
      const p = await window.atelier.scm.log(repo, scope, chunk.skip, chunk.count, logFilter || undefined, i === 0 ? 'history' : 'history-more').catch(fail);
      if (g !== gen.current) return;
      page = i === 0 ? p : { ...p, ...('mergeBase' in page ? { mergeBase: page.mergeBase } : {}) };
      commits.push(...p.commits);
      if (p.error || p.done) break;
    }
    page = { ...page, commits };
    loading.current = false;
    if (page.error === 'aborted') return;
    // The branch or tag being viewed is gone (deleted in a terminal): back to all branches, said once.
    if (page.error === 'unknown ref' && !(scope.kind === 'refs' && scope.refs === 'all')) {
      useApp.getState().showToast(t.scm.history.unknownRef, undefined, 'info');
      showHistory('all');
      return;
    }
    setError(page.error && page.error !== 'aborted' ? page.error : null);
    setMoreFailed(false);
    if ('mergeBase' in page) setMergeBase(page.mergeBase ?? null);
    const next = appendPage(emptyRows(headOid, { worktree: withWorktree, compare: scope.kind === 'compare' }), page.commits, page, { graph: graphOn, firstParent });
    const prev = rowsRef.current;
    if (keep && prev) {
      const el = list.current?.scroller();
      // The first row on screen is the one that must not move.
      const r = mergeReload(prev, next, el ? Math.floor(el.scrollTop / ROW_H) : undefined);
      // Scrolled away from the top: the rows on screen stay where they are, after React drew the new ones.
      pendingShift.current = el && el.scrollTop > 0 ? r.shift : 0;
      // Another reload right after (a second event of the same commit) must not take the fade away: they add up.
      if (r.newOids.length) setFresh((f) => new Set([...f, ...r.newOids]));
      setRows(r.rows);
      if (r.added > 0 && el && el.scrollTop > 0) setPill((n) => n + r.added);
    } else {
      setRows(next);
      setFresh(new Set());
      setPill(0);
      list.current?.scroller()?.scrollTo({ top: 0 });
    }
  }, [repo, scopeKey(scope), logFilter, refs, headOid, withWorktree, graphOn, firstParent]);

  useLayoutEffect(() => {
    const el = list.current?.scroller();
    if (el && pendingShift.current) el.scrollTop += pendingShift.current * ROW_H;
    pendingShift.current = 0;
  }, [rows]);

  // A new scope, filter or graph mode: the list from the top.
  useEffect(() => { if (refs) void build(0, false); }, [repo, scopeKey(scope), logFilter, graphOn, firstParent, !!refs]);
  // Refs or HEAD changed (a commit, a fetch, a checkout in a terminal): reloaded in place, as deep as it was loaded.
  // (The refs arrive first — data.ts reloads them on every event — and the list follows them below.)
  const refsKey = refs ? `${refs.head.oid}|${refs.refs.map((r) => r.name + r.oid).join(',')}` : '';
  const lastRefs = useRef(refsKey);
  useEffect(() => {
    if (lastRefs.current === refsKey) return;
    const had = lastRefs.current !== '';
    lastRefs.current = refsKey;
    if (had && rowsRef.current) {
      const loaded = rowsRef.current.commits.filter((c) => !isPseudo(c.oid)).length;
      void build(loaded, true);
    }
  }, [refsKey]);
  // The working tree became dirty or clean: its row comes or goes.
  const wtKey = String(withWorktree);
  const lastWt = useRef(wtKey);
  useEffect(() => {
    if (lastWt.current === wtKey) return;
    lastWt.current = wtKey;
    const r = rowsRef.current;
    // Also while the first page is still on its way: that read started without the row (a newer one supersedes it).
    if (refs) void build(r ? r.commits.filter((c) => !isPseudo(c.oid)).length : 0, !!r);
  }, [wtKey]);

  const loadMore = useCallback(() => {
    const r = rowsRef.current;
    if (!r || r.done || loading.current || !refs) return;
    const g = gen.current;
    loading.current = true;
    const skip = r.commits.filter((c) => !isPseudo(c.oid)).length;
    void window.atelier.scm.log(repo, scope, skip, HISTORY_PAGE, logFilter || undefined, 'history-more').then((page) => {
      loading.current = false;
      if (g !== gen.current) return;
      if (page.error) { if (page.error !== 'aborted') setMoreFailed(true); return; }
      setRows((cur) => (cur && cur === rowsRef.current ? appendPage(cur, page.commits, page, { graph: graphOn, firstParent }) : cur));
    }).catch(() => { loading.current = false; setMoreFailed(true); });
  }, [repo, scopeKey(scope), logFilter, refs, graphOn, firstParent]);

  // Compare: how many commits the head side adds (an answer for a compare swapped meanwhile is dropped).
  useEffect(() => {
    setCompareCount(null);
    if (scope.kind !== 'compare') return;
    let alive = true;
    void window.atelier.scm.aheadBehind(repo, scope.base, scope.head).then((ab) => { if (alive) setCompareCount(ab?.ahead ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [repo, scopeKey(scope), refsKey]);

  // The commit a hex word named: selected, the list loaded down to it.
  const jumped = useRef<{ located: string | null; selected: string | null }>({ located: null, selected: null });
  useEffect(() => {
    if (!jump || !rows) return;
    const next = jumpNext(jump, rows, jumped.current);
    if (next.kind === 'select') { jumped.current.selected = jump; setSel(jump); list.current?.scrollToRow(next.at); return; }
    if (next.kind !== 'locate') return;
    // One deeper load per jump: a commit past the cap stays unselected rather than loading forever.
    let alive = true;
    void window.atelier.scm.locate(repo, scope, jump, 'history').then((idx) => {
      if (!alive) return;
      jumped.current.located = jump;
      if (idx !== null) void build(idx + 1 + HISTORY_PAGE, true);
    });
    return () => { alive = false; };
  }, [jump, rows]);

  // The selection: kept by commit across reloads; the first row by default.
  const index = rows ? rows.commits.findIndex((c) => c.oid === sel) : -1;
  useEffect(() => { if (rows && rows.commits.length && index < 0) setSel(rows.commits[0]!.oid); }, [rows, index]);
  const pick = useCallback((i: number) => { const c = rowsRef.current?.commits[i]; if (c) setSel(c.oid); }, []);
  // Double-click: that commit's first file at the commit (its own detail, not the one shown before).
  const openFirst = useCallback((i: number) => {
    const c = rowsRef.current?.commits[i];
    if (!c || isPseudo(c.oid)) return;
    setSel(c.oid);
    void window.atelier.scm.commit(repo, c.oid, null, 'open').then((d) => {
      const f = d.files.find((x) => x.kind !== 'D');
      if (f) useApp.getState().openRevFile({ root: repo, oid: c.oid, rel: f.rel });
    }).catch(() => {});
  }, [repo]);
  const detailRef = useRef<{ openFirst(): void; focusFiles(): void } | null>(null);

  useEffect(() => { if (visible && focused) list.current?.scroller()?.focus({ preventScroll: true }); }, [visible, focused, tab.nonce]);

  const def = defaultRef(repo);
  const menuFor = useCallback((i: number, e: ReactMouseEvent) => {
    const c = rowsRef.current?.commits[i];
    if (!c) return;
    setSel(c.oid);
    const m = t.scm.menu;
    const items: MenuItem[] = c.oid === WORKTREE_ROW
      ? [{ id: 'open-changes', label: m.openChanges, icon: 'git', run: () => { if (!useApp.getState().showChanges) useApp.getState().toggleChanges(); } }]
      : c.oid === COMPARE_ROW ? []
      : [
        { id: 'copy-sha', label: m.copySha, icon: 'copy', hint: kbd('⌘C'), run: () => copy(c.oid, t.scm.history.copied(c.oid.slice(0, 7))) },
        { id: 'copy-subject', label: m.copySubject, icon: 'copy', run: () => copy(c.subject) },
        'sep',
        ...(def ? [{ id: 'compare-default', label: m.compareDefault(def.base), icon: 'compare' as const, run: () => showCompare(def.name, c.oid) }] : []),
        ...(c.parents.length > 1 ? [{ id: 'compare-parent2', label: m.compareParent2, icon: 'compare' as const, run: () => detailRef.current && setAgainstFor(c.oid, c.parents[1]!) }] : []),
        ...(c.parents[0] ? [{ id: 'select-parent', label: m.selectParent, icon: 'commit' as const, run: () => selectOid(c.parents[0]!) }] : [])
      ];
    useApp.getState().openMenu(e, items);
  }, [def?.name]);
  const [against, setAgainst] = useState<{ oid: string; base: string } | null>(null);
  const setAgainstFor = (oid: string, base: string) => setAgainst({ oid, base });
  const selectOid = (oid: string) => {
    const r = rowsRef.current;
    const i = r ? r.commits.findIndex((c) => c.oid === oid) : -1;
    if (i >= 0) { setSel(oid); list.current?.scrollToRow(i); }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const r = rowsRef.current;
    if (!r) return;
    if (isMod(e) && e.key === 'c') {
      const c = r.commits[index];
      if (c && !isPseudo(c.oid)) { e.preventDefault(); copy(c.oid, t.scm.history.copied(c.oid.slice(0, 7))); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const page = Math.max(1, Math.floor((list.current?.scroller()?.clientHeight ?? 600) / ROW_H) - 1);
    const key = e.key === 'ArrowDown' || e.key === 'j' ? 'down' : e.key === 'ArrowUp' || e.key === 'k' ? 'up' : e.key === 'Home' ? 'home' : e.key === 'End' ? 'end' : e.key === 'PageDown' ? 'pageDown' : e.key === 'PageUp' ? 'pageUp' : null;
    if (key) {
      e.preventDefault();
      const next = stepSelection(r.commits.length, index < 0 ? null : index, key, page);
      if (next !== null) { setSel(r.commits[next]!.oid); list.current?.scrollToRow(next); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); detailRef.current?.focusFiles(); }
  };
  const onRootKey = (e: ReactKeyboardEvent) => {
    if (isMod(e) && e.key === 'f') { e.preventDefault(); filterInput.current?.focus(); filterInput.current?.select(); }
  };

  const repoName = entry?.name ?? repo.split('/').at(-1) ?? repo;
  const title = scopeTitle(scope);
  const selected = rows && index >= 0 ? rows.commits[index]! : null;
  const total = rows ? rows.commits.filter((c) => !isPseudo(c.oid)).length : 0;
  const foot = rows ? historyFooter(rows, { shallow: !!refs?.shallow, moreFailed }) : null;
  const footer = foot === 'loading' ? t.scm.loading : foot === 'capped' ? t.scm.history.capped(total) : foot === 'shallow' ? t.scm.history.shallow
    : foot === 'retry' ? <><span>{t.scm.history.moreFailed}</span><button type="button" className="btn-ghost sm" onClick={() => { setMoreFailed(false); loadMore(); }}>{t.scm.retry}</button></> : null;
  const pseudoLabel = (oid: string) => oid === WORKTREE_ROW
    ? <><i className="hv-wt-dot" aria-hidden="true" /><em>{t.scm.history.uncommitted}</em><WorktreeChip st={status} /></>
    : <><Icon name="compare" size={12} stroke={1.8} /><span>{t.scm.history.allChangesSince(scope.kind === 'compare' ? shortRef(scope.base) : '')}</span></>;
  const setFirstParent = (fp: boolean) => {
    if (scope.kind !== 'refs') return;
    const root = useApp.getState().project?.root;
    if (root) saveScmPrefs(root, { firstParent: fp });
    useApp.getState().openHistory({ scope: { ...scope, firstParent: fp } });
  };
  const viewingRef = scope.kind === 'refs' && scope.refs !== 'all' ? shortRef(scope.refs) : null;
  const swap = () => { if (scope.kind === 'compare') showCompare(scope.head, scope.base); };

  return (
    <section ref={rootEl} className="history-view" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={t.scm.history.tab(repoName)} onKeyDown={onRootKey}>
      <div className="hv-bar">
        <button type="button" className={`hv-scope ${scope.kind === 'compare' ? 'is-compare' : ''}`} data-tip={t.scm.history.scopeTip} onClick={() => useApp.getState().setRefPicker({ mode: 'scope' })}>
          <Icon name={scope.kind === 'compare' ? 'compare' : 'git'} size={13} stroke={1.8} />
          <span className="mono">{title}</span>
          {scope.kind === 'compare' && compareCount !== null && <span className="hv-scope-count">{` · ${t.scm.history.compareCount(compareCount)}`}</span>}
          <Icon name="chevronDown" size={12} stroke={2} />
        </button>
        {scope.kind === 'compare' && <button type="button" className="icon-btn hv-swap" aria-label={t.scm.history.swap} data-tip={t.scm.history.swap} onClick={swap}><Icon name="swap" size={14} /></button>}
        <label className="hv-filter" data-tip={t.scm.history.filterTip}>
          <Icon name="search" size={12} stroke={1.8} />
          <input ref={filterInput} value={filterText} placeholder={t.scm.history.filter} aria-label={t.scm.history.filter} spellCheck={false}
            onChange={(e) => setFilterText(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFilterText(''); list.current?.scroller()?.focus(); } if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); list.current?.scroller()?.focus(); } }} />
          {filterText && <button type="button" className="hv-filter-clear" aria-label={t.scm.history.clearFilter} onClick={() => setFilterText('')}><Icon name="x" size={11} stroke={2} /></button>}
        </label>
        {scope.kind === 'refs' && <Segmented label={t.scm.history.graph} value={scope.firstParent ? 'fp' : 'graph'} options={[{ value: 'graph', label: t.scm.history.graph }, { value: 'fp', label: t.scm.history.firstParent }]} onChange={(v) => setFirstParent(v === 'fp')} />}
        <span className="grow" />
        {total > 0 && <span className="hv-total mono">{t.scm.history.count(total)}{rows && !rows.done ? '+' : ''}</span>}
        <FetchChip root={repo} />
      </div>
      {viewingRef && (
        <div className="hv-banner" role="note">
          <Icon name="lock" size={11} stroke={2} />
          <span>{t.scm.history.viewing} <b className="mono">{viewingRef}</b> — {t.scm.history.stays} <b className="mono">{head.branch ?? head.oid?.slice(0, 7) ?? '—'}</b></span>
          <button type="button" className="btn-ghost sm" onClick={() => showHistory('all')}>{t.scm.history.showAll}</button>
        </div>
      )}
      <div className="hv-body">
        <div className="hv-list">
          <div className={`hv-head ${graphOn ? '' : 'no-graph'}`} aria-hidden="true">
            <span className="hv-msg">{t.scm.history.columns.message}</span><span className="hv-author">{t.scm.history.columns.author}</span>
            <span className="hv-date">{t.scm.history.columns.date}</span><span className="hv-sha">{t.scm.history.columns.commit}</span>
          </div>
          {pill > 0 && <button type="button" className="hv-new-pill" onClick={() => { list.current?.scroller()?.scrollTo({ top: 0, behavior: 'smooth' }); setPill(0); }}>{t.scm.history.newCommits(pill)}</button>}
          {error && <div className="hv-empty is-error">{t.scm.history.error(error)}</div>}
          {!error && rows && rows.commits.length === 0 && (
            <div className="hv-empty">
              {filter ? <><span>{t.scm.history.noMatch(filter)}</span><button type="button" className="btn-ghost sm" onClick={() => setFilterText('')}>{t.scm.history.clearFilter}</button></> : <span>{t.scm.history.empty}</span>}
            </div>
          )}
          {rows && rows.commits.length > 0 && (
            <CommitList ref={list} rows={rows} graph={graphOn} selected={index >= 0 ? index : null} byOid={byOid} head={head} pseudo={pseudoLabel} fresh={fresh}
              footer={footer} label={t.scm.history.tab(repoName)} onPick={pick} onOpen={openFirst} onMenu={menuFor} onNearEnd={loadMore}
              onScrollTop={(top) => { if (top < ROW_H && pill) setPill(0); }} onKey={onKey} />
          )}
        </div>
        {selected && (
          <CommitDetail ref={detailRef} repo={repo} commit={selected} refs={refs} byOid={byOid} status={status}
            compareBase={scope.kind === 'compare' ? { base: scope.base, mergeBase } : null}
            against={against && against.oid === selected.oid ? against.base : null} onAgainst={(base) => setAgainst(base ? { oid: selected.oid, base } : null)}
            onSelectParent={selectOid} onBackToList={() => list.current?.scroller()?.focus()} />
        )}
      </div>
    </section>
  );
}

/** "N files · +a −r" for the working tree row, from the repo's last status. */
function WorktreeChip({ st }: { st: RepoStatus | undefined }) {
  if (!st) return null;
  const added = st.changes.reduce((n, c) => n + (c.added ?? 0), 0);
  const removed = st.changes.reduce((n, c) => n + (c.removed ?? 0), 0);
  return <span className="hv-wt-chip mono">{t.scm.detail.files(st.changes.length)} · <span className="hv-plus">+{added}</span> <span className="hv-minus">−{removed}</span></span>;
}

