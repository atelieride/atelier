import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChangeKind, RepoStatus } from '@shared/git';
import type { TerminalInfo } from '@shared/protocol';
import { CHANGES_CAP, capShown, sessionRoots, buildRows, clashChipLabels, clashChipsShown, clashSessionTip, cleanRepos, unreadableRepos, fileList, groupBySession, locationRows, overlapGroups, sessionOrderKey, sureBy, touchedBy, unsureOf, type ChangeBy, type ChangeRow } from '../changes';
import { OriginMarks } from './OriginMarks';
import { branchLabel, toMerge, hideWorktreeFolders, isWorktree, locationOf, meetGroups, nestWorktrees, realPath, showLocations, treeOf, type MeetSide, type WtView } from '../worktrees';
import { effectiveState } from '@shared/background';
import { isLimitPaused } from '@shared/session-view';
import { shownState } from '../selectors';
import { Avatar } from './Avatar';
import { t } from '../i18n/en';
import type { MenuItem } from '../menu-model';
import { repoMenu } from '../scm/actions';
import { useViewFetches, viewFetchKey } from '../scm/view-fetch';
import { lookingForRepos } from '../scm/view';
import { useApp } from '../store';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { changeMenu, worktreeMenu } from '../menus';
import { groupKey } from '../changes-prefs';
import { collapsedFlash, flashOffset, nextFlash, type FlashBaseline } from '../changes-flash';
import { commitWork, toggleStage } from '../git/actions';
import { groupShown, keptFamily, keptSession, type FoldState } from '../git/fold';
import { CommitArea } from '../git/CommitBar';
import { GitCheck } from '../git/GitCheck';
import { sessionGitItems } from '../git/menu-items';
import { folderParts, groupBox, headCount, repoPathOf, rowBox, stagedDot, type HeadCount } from '../git/rows';
import { GitMissing } from '../git/GitMissing';
import { gitMissing } from '../git/missing';
import { RepoTrouble } from '../git/RepoTrouble';
import { isBelow } from '@shared/paths';
import { idStyle } from '../avatar';
import { changesInWorkspace } from '../workspace-view';
import { ChangesFilters } from './ChangesFilters';
import { CleanState } from './CleanState';
import { SyncCounts } from './SyncCounts';
import { toSyncOf } from '../sync';

/** The drawer's folding as the groups need it: the target, and whether the drawer is open with what was unfolded. */
interface FoldView { target: string | null; state: FoldState }

const KIND_CLASS: Record<ChangeKind, string> = { M: 'k-mod', A: 'k-add', '?': 'k-add', D: 'k-del', R: 'k-ren', U: 'k-conf' };

/** How long a new row's flash lasts: the CSS animation's length, and the static tint's with reduced motion. */
const FLASH_MS = 1200;
/** The paths flashing in right now, with when their flash started. */
const Flashing = createContext<ReadonlyMap<string, number>>(new Map());
const flashColor = (r: ChangeRow) => sureBy(r.by)[0]?.color;

/**
 * The rows that joined the list since the last one flash for FLASH_MS (changes-flash.ts: the first list, a new repo's
 * first list and another project flash nothing).
 */
function useChangesFlash(rows: ChangeRow[], repos: RepoStatus[], project: string): ReadonlyMap<string, number> {
  const base = useRef<FlashBaseline | null>(null);
  const tokens = useRef(new Map<string, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [flashing, setFlashing] = useState<ReadonlyMap<string, number>>(() => new Map());
  const key = `${project}\0${repos.map((r) => r.root).join('\n')}\0${rows.map((r) => r.path).join('\n')}`;
  useLayoutEffect(() => {
    const { fresh, baseline } = nextFlash(base.current, rows, project, repos.map((r) => r.root));
    base.current = baseline;
    if (fresh.size === 0) return;
    const since = Date.now();
    const token = since + Math.random();
    for (const p of fresh) tokens.current.set(p, token);
    setFlashing((prev) => { const next = new Map(prev); for (const p of fresh) next.set(p, since); return next; });
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      // Only the flash this timer started: a path that left and came back meanwhile keeps its newer one.
      const done = [...fresh].filter((p) => tokens.current.get(p) === token);
      for (const p of done) tokens.current.delete(p);
      setFlashing((prev) => { const next = new Map(prev); for (const p of done) next.delete(p); return next; });
    }, FLASH_MS);
    timers.current.add(timer);
    // The key says when the list changed (rows is a new array on every render).
  }, [key]);
  useEffect(() => () => { for (const x of timers.current) clearTimeout(x); }, []);
  return flashing;
}

function delta(r: ChangeRow): string {
  if (r.added === null && r.removed === null) return '';
  if (!r.removed) return `+${r.added ?? 0}`;
  return `+${r.added ?? 0} −${r.removed}`;
}

/** Git writes on (Settings › Source Control › Git actions), and whether the checkbox column shows (drawer open). */
function useStaging(): { writes: boolean; column: boolean } {
  const writes = useApp((s) => s.settings.gitActions === 'on');
  const open = useApp((s) => s.gitDrawer.open);
  return { writes, column: writes && open };
}

/** By session: the repository in front of the folder; `multi`: the project has several working trees. */
type RepoLabel = { label: string; multi: boolean };

function Row({ row, showRepo, compact, repo = null }: { row: ChangeRow; showRepo: boolean; compact: boolean; repo?: RepoLabel | null }) {
  const openFile = useApp((s) => s.openFile);
  const activeTab = useApp((s) => s.activeTab);
  const { writes, column } = useStaging();
  const parts = row.rel.split('/');
  const name = parts.pop() ?? row.rel;
  const dir = parts.join('/') || '.';
  const repoName = row.repo.split('/').at(-1) ?? '';
  const folder = folderParts(dir, showRepo ? repo ?? { label: repoName, multi: false } : null);
  const unsure = unsureOf(row).length > 0;
  const since = useContext(Flashing).get(row.path);
  const isNew = since !== undefined;
  const color = flashColor(row);
  // Fixed at mount: a row remounted mid-flash (it moved group) carries on instead of starting over.
  const offset = useMemo(() => (since === undefined ? 0 : flashOffset(since, Date.now())), [since]);
  // Read-only: the rows as before, no dot.
  const dot = writes ? stagedDot(row) : null;
  const box = column ? rowBox(row) : null;
  const toggle = () => void toggleStage([row]);
  // Space on a focused row toggles it while the column shows; keyup too, or the button would click (open).
  const onSpace = (e: React.KeyboardEvent) => {
    if (!box || e.key !== ' ') return;
    e.preventDefault();
    if (e.type === 'keydown' && !e.repeat && !box.disabled) toggle();
  };
  const button = (
    <button type="button" className={`change-row ${activeTab === row.path ? 'is-active' : ''} ${unsure && sureBy(row.by).length === 0 ? 'is-unsure' : ''} ${isNew ? 'is-new' : ''}`}
      style={isNew ? { ...(color ? { ['--flash' as string]: color } : {}), animationDelay: `${offset}ms, ${offset}ms` } : undefined}
      onClick={() => openFile(row.path, row.rel, null, row.kind === 'D' ? 'margin' : 'diff', { preview: true })}
      onDoubleClick={() => openFile(row.path, row.rel, null, row.kind === 'D' ? 'margin' : 'diff')}
      onKeyDown={box ? onSpace : undefined} onKeyUp={box ? onSpace : undefined}
      title={[compact && showRepo ? `${repoName}/${row.rel}` : row.rel, delta(row), dot === 'all' ? t.git.staged : dot === 'partial' ? t.git.partlyStaged : ''].filter(Boolean).join(' · ')}
      onContextMenu={(e) => useApp.getState().openMenu(e, changeMenu({ path: row.path, rel: row.rel, deleted: row.kind === 'D', unsure, git: row }))}>
      <span className="change-icon">
        <FileIcon name={name} size={compact ? 14 : 16} />
        {dot && <i className={`git-dot is-${dot}`} />}
      </span>
      <span className="change-main">
        <span className="change-name">{name}</span>
        {!compact && (folder.repo !== null && repo?.multi
          // Two parts that each truncate inside the line (the repository's path a little brighter).
          ? <span className="change-dir mono is-repo"><span className="change-dir-repo">{folder.repo}</span>{folder.dir !== null && <span className="change-dir-in">{folder.sep}{folder.dir}</span>}</span>
          : <span className="change-dir mono">{folder.repo !== null ? `${folder.repo}${folder.sep}${folder.dir ?? ''}` : folder.dir}</span>)}
      </span>
      <span className="change-by"><OriginMarks row={row} unknown /></span>
      <span className="change-delta mono">{delta(row)}</span>
      <span className={`change-kind mono ${KIND_CLASS[row.kind]}`}>{row.kind === '?' ? 'A' : row.kind}</span>
    </button>
  );
  // Drawer closed: the row exactly as before (no wrapper); open: its checkbox before it, a sibling of the button.
  if (!box) return button;
  return (
    <div className="change-line">
      <GitCheck state={box.state} disabled={box.disabled} label={t.git.checkFile(name)} onToggle={toggle} />
      {button}
    </div>
  );
}

/**
 * What a group header stages: its rows (the checkbox and the count), the checkbox's name,
 * and, on a session, the "Commit…" pill shown on hover in place of the count.
 */
interface HeadGit { rows: ChangeRow[]; label: string; pill?: () => void }

/** A group's chevron or header click: collapses it, or, while the drawer folds it, unfolds it until the drawer closes. */
function toggleGroup(id: string, unfoldable: boolean, alt: boolean, all: string[]) {
  if (unfoldable) useApp.getState().toggleGitUnfold(id);
  else useApp.getState().toggleChangesGroup(id, alt ? all : undefined);
}

/** A group header's checkbox, or the room for one (a group without rows to check) so headers stay aligned. */
function HeadCheck({ git }: { git: HeadGit }) {
  const box = groupBox(git.rows);
  if (!box) return <span className="git-check-space" />;
  return <GitCheck state={box.state} disabled={box.disabled} label={t.git.checkGroup(git.label)} onToggle={() => void toggleStage(git.rows)} />;
}

/**
 * Group header: a real button (keyboard, aria-expanded); ⌥-click collapses or expands every group of the grouping.
 * `shown`: whether its rows show (the user's collapsing, or the drawer's folding).
 */
function GroupHead({ id, all, count, unsure = 0, children, review, menu, rows = [], git, shown }: { id: string; all: string[]; count: number; unsure?: number; children: ReactNode; review?: { label: string; run: () => void }; menu?: () => MenuItem[]; rows?: ChangeRow[]; git?: HeadGit; shown: { open: boolean; unfoldable: boolean } }) {
  const { open, unfoldable } = shown;
  const flash = useFlashOf(rows, open);
  const { writes, column } = useStaging();
  const items = () => [...(menu?.() ?? []), ...(review ? [{ id: 'review-session', label: t.menu.reviewSession, icon: 'review' as const, run: review.run }] : [])];
  const pill = writes && git?.pill ? git.pill : null;
  const head = (
    <button type="button" className="change-group-head" aria-expanded={open} data-tip={t.groupTip}
      onClick={(e) => toggleGroup(id, unfoldable, e.altKey, all)}
      onContextMenu={review || menu ? (e) => { const list = items(); if (list.length) useApp.getState().openMenu(e, list); } : undefined}>
      <span className={`change-group-chev ${open ? 'is-open' : ''}`} aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span>
      {children}
      <span className="grow" />
      {(count > 0 || unsure === 0) && (writes && git ? <StageCount count={headCount(git.rows, column, count)} flash={flash} /> : <FilesCount n={count} flash={flash} />)}
      {unsure > 0 && <span className="unsure-count mono" data-tip={t.unsure.countTip(unsure)}>{t.unsure.count(unsure, count)}</span>}
    </button>
  );
  if (!review && !column && !pill) return head;
  // Siblings of the toggle, never a button inside a button: the checkbox, a session's "Commit…" and its review.
  return (
    <div className={`change-group-row ${pill ? 'has-pill' : ''}`}>
      {column && git && <HeadCheck git={git} />}
      {head}
      {pill && <button type="button" className="git-commit-pill" onClick={pill}>{t.git.commitPill}</button>}
      {review && <button type="button" className="icon-btn change-group-review" aria-label={review.label} data-tip={review.label} onClick={review.run}><Icon name="review" size={14} /></button>}
    </div>
  );
}

/** A header's count with what is staged: "3 staged · 4" with the drawer closed, "2 of 3" with it open. */
function StageCount({ count, flash }: { count: HeadCount; flash: { color: string | undefined } | null }) {
  if (count.kind === 'files') return <FilesCount n={count.n} flash={flash} />;
  return (
    <span className={`change-count git-count ${flash ? 'is-new' : ''}`} style={flash?.color ? { ['--flash' as string]: flash.color } : undefined}>
      {count.kind === 'staged'
        ? <><span className="git-staged">{t.git.stagedCount(count.staged)}</span> · {count.n}</>
        : <><span className="git-staged">{count.staged}</span><span className="count-unit">{t.git.ofUnit}</span><span className="git-of-slash">/</span>{count.n}</>}
    </span>
  );
}

/** The live sessions working inside a working tree (their cwd, or Claude's own when known). */
function sessionsIn(root: string, repos: RepoStatus[], terminals: TerminalInfo[], project: { root: string; realRoot?: string | null } | null): TerminalInfo[] {
  return terminals.filter((x) => x.session && treeOf(repos, realPath(x.session.cwd ?? x.cwd, project))?.root === root);
}

function WtAvatars({ here }: { here: TerminalInfo[] }) {
  if (!here.length) return null;
  return (
    <span className="wt-avatars" data-tip={t.wt.working(here.map((x) => x.title))}>
      {/* A click on an avatar goes to its session; it never toggles the header it sits in. */}
      {here.slice(0, 3).map((x) => (
        <span key={x.id} className="wt-avatar" data-tip={t.wt.goTo(x.title)} onClick={(e) => { e.stopPropagation(); useApp.getState().select(x.id); }}>
          <Avatar title={x.title} color={x.color} state={shownState(x)} size={16} />
        </span>
      ))}
      {here.length > 3 && <span className="wt-more mono">+{here.length - 3}</span>}
    </span>
  );
}

/** A linked worktree in its repo's lane: its files, or one line with what it has to merge. */
function WorktreeGroup({ w, all, repos, compact, fold }: { w: WtView; all: string[]; repos: RepoStatus[]; compact: boolean; fold: FoldView }) {
  const id = groupKey('repo', w.status.root);
  const collapsed = useApp((s) => s.changesCollapsed);
  const { open, unfoldable } = groupShown(id, fold.target ? groupKey('repo', fold.target) : null, fold.state, collapsed);
  const flash = useFlashOf(w.rows, open);
  const { writes, column } = useStaging();
  const terminals = useApp((s) => s.terminals);
  const project = useApp((s) => s.project);
  const here = sessionsIn(w.status.root, repos, terminals, project);
  const projectRoot = project?.realRoot ?? project?.root ?? '';
  const path = isBelow(projectRoot, w.status.root) ? w.status.root.slice(projectRoot.length + 1) : w.status.root;
  const m = w.status.merge;
  const ahead = toMerge(w.status);
  const mergeTip = m && ahead ? t.wt.toMergeTip(ahead, m.base) : null;
  const tip = t.wt.headTip(path, branchLabel(w.status), mergeTip);
  const menu = (e: React.MouseEvent) => useApp.getState().openMenu(e, worktreeMenu(w.status));
  const compare = () => useApp.getState().openReview(`repo:${w.status.root}`, { againstMain: true });
  if (w.state === 'merge') {
    return (
      <div className="change-wt" data-root={w.status.root}>
        <div className="wt-line" onContextMenu={menu}>
          <button type="button" className="wt-line-main" data-tip={tip} onClick={compare}>
            <span className="wt-glyph"><Icon name="branchOff" size={13} stroke={1.8} /></span>
            <span className="wt-name">{w.name}</span>
            <SyncCounts status={w.status} />
            <WtAvatars here={here} />
            <span className="wt-ahead mono" data-tip={mergeTip ?? undefined}>↑{ahead}<span className="wt-ahead-unit">{t.wt.toMergeUnit}</span></span>
          </button>
          <button type="button" className="icon-btn wt-compare" aria-label={t.wt.compareWith(m!.base)} data-tip={t.wt.compareWith(m!.base)} onClick={compare}><Icon name="compare" size={14} /></button>
        </div>
      </div>
    );
  }
  const head = (
    <button type="button" className="change-group-head wt-head" aria-expanded={open} data-tip={tip}
      onClick={(e) => toggleGroup(id, unfoldable, e.altKey, all)} onContextMenu={menu}>
      <span className="wt-glyph"><Icon name="branchOff" size={13} stroke={1.8} /></span>
      <span className="change-group-title wt-name">{w.name}</span>
      <SyncCounts status={w.status} />
      <WtAvatars here={here} />
      {ahead > 0 && <span className="wt-ahead mono">↑{ahead}</span>}
      <span className="grow" />
      {writes ? <StageCount count={headCount(w.rows, column)} flash={flash} /> : <FilesCount n={w.rows.length} flash={flash} />}
      {/* At the right end: on the left it would push the glyph in, as if nested under the worktree above. */}
      <span className={`change-group-chev ${open ? 'is-open' : ''}`} aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span>
    </button>
  );
  return (
    <div className="change-wt" data-root={w.status.root}>
      {column ? <div className="change-group-row"><HeadCheck git={{ rows: w.rows, label: w.name }} />{head}</div> : head}
      {open && w.rows.map((r) => <Row key={r.path} row={r} showRepo={false} compact={compact} />)}
    </div>
  );
}

/** Two or more sessions on the same files (spec compact clash notice): their avatars, then the files as chips. */
function ClashCard({ by, rows, repos }: { by: ChangeBy[]; rows: ChangeRow[]; repos: RepoStatus[] }) {
  const terminals = useApp((s) => s.terminals);
  const project = useApp((s) => s.project);
  const openFile = useApp((s) => s.openFile);
  const [all, setAll] = useState(false);
  const chipsEl = useRef<HTMLSpanElement>(null);
  const labels = clashChipLabels(rows.map((r) => r.rel));
  const shown = all ? rows.length : clashChipsShown(rows.length);
  // "+N more" goes away under the focus: the focus moves to the first file it showed.
  const showAll = () => { const from = shown; setAll(true); requestAnimationFrame(() => chipsEl.current?.querySelectorAll<HTMLElement>('.clash-chip')[from]?.focus()); };
  // An attribution keeps the title of its edit's moment: an open session's name is today's.
  const titleOf = (b: ChangeBy) => terminals.find((x) => x.id === b.terminalId)?.title ?? b.title;
  return (
    <div className="clash" role="group" aria-label={t.clash.label(touchedBy(by.map(titleOf)), rows.length)}>
      <span className="clash-title">
        <span className="clash-avatars">
          {by.slice(0, 4).map((b) => {
            const term = terminals.find((x) => x.id === b.terminalId);
            if (!term) {
              return <span key={b.terminalId} className="clash-avatar is-closed" data-tip={clashSessionTip(b.title, null, null)}><Avatar title={b.title} color={b.color} size={18} dim /></span>;
            }
            const tree = treeOf(repos, realPath(term.session?.cwd ?? term.cwd, project));
            const where = tree ? `${tree.root.split('/').at(-1)} · ${branchLabel(tree)}` : null;
            const state = shownState(term);
            return (
              <button key={b.terminalId} type="button" className="clash-avatar" aria-label={t.wt.goTo(term.title)}
                data-tip={clashSessionTip(term.title, !term.session ? 'starting' : isLimitPaused(term.session) ? 'paused' : effectiveState(term), where)} onClick={() => useApp.getState().select(term.id)}>
                {/* Its ring says waiting or error; done's ✓ would cover the initial at this size (the tooltip says it). */}
                <Avatar title={term.title} color={term.color} state={state === 'done' ? null : state} size={18} />
              </button>
            );
          })}
          {by.length > 4 && <span className="clash-avatars-more mono" data-tip={by.slice(4).map(titleOf).join(', ')}>+{by.length - 4}</span>}
        </span>
        <span className="clash-what">{t.clash.title(rows.length)}</span>
        <span className="clash-check">{t.clash.check}</span>
      </span>
      <span ref={chipsEl} className="clash-chips">
        {rows.slice(0, shown).map((r, i) => (
          <button key={r.path} type="button" className="clash-chip mono" aria-label={`${r.repo.split('/').at(-1)}/${r.rel}`}
            data-tip={t.clash.fileTip(`${r.repo.split('/').at(-1)}/${r.rel}`)} onClick={() => openFile(r.path, r.rel, null, r.kind === 'D' ? 'margin' : 'diff', { preview: true })}>{labels[i]}</button>
        ))}
        {shown < rows.length && (
          <button type="button" className="clash-chip is-more mono" data-tip={t.clash.moreTip(rows.length - shown)} onClick={showAll}>{t.clash.more(rows.length - shown)}</button>
        )}
      </span>
    </div>
  );
}

/** "Alfa on main" / "Alfa and Beta on worktree-x" / "main" when no session is surely behind it. */
function MeetSideText({ side }: { side: MeetSide }) {
  const names = t.wt.list(side.names);
  return names ? <><b>{names}</b>{t.wt.on}<span className="mono">{side.branch}</span></> : <span className="mono">{side.branch}</span>;
}

/** Where a session works, when the sessions shown don't all work in one place: the branch, or the worktree's name. */
function LocPill({ at }: { at: RepoStatus }) {
  const wt = isWorktree(at);
  const label = wt ? at.root.split('/').at(-1) ?? at.root : branchLabel(at);
  return (
    <span className={`branch loc-pill ${wt ? 'is-wt' : ''}`} data-tip={wt ? t.wt.headTip(at.root, branchLabel(at), null) : label}>
      <Icon name={wt ? 'branchOff' : 'git'} size={11} stroke={1.8} /><span className="loc-text pill-text">{label}</span>
    </span>
  );
}

/**
 * A session's unsure files: under its sure ones, behind a dashed rule, closed by
 * default — one line with the other candidates and the first names; open, the rows and a way to "Why unsure".
 */
function MaybeGroup({ id, session, rows, compact, repoOf }: { id: string; session: string; rows: ChangeRow[]; compact: boolean; repoOf: (root: string) => RepoLabel }) {
  const open = useApp((s) => s.changesMaybeOpen.includes(id));
  // Closed (it is by default) with a file flashing in: its label pulses, as a collapsed group's count does.
  const flash = useFlashOf(rows, open);
  // The other candidates of these files; none means a background command of this session alone.
  const others = new Map<string, ChangeBy>();
  for (const r of rows) for (const b of unsureOf(r)) if (b.terminalId !== session && !others.has(b.terminalId)) others.set(b.terminalId, b);
  const names = rows.map((r) => r.rel.split('/').at(-1) ?? r.rel);
  const preview = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  return (
    <div className="maybe-group">
      <button type="button" className="maybe-head" aria-expanded={open} onClick={() => useApp.getState().toggleMaybe(id)}>
        <span className={`change-group-chev ${open ? 'is-open' : ''}`} aria-hidden="true"><Icon name="chevron" size={10} stroke={2} /></span>
        <span className={`maybe-label ${flash ? 'is-new' : ''}`} style={flash?.color ? { ['--flash' as string]: flash.color } : undefined}>{t.unsure.maybe} · {rows.length}</span>
        {others.size > 0
          ? <span className="maybe-with" data-tip={[...others.values()].map((b) => b.title).join(', ')}>{t.unsure.sharedWith}{[...others.values()].slice(0, 3).map((b) => <Avatar key={b.terminalId} title={b.title} color={b.color} size={14} />)}</span>
          : <span className="maybe-with">{t.unsure.background}</span>}
        <span className="grow" />
        {!open && <span className="maybe-files">{preview}</span>}
      </button>
      {open && <>
        {rows.map((r) => <Row key={r.path} row={r} showRepo compact={compact} repo={repoOf(r.repo)} />)}
        <button type="button" className="maybe-why" onClick={() => useApp.getState().setOriginSheet(rows[0]!.path)}>{t.unsure.why}</button>
      </>}
    </div>
  );
}

/** "3 files", whose unit gives way when the panel is narrow. */
function FilesCount({ n, flash = null }: { n: number; flash?: { color: string | undefined } | null }) {
  return (
    <span className={`change-count ${flash ? 'is-new' : ''}`} style={flash?.color ? { ['--flash' as string]: flash.color } : undefined}>
      {n}<span className="count-unit">{t.filesUnit(n)}</span>
    </span>
  );
}

/** A collapsed group with a row flashing in: its count pulses instead, in that row's color. */
function useFlashOf(rows: ChangeRow[], open: boolean): { color: string | undefined } | null {
  const row = collapsedFlash(rows, useContext(Flashing), open);
  return row ? { color: flashColor(row) } : null;
}

export function ChangesPanel() {
  const rawRepos = useApp((s) => s.repos);
  // No repository yet while the project's first folder scan runs: Changes says it looks.
  const looking = useApp((s) => lookingForRepos(s.scmSearch));
  // The Clean and To sync sections opened past their dozen chips.
  const [moreClean, setMoreClean] = useState(false);
  const [moreSync, setMoreSync] = useState(false);
  // Changes counts as viewing: every readable main repository of the window asks
  // for a view fetch, shown by name or not, so its ↓ stays fresh; main's gates decide. A folder of hundreds: only
  // the ones with changes or a live session.
  const liveRoots = useApp((s) => [...sessionRoots(s.repos.map((r) => r.root), s.terminals)].join('\n'));
  useViewFetches(viewFetchKey(rawRepos, new Set(liveRoots ? liveRoots.split('\n') : [])));
  // A worktree's folder is its own group, never an untracked row of its repo.
  const repos = useMemo(() => hideWorktreeFolders(rawRepos), [rawRepos]);
  // Windows without Git: the views say so instead of showing every repo clean.
  const missing = gitMissing(repos.map((r) => r.error));
  const attributions = useApp((s) => s.attributions);
  const group = useApp((s) => s.changesGroup);
  const collapsed = useApp((s) => s.changesCollapsed);
  const expanded = useApp((s) => s.changesExpanded);
  const compact = !expanded;
  // Workspaces on: All (the default) or This workspace; the filter only changes what is shown.
  const wsF = useApp((s) => (s.ws?.on && !s.popout ? s.ws : null));
  const scope = useApp((s) => s.changesScope);
  const allRows = buildRows(repos, attributions);
  const filtered = wsF && scope === 'ws' ? changesInWorkspace(wsF, allRows) : null;
  const rows = filtered ?? allRows;
  const flashing = useChangesFlash(rows, repos, useApp((s) => s.project?.root ?? ''));
  const nest = nestWorktrees(repos, rows);
  const byRepo = group === 'repo' ? nest.families.map((f) => ({ ...f, id: groupKey('repo', f.repo.root) })) : [];
  const bySession = group === 'session' ? groupBySession(rows, t.unknownOrigin).map((g) => ({ ...g, id: groupKey('session', g.key) })) : [];
  const allIds = [...byRepo.flatMap((g) => [g.id, ...g.worktrees.map((w) => groupKey('repo', w.status.root))]), ...bySession.map((g) => g.id)];
  const sessionOrder = useApp((s) => sessionOrderKey(s.terminals));
  const clashes = overlapGroups(rows, sessionOrder.split('\n'));
  const meets = meetGroups(repos, rows, sessionOrder.split('\n'));
  const terminals = useApp((s) => s.terminals);
  const project = useApp((s) => s.project);
  const locs = bySession.map((g) => {
    const term = terminals.find((x) => x.id === g.key);
    return g.key === 'unknown' ? null : locationOf(term ? realPath(term.session?.cwd ?? term.cwd, project) : null, locationRows(g), repos);
  });
  const showLoc = showLocations(locs);
  const mains = repos.filter((r) => !isWorktree(r));
  const clean = cleanRepos(mains).filter((r) => !byRepo.some((f) => f.repo.root === r.root));
  // Repositories git refuses (another user's folder): a row each saying why. None that failed a read is "clean".
  const unreadable = missing ? [] : unreadableRepos(repos);
  const readable = mains.filter((r) => !r.error);
  // Nothing to show: no rows, and (by repo) no worktree with something to merge.
  const nothing = rows.length === 0 && (group === 'session' || byRepo.length === 0);
  // A worktree's chip: its name, its sync arrows, then (in Clean) what it has to merge; "To sync" leaves that out.
  const wtChip = (w: WtView, o: { merge: boolean } = { merge: true }) => (
    <span key={w.status.root} className="chip-static mono chip-wt" tabIndex={-1} data-tip={t.wt.headTip(w.status.root, branchLabel(w.status), null)}>
      <Icon name="branchOff" size={10} stroke={1.9} /><span className="chip-name">{w.name}</span><SyncCounts status={w.status} />
      {o.merge && w.state === 'merge' ? <span className="chip-wt-ahead">↑{toMerge(w.status)}</span> : null}
    </span>
  );
  const repoChip = (r: RepoStatus) => <span key={r.root} className="chip-static mono" tabIndex={-1}><span className="chip-name">{r.name}</span><SyncCounts status={r} /></span>;
  // By session: the dirty repositories' and the worktrees' arrows, at the bottom so nothing above moves.
  const toSync = group === 'session' && !nothing ? toSyncOf(mains, rows, [...nest.families.flatMap((f) => f.worktrees), ...nest.idle]) : [];
  // A folder of hundreds of repositories: a dozen chips per section, the rest behind "+N more" (sessions' always show).
  const live = sessionRoots(repos.map((r) => r.root), terminals);
  const syncChips = moreSync ? { shown: toSync, more: 0 } : capShown(toSync, CHANGES_CAP, (x) => live.has(x.kind === 'repo' ? x.status.root : x.view.status.root));
  const idleShown = group === 'repo' ? nest.idle : [];
  const cleanChips = moreClean ? { shown: [...clean, ...idleShown], more: 0 }
    : capShown<RepoStatus | WtView>([...clean, ...idleShown], CHANGES_CAP, (x) => live.has('root' in x ? x.root : x.status.root));
  // "+N more" goes away under the focus: the focus moves to the first chip it showed.
  const moreChip = (n: number, shownBefore: number, show: () => void) => (
    <button type="button" className="chip-more mono" data-tip={t.moreReposTip(n)} onClick={(e) => {
      const section = e.currentTarget.parentElement;
      show();
      requestAnimationFrame(() => section?.querySelectorAll<HTMLElement>('.chip-static')[shownBefore]?.focus());
    }}>{t.moreRepos(n)}</button>
  );
  const wtsOf = (root: string) => [...nest.families.flatMap((f) => f.worktrees), ...nest.idle].filter((w) => w.status.worktreeOf === root);
  // Staging: while the drawer is open every group but the one being committed folds.
  const { writes } = useStaging();
  const drawer = useApp((s) => s.gitDrawer);
  const target = useApp((s) => s.gitTarget);
  const lastStaged = useApp((s) => s.gitLastStaged);
  const fold: FoldView = { target, state: { open: writes && drawer.open, unfolded: drawer.unfolded } };
  const keepRepo = keptFamily(target, nest.families.map((f) => ({ root: f.repo.root, worktrees: f.worktrees.map((w) => w.status.root) })));
  const openedFor = drawer.openedFor && 'session' in drawer.openedFor ? drawer.openedFor.session : null;
  const keepSession = keptSession({ openedFor, lastStaged, sessions: bySession.map((g) => ({ key: g.key, paths: g.rows.map((r) => r.path) })) });
  const shownOf = (id: string, keep: string | null) => groupShown(id, keep, fold.state, collapsed);
  // By session with several working trees, each folder line starts with its repository's path.
  const projectRoot = project?.realRoot ?? project?.root ?? null;
  const repoOf = (root: string): RepoLabel => repos.length > 1 ? { label: repoPathOf(root, projectRoot), multi: true } : { label: root.split('/').at(-1) ?? root, multi: false };
  return (
    <aside className={`changes ${compact ? 'is-compact' : ''}`} aria-label={t.changes}>
      {/* The head: the label and how many files, Review, the Filters funnel. */}
      <div className="changes-head">
        <span className="section-label">{t.changes}</span>
        {rows.length > 0 && <span className="count mono">{rows.length}</span>}
        <span className="grow" />
        <button type="button" className="icon-btn changes-review" aria-label={t.menu.reviewAll} data-tip={t.menu.reviewAll}
          disabled={rows.length === 0} onClick={() => useApp.getState().openReview('all')}><Icon name="review" size={14} /></button>
        <ChangesFilters wsOn={wsF !== null} />
      </div>
      {clashes.map((g) => <ClashCard key={g.key} by={g.by} rows={g.rows} repos={repos} />)}
      {meets.map((g) => (
        <div key={g.key} className="meet">
          <span className="meet-title"><Icon name="meet" size={14} stroke={1.8} />{t.wt.sameFile(g.files.length, g.sides.length)}</span>
          <span className="meet-body">
            {g.sides.map((side, i) => <span key={side.root}>{i > 0 && t.wt.joiner(i, g.sides.length)}<MeetSideText side={side} /></span>)}
            {' '}{g.sides.length > 2 ? t.wt.allChanged : t.wt.bothChanged} <span className="mono">{fileList(g.files)}</span>. {t.wt.meetEnd}
          </span>
        </div>
      ))}
      <Flashing.Provider value={flashing}>
      <div className="changes-body">
        {repos.length === 0 && <p className="empty">{looking ?? t.noRepos}</p>}
        {missing && <GitMissing />}
        {unreadable.map((r) => <RepoTrouble key={r.root} name={r.name} root={r.root} error={r.error!} />)}
        {readable.length > 0 && !missing && nothing && (
          // All clean: one quiet line and a row per repo (no "Clean" section repeated below).
          <CleanState repos={readable} worktreesOf={wtsOf} hidden={filtered ? allRows.length - rows.length : 0} live={live} />
        )}
        {byRepo.map((g) => {
          const shown = shownOf(g.id, keepRepo ? groupKey('repo', keepRepo) : null);
          return (
            <div key={g.id} className="change-group">
              <GroupHead id={g.id} all={allIds} count={g.rows.length} menu={() => repoMenu(g.repo.root, { staging: true })} rows={[...g.rows, ...g.worktrees.flatMap((w) => w.rows)]}
                git={{ rows: g.rows, label: g.repo.name }} shown={shown}>
                <span className="change-group-title">{g.repo.name}</span>
                <SyncCounts status={g.repo} />
                <span className="branch mono" data-tip={branchLabel(g.repo)}><Icon name="git" size={11} stroke={1.8} /><span className="pill-text">{branchLabel(g.repo)}</span></span>
              </GroupHead>
              {shown.open && <>
                {g.rows.map((r) => <Row key={r.path} row={r} showRepo={false} compact={compact} />)}
                {g.repo.truncated > 0 && <p className="empty">{t.moreFiles(g.repo.truncated)}</p>}
                {g.worktrees.map((w) => <WorktreeGroup key={w.status.root} w={w} all={allIds} repos={repos} compact={compact} fold={fold} />)}
              </>}
            </div>
          );
        })}
        {bySession.map((g, gi) => {
          const shown = shownOf(g.id, keepSession ? groupKey('session', keepSession) : null);
          const commit = g.key === 'unknown' || g.rows.length === 0 ? undefined : () => void commitWork(g.key, g.rows);
          return (
            <div key={g.id} className="change-group">
              <GroupHead id={g.id} all={allIds} count={g.rows.length} unsure={g.maybe.length} rows={[...g.rows, ...g.maybe]}
                review={g.key === 'unknown' ? undefined : { label: t.review.reviewOf(g.title), run: () => useApp.getState().openReview(g.key) }}
                menu={() => sessionGitItems({ key: g.key, title: g.title, rows: g.rows })} git={{ rows: g.rows, label: g.title, pill: commit }} shown={shown}>
                <i className={`dot ${g.color ? 'id-dot' : 'unknown'}`} style={g.color ? idStyle(g.color) : undefined} />
                <span className="change-group-title">{g.title}</span>
                {showLoc && locs[gi] && <LocPill at={locs[gi]!} />}
              </GroupHead>
              {shown.open && <>
                {g.rows.map((r) => <Row key={`${g.key}-${r.path}`} row={r} showRepo compact={compact} repo={repoOf(r.repo)} />)}
                {g.rows.length === 0 && g.maybe.length > 0 && <p className="maybe-none">{t.unsure.noneForSure}</p>}
                {g.maybe.length > 0 && <MaybeGroup id={g.id} session={g.key} rows={g.maybe} compact={compact} repoOf={repoOf} />}
              </>}
            </div>
          );
        })}
        {toSync.length > 0 && (
          <div className="clean to-sync">
            <span className="clean-label to-sync-label"><Icon name="sync" size={11} stroke={2} />{t.toSync}</span>
            <span className="clean-chips">
              {syncChips.shown.map((x) => (x.kind === 'repo' ? repoChip(x.status) : wtChip(x.view, { merge: false })))}
              {syncChips.more > 0 && moreChip(syncChips.more, syncChips.shown.length, () => setMoreSync(true))}
            </span>
          </div>
        )}
        {(clean.length > 0 || (group === 'repo' && nest.idle.length > 0)) && !nothing && (
          <div className="clean">
            <span className="clean-label"><Icon name="check" size={11} stroke={2.4} />{t.clean}</span>
            <span className="clean-chips">
              {cleanChips.shown.map((x) => ('root' in x ? repoChip(x) : wtChip(x)))}
              {cleanChips.more > 0 && moreChip(cleanChips.more, cleanChips.shown.length, () => setMoreClean(true))}
            </span>
          </div>
        )}
      </div>
      </Flashing.Provider>
      {/* Read-only keeps the old footer; with git actions on, the commit bar and drawer take its place. */}
      {writes ? <CommitArea /> : <div className="changes-foot">{t.readOnlyGit}</div>}
    </aside>
  );
}
