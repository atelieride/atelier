// The selected repository's sections: Branches (local, then one group per remote), Tags,
// Worktrees, Stashes. Rows open the History tab scoped to that ref; ⌥-click compares it with the default branch. With
// Git actions on: switch from a branch row (hover ⇄, double-click), New Branch… and Stash
// Changes… in the section heads, an inline rename, Apply on a stash row, the git items in their menus.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { ScmRef, ScmRefs, ScmStash, ScmWorktree } from '@shared/scm';
import { Icon } from '../components/Icon';
import { idStyle, initialOf } from '../avatar';
import { relativeTime } from '../history';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { branchRename, stashApply } from '../git/actions';
import { localName, openNewBranch, openStash, rowClicks, startSwitch, stashItems } from '../git/branches';
import { nameError, useBranchNameCheck } from '../git/BranchName';
import { compareWithDefault, refMenu, showHistory } from './actions';
import { liveSessions, onScmEvent, rootsOf } from './data';
import { refSections, remoteLag } from './view';
import { isBelow } from '@shared/paths';

const LIMITS = { local: 30, remote: 30, tags: 5 };

/** A branch's dot color: the current branch violet (lane 1), the others by name over the other lane colors. */
function laneOf(name: string, current: boolean): string {
  if (current) return 'var(--lane-1)';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--lane-${(h % 5) + 2})`;
}

/** `add`: a write action in the head (Stash Changes…), hidden in Read-only. */
function Section({ k, label, count, add, children }: { k: string; label: string; count: ReactNode; add?: { label: string; run: () => void } | null; children: ReactNode }) {
  const collapsed = useApp((s) => s.scmCollapsed.includes(k));
  return (
    <section className="scm-section" data-key={k}>
      <div className="scm-section-top">
        <button type="button" className="scm-section-head" aria-expanded={!collapsed} onClick={() => useApp.getState().toggleScmSection(k)}>
          <span className={`scm-chev ${collapsed ? '' : 'is-open'}`} aria-hidden="true"><Icon name="chevron" size={10} stroke={2.4} /></span>
          <span className="section-label">{label}</span>
          <span className="grow" />
          <span className="scm-count mono">{count}</span>
        </button>
        {/* Shown on hover just left of the count (branches.css): --count-ch is how many digits it skips. */}
        {add && <button type="button" className="icon-btn scm-section-add" aria-label={add.label} data-tip={add.label} onClick={add.run}
          style={{ ['--count-ch' as string]: String(count ?? '').length }}><Icon name="plus" size={13} stroke={2} /></button>}
      </div>
      {!collapsed && <div className="scm-rows">{children}</div>}
    </section>
  );
}

function sessionIn(path: string) {
  return liveSessions().find((s) => s.cwd === path || isBelow(path, s.cwd)) ?? null;
}

/** A branch renamed in its row: the name checked as it is typed; Enter renames, Esc or leaving cancels. */
function RenameRow({ r, root, done }: { r: ScmRef; root: string; done: () => void }) {
  const [name, setName] = useState(r.short);
  const { check, clash, now } = useBranchNameCheck(root, name, r.short);
  const error = nameError(check, name, clash);
  const commit = async () => {
    const c = await now();
    if (c === 'same') { done(); return; }
    if (c !== 'ok') return;
    done();
    void branchRename({ root, ref: r.name, name });
  };
  return (
    <div className="ref-rename" data-ref={r.name}>
      <i className="ref-dot" style={{ ['--dot' as string]: laneOf(r.short, r.current) }} aria-hidden="true" />
      <input className={`ref-rename-input mono ${error ? 'is-invalid' : ''}`} value={name} autoFocus spellCheck={false} autoComplete="off"
        aria-label={t.git.branch.renameLabel(r.short)} aria-invalid={!!error} data-tip={error ?? t.git.branch.renameKeys}
        onFocus={(e) => e.currentTarget.select()} onChange={(e) => setName(e.currentTarget.value)} onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
        }} />
      {error && <span className="ref-rename-error" role="alert">{error}</span>}
    </div>
  );
}

function RefRow({ r, refs, worktree, root, elsewhere, renaming, setRenaming }: { r: ScmRef; refs: ScmRefs; worktree: ScmWorktree | null; root: string; elsewhere: boolean; renaming: boolean; setRenaming: (name: string | null) => void }) {
  const writes = useApp((s) => s.settings.gitActions === 'on');
  // Switch: the hover icon and a double-click, on any branch HEAD isn't on.
  const switchable = writes && r.kind !== 'tag' && !r.current;
  // A click shows History; on a row a double-click switches, it waits for a second click first (rowClicks).
  const latest = useRef({ name: r.name, switchable });
  latest.current = { name: r.name, switchable };
  const [clicks] = useState(() => rowClicks({ single: () => showHistory(latest.current.name), delay: () => latest.current.switchable }));
  if (renaming && writes) return <RenameRow r={r} root={root} done={() => setRenaming(null)} />;
  const onClick = (e: ReactMouseEvent) => (e.altKey ? compareWithDefault(r.name) : clicks(e.detail));
  const lag = r.kind === 'remote' ? remoteLag(r, refs) : null;
  const who = worktree ? sessionIn(worktree.path) : null;
  const target = localName(r);
  const rename = r.kind === 'head' && !elsewhere ? () => setRenaming(r.name) : undefined;
  return (
    <div className="ref-line">
      <button type="button" className={`ref-row is-${r.kind} ${r.current ? 'is-current' : ''}`} data-ref={r.name} onClick={onClick}
        onDoubleClick={switchable ? () => void startSwitch(root, r.name) : undefined}
        onContextMenu={(e) => useApp.getState().openMenu(e, refMenu(r, { root, elsewhere, ...(rename ? { rename } : {}) }))}>
        {r.kind === 'tag'
          ? <span className="ref-tag" aria-hidden="true"><Icon name="tag" size={12} stroke={1.7} /></span>
          : <i className={`ref-dot ${r.kind === 'remote' ? 'is-hollow' : ''}`} style={{ ['--dot' as string]: laneOf(r.kind === 'remote' ? r.short.slice((r.remote?.length ?? 0) + 1) : r.short, r.current || refs.refs.some((x) => x.current && x.upstream === r.name)) }} aria-hidden="true" />}
        <span className="ref-name mono">{r.short}</span>
        {r.current && <span className="ref-head-pill">HEAD</span>}
        {worktree && !r.current && (who
          ? <span className="ref-session" style={idStyle(who.color)} data-tip={t.scm.worktreeTip(worktree.path)}>{initialOf(who.title)}</span>
          : <span className="ref-wt" data-tip={t.scm.worktreeTip(worktree.path)}><Icon name="worktree" size={12} stroke={1.7} /></span>)}
        <span className="grow" />
        {r.gone && <span className="ref-track is-gone" data-tip={t.scm.goneTip}>{t.scm.gone}</span>}
        {(r.ahead > 0 || r.behind > 0) && <span className="ref-track mono">{r.ahead > 0 ? `↑${r.ahead}` : ''}{r.ahead > 0 && r.behind > 0 ? ' ' : ''}{r.behind > 0 ? `↓${r.behind}` : ''}</span>}
        {lag !== null && <span className="ref-track mono is-lag" data-tip={t.scm.lagTip(lag)}>−{lag}</span>}
        {r.kind === 'tag' && r.date > 0 && <span className="ref-age">{relativeTime(r.date * 1000, Date.now())}</span>}
      </button>
      {switchable && (
        <button type="button" className="ref-act" aria-label={t.git.branch.switchTo(target)} data-tip={t.git.branch.switchTo(target)} onClick={() => void startSwitch(root, r.name)}>
          <Icon name="swap" size={12} stroke={2} />
        </button>
      )}
    </div>
  );
}

/** A stash: Apply on hover; Apply, Pop, Drop and Copy Message in its menu. */
function StashRow({ x, root }: { x: ScmStash; root: string }) {
  const writes = useApp((s) => s.settings.gitActions === 'on');
  const name = `stash@{${x.index}}`;
  return (
    <div className="stash-row" data-tip={t.scm.stashTip} onContextMenu={(e) => { const items = stashItems(root, x); if (items.length) useApp.getState().openMenu(e, items); }}>
      <span className="ref-wt" aria-hidden="true"><Icon name="stash" size={12} stroke={1.7} /></span>
      <span className="stash-name mono">{name}</span>
      <span className="stash-msg">{x.message}</span>
      {writes && (
        <button type="button" className="stash-act" data-tip={t.git.stash.applyTip(name)}
          onClick={() => void stashApply({ root, index: x.index, oid: x.oid, pop: false, message: x.message })}>{t.git.stash.apply}</button>
      )}
    </div>
  );
}

function More({ n, onClick }: { n: number; onClick: () => void }) {
  return n > 0 ? <button type="button" className="ref-more" onClick={onClick}>{t.scm.more(n)}</button> : null;
}

const tildify = (p: string, root: string | undefined) => (root && isBelow(root, p) ? p.slice(root.length + 1) : p.replace(/^\/Users\/[^/]+/, '~'));

export function RefSections({ root, refs }: { root: string; refs: ScmRefs }) {
  const project = useApp((s) => s.project?.realRoot);
  const entries = useApp((s) => s.scmRepos);
  const [wide, setWide] = useState<Set<string>>(() => new Set());
  const [worktrees, setWorktrees] = useState<ScmWorktree[]>([]);
  const [stashes, setStashes] = useState<ScmStash[]>([]);
  const [tick, setTick] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const writes = useApp((x) => x.settings.gitActions === 'on');
  useEffect(() => onScmEvent((e) => { if (rootsOf(e).includes(root)) setTick((n) => n + 1); }), [root]);
  useEffect(() => {
    let alive = true;
    void window.atelier.scm.worktrees(root).then((w) => { if (alive) setWorktrees(w); }).catch(() => {});
    void window.atelier.scm.stashes(root).then((s) => { if (alive) setStashes(s); }).catch(() => {});
    return () => { alive = false; };
  }, [root, tick]);
  const lim = (k: string, n: number) => (wide.has(k) ? 100000 : n);
  const s = refSections(refs, { local: lim('local', LIMITS.local), remote: lim('remote', LIMITS.remote), tags: lim('tags', LIMITS.tags) });
  const expand = (k: string) => setWide((w) => new Set([...w, k]));
  const linked = worktrees.slice(1);
  const wtOf = (branch: string) => linked.find((w) => w.branch === branch) ?? null;
  // Checked out in another working tree (the main one included when this is a linked one): no rename, no delete.
  const elsewhere = (r: ScmRef) => r.kind === 'head' && worktrees.some((w) => w.branch === r.short && w.path !== root);
  const branchCount = s.counts.remote ? `${s.counts.local} · ${s.counts.remote}` : String(s.counts.local);
  const row = (r: ScmRef, worktree: ScmWorktree | null) => (
    <RefRow key={r.name} r={r} refs={refs} worktree={worktree} root={root} elsewhere={elsewhere(r)} renaming={renaming === r.name} setRenaming={setRenaming} />
  );
  return (
    <div className="scm-sections" key={root}>
      <Section k="branches" label={t.scm.branches} count={branchCount} add={writes ? { label: t.git.branch.newBranch, run: () => openNewBranch(root) } : null}>
        <span className="ref-group">{t.scm.local}</span>
        {s.local.map((r) => row(r, wtOf(r.short)))}
        <More n={s.more.local} onClick={() => expand('local')} />
        {s.remotes.map((g) => (
          <div key={g.name} className="ref-remote">
            <span className="ref-group">{g.name}</span>
            {g.refs.map((r) => row(r, null))}
            <More n={s.more.remotes[g.name] ?? 0} onClick={() => expand('remote')} />
          </div>
        ))}
      </Section>
      <Section k="tags" label={t.scm.tags} count={s.counts.tags}>
        {s.tags.map((r) => row(r, null))}
        <More n={s.more.tags} onClick={() => expand('tags')} />
        {s.counts.tags === 0 && <p className="scm-none">{t.scm.noTags}</p>}
      </Section>
      <Section k="worktrees" label={t.scm.worktrees} count={linked.length}>
        {linked.map((w) => {
          const who = sessionIn(w.path);
          const entry = entries?.find((e) => e.root === w.path);
          return (
            <button key={w.path} type="button" className="wt-row" data-tip={w.path}
              onClick={() => (entry ? useApp.getState().selectScmRepo(entry.root) : w.branch ? showHistory(`refs/heads/${w.branch}`) : undefined)}>
              <span className="ref-wt" aria-hidden="true"><Icon name="worktree" size={12} stroke={1.7} /></span>
              <span className="wt-main">
                <span className="ref-name mono">{w.branch ?? (w.head ? t.scm.detached(w.head.slice(0, 7)) : '—')}</span>
                <span className="wt-path mono">{tildify(w.path, project)}</span>
              </span>
              {who && <span className="ref-session" style={idStyle(who.color)} data-tip={who.title}>{initialOf(who.title)}</span>}
            </button>
          );
        })}
        {linked.length === 0 && <p className="scm-none">{t.scm.noWorktrees}</p>}
      </Section>
      <Section k="stashes" label={t.scm.stashes} count={stashes.length} add={writes ? { label: t.git.stash.add, run: () => openStash(root) } : null}>
        {stashes.map((x) => <StashRow key={x.oid} x={x} root={root} />)}
        {stashes.length === 0 && <p className="scm-none">{t.scm.noStashes}</p>}
      </Section>
    </div>
  );
}
