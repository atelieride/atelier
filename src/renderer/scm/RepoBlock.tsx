// One working tree in Source Control's All Repositories view: the
// header (fold, name, branch, marks; Fetch, Pull, Push and More under the pointer, in the marks' own room), the message
// field (the draft's first line; a body is kept) and one button. Its parts never change by themselves: a state only
// changes what they say, so nothing moves while ops run.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isMod } from '@shared/keys';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { cancelOp, push, refreshFacts } from '../git/actions';
import { commitRepo, repoCommitState, stageThenCommitRepo } from '../git/commit-repo';
import { messageApplied, messageEdited, stopMessage, writeMessage } from '../git/message-run';
import { Sparkle } from '../git/MessageWrite';
import { StageAllConfirm } from '../git/StageAllConfirm';
import { startPull, startSync } from '../git/sync';
import { useMessage } from '../git/use-message';
import { fetchRepo, repoMenu } from './actions';
import { blockView, firstLine, foldedOf, hasBody, idleTip, nearScreen, runningLabel, syncAbility, withFirstLine, type AllRow, type BlockView } from './all-view';

const st = () => useApp.getState();
type Ability = ReturnType<typeof syncAbility>;

/** The menu under a button, at its left edge. */
function menuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect();
  st().openMenu({ x: r.left, y: r.bottom + 4, anchor: { left: r.left, right: r.right, bottom: r.bottom + 4 } }, items);
}

/** Pull, Push, Fetch: off, with why, on a detached HEAD or without a remote. */
function syncItems(root: string, can: Ability, which: ('pull' | 'push' | 'fetch')[] = ['pull', 'push', 'fetch']): MenuItem[] {
  const s = t.git.sync;
  const all: Record<'pull' | 'push' | 'fetch', MenuItem> = {
    pull: { id: 'pull', label: s.pull, icon: 'arrowDown', disabled: !!can.pull, ...(can.pull ? { tip: can.pull } : {}), run: () => void startPull(root) },
    push: { id: 'push', label: s.push, icon: 'arrowUp', disabled: !!can.push, ...(can.push ? { tip: can.push } : {}), run: () => void push(root) },
    fetch: { id: 'fetch', label: s.fetch, icon: 'fetch', disabled: !!can.fetch, ...(can.fetch ? { tip: can.fetch } : {}), run: () => void fetchRepo(root, 'manual') }
  };
  return which.map((k) => all[k]);
}

function openDrawer(root: string): void {
  if (!st().showChanges) st().toggleChanges();
  st().openGitDrawer({ root });
}

export function RepoBlock({ row, folds, writes }: { row: AllRow; folds: Readonly<Record<string, boolean>>; writes: boolean }) {
  const { root, status } = row;
  const a = t.scm.all;
  const folded = foldedOf(row, folds);
  // What the block reads, each piece on its own (a whole-state read would render every block on every change).
  const op = useApp((s) => Object.values(s.gitOps).find((o) => o.root === root && o.op !== 'stage' && o.op !== 'unstage') ?? null);
  const facts = useApp((s) => s.gitFacts[root]);
  useApp((s) => s.settings.commitNothingStaged);
  useApp((s) => s.ws?.on && s.changesScope);
  const messagesOn = useApp((s) => s.settings.commitMessages !== 'off');
  const w = useApp((s) => (s.gitWrite?.root === root ? s.gitWrite : null));
  const [text, setText] = useMessage(root);
  const [ask, setAsk] = useState<{ push: boolean } | null>(null);
  const [above, setAbove] = useState(false);
  const askRef = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const block = useRef<HTMLDivElement>(null);
  // What the block needs from main (its remotes, a commit's checks), read once it nears the screen: a folder of hundreds
  // of repositories doesn't read them all at once.
  useEffect(() => {
    const el = block.current;
    if (!el || st().gitFacts[root]) return;
    const seen = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      if (!st().gitFacts[root]) void refreshFacts(root, { view: true });
    }, nearScreen(el));
    seen.observe(el);
    return () => seen.disconnect();
  }, [root]);

  const commit = repoCommitState(root, st());
  const hasRemote = facts ? facts.remotes.length > 0 : !!status.upstream;
  const can = syncAbility(status, hasRemote);
  const view = blockView({ status, running: op?.op ?? null, hasRemote, commit });

  // ✦'s message lands in the draft (subject and body); the field shows its first line.
  useEffect(() => { if (w?.apply != null) { setText(w.apply); messageApplied(); } }, [w?.apply]);
  // The question goes once there is nothing left to ask (something staged meanwhile, nothing left to stage).
  useEffect(() => { if (ask && (commit.staged > 0 || !commit.plan)) setAsk(null); }, [ask, commit.staged, !!commit.plan]);
  const closeAsk = (focus: boolean) => { setAsk(null); if (focus) field.current?.focus({ preventScroll: true }); };
  // Open: above the button when it wouldn't fit below in the list; a click anywhere else closes it.
  useLayoutEffect(() => {
    if (!ask || !askRef.current) { setAbove(false); return; }
    const list = askRef.current.closest('.scm-all-list')?.getBoundingClientRect();
    const box = askRef.current.getBoundingClientRect();
    setAbove(!!list && box.bottom > list.bottom && box.top - box.height - 40 > list.top);
  }, [ask]);
  useEffect(() => {
    if (!ask) return;
    const down = (e: PointerEvent) => { if (!askRef.current?.contains(e.target as Node)) setAsk(null); };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [ask]);

  const run = async (o: { push?: boolean } = {}) => {
    if (view.button.kind !== 'commit' || view.button.block) return;
    if ((await commitRepo(root, o)) === 'ask') setAsk({ push: !!o.push });
  };
  const answer = (o: { push: boolean }) => { setAsk(null); void stageThenCommitRepo(root, o); };
  const writing = w?.phase === 'writing';
  const branch = status.detached || !status.branch ? null : status.branch;
  const edit = (line: string) => { const next = withFirstLine(text, line); setText(next); if (w) messageEdited(next); };

  return (
    <div ref={block} className={`ab ${folded ? 'is-folded' : ''} ${row.worktree ? 'is-worktree' : ''} ${writes ? '' : 'is-ro'}`} role="listitem" aria-label={row.name}
      aria-description={row.worktree ? a.worktreeTip : undefined} data-root={root}>
      <div className="ab-head" onContextMenu={(e) => st().openMenu(e, repoMenu(root))}>
        {writes ? (
          <button type="button" className="ab-fold" aria-expanded={!folded} aria-label={folded ? a.unfold(row.name) : a.fold(row.name)}
            onClick={() => st().setScmFold(root, !folded, row.worktree)}>
            <Icon name={folded ? 'chevron' : 'chevronDown'} size={12} stroke={2} />
          </button>
        ) : <span className="ab-fold" aria-hidden="true" />}
        {row.worktree && <span className="ab-wt" data-tip={a.worktreeTip} aria-hidden="true"><Icon name="worktree" size={12} stroke={1.8} /></span>}
        <button type="button" className="ab-name" data-tip={a.openOne(row.name)}
          onClick={() => { st().selectScmRepo(root); st().setScmView('one'); }}>
          {row.dir && <span className="ab-dir">{row.dir}</span>}<span className="ab-leaf">{row.name}</span>
        </button>
        {row.note && <span className="sw-wt ab-note" data-tip={row.tip ?? undefined}>{row.note}</span>}
        {(branch || status.oid) && (
          <span className="ab-branch mono"><Icon name="git" size={11} stroke={1.8} /><span className="ab-branch-name">{branch ?? status.oid!.slice(0, 7)}</span></span>
        )}
        {!branch && !status.oid && <span className="grow" />}
        <span className="ab-marks">
          {view.error && <i className="ab-error" role="img" aria-label={a.unreadable(view.error)} data-tip={a.unreadable(view.error)} />}
          {view.changes > 0 && <span className="sw-chip is-changes" aria-label={a.changed(view.changes)}>{view.changes}</span>}
          {/* Once: here unless the button (shown) pulls, pushes or syncs and carries them. */}
          {(view.countsOn === 'head' || folded || !writes) && <Counts view={view} />}
          {view.clean && <span className="sw-chip is-clean" role="img" aria-label={a.inSync} data-tip={a.inSync}><Icon name="check" size={11} stroke={2.6} /></span>}
        </span>
        <span className="ab-acts" role="group" aria-label={a.actions(row.name)}>
          <HeadAction label={t.git.sync.fetch} icon="fetch" off={can.fetch} onClick={() => void fetchRepo(root, 'manual')} />
          {writes && <HeadAction label={t.git.sync.pull} icon="arrowDown" off={op ? runningLabel(op.op) : can.pull} onClick={() => void startPull(root)} />}
          {writes && <HeadAction label={t.git.sync.push} icon="arrowUp" off={op ? runningLabel(op.op) : can.push} onClick={() => void push(root)} />}
          {/* ⋯ holds Fetch, Pull and Push too: a narrow sidebar shows only it. */}
          <button type="button" className="icon-btn" aria-label={a.actions(row.name)} data-tip={a.actions(row.name)} aria-haspopup="menu"
            onClick={(e) => menuAt(e.currentTarget, [...syncItems(root, can, writes ? ['fetch', 'pull', 'push'] : ['fetch']), 'sep', ...repoMenu(root)])}><Icon name="more" size={13} /></button>
        </span>
      </div>
      {!folded && writes && (
        <div className="ab-body">
          <label className={`ab-field ${writing ? 'is-writing' : ''}`}>
            <input ref={field} type="text" value={firstLine(writing ? w.text : text)} readOnly={writing} spellCheck={false} aria-label={a.messageFor(row.name)}
              placeholder={a.placeholder(kbd('⌘↵'))}
              onChange={(e) => edit(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && isMod(e)) { e.preventDefault(); if (!e.repeat) void run(); }
                else if (e.key === 'Escape' && writing) { e.preventDefault(); stopMessage(); }
              }} />
            {!writing && hasBody(text) && <span className="ab-body-hint mono" data-tip={a.bodyTip} aria-label={a.bodyTip}>+ body</span>}
            {messagesOn && <Sparkle w={w} empty={!text.trim()} staged={commit.staged} onWrite={() => void writeMessage(root)} onStop={stopMessage} />}
          </label>
          <MainButton root={root} view={view} can={can} opId={op?.id ?? null} block={commit.block} onCommit={run} />
          {ask && commit.plan && (
            <div ref={askRef} className={`ab-ask ${above ? 'is-above' : ''}`}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAsk(true); } }}>
              <StageAllConfirm name={commit.name} plan={commit.plan} push={ask.push} onCancel={() => closeAsk(true)}
                onAlways={() => { void window.atelier.settings.set({ commitNothingStaged: 'stage-all' }); answer(ask); }}
                onGo={() => answer(ask)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** ↓ to pull, ↑ to push (nonzero parts only), in the Sync button's colors. */
function Counts({ view }: { view: BlockView }) {
  const a = t.scm.all;
  if (view.behind === 0 && view.ahead === 0) return null;
  return (
    <span className="ab-counts mono">
      {view.behind > 0 && <span className="git-sync-behind" aria-label={a.toPull(view.behind)}>↓{view.behind}</span>}
      {view.ahead > 0 && <span className="git-sync-ahead" aria-label={a.toPush(view.ahead)}>↑{view.ahead}</span>}
    </span>
  );
}

/** A header action: off (with why) while it can't run. */
function HeadAction({ label, icon, off, onClick }: { label: string; icon: 'fetch' | 'arrowDown' | 'arrowUp'; off: string | null; onClick: () => void }) {
  return (
    <button type="button" className="icon-btn ab-act-sync" aria-label={label} data-tip={off ? `${label} · ${off}` : label} aria-disabled={!!off || undefined}
      onClick={() => { if (!off) onClick(); }}>
      <Icon name={icon} size={13} />
    </button>
  );
}

/** The block's one button, by its state: busy, Commit, Sync, Publish Branch, or an idle Commit. */
function MainButton({ root, view, can, opId, block, onCommit }: { root: string; view: BlockView; can: Ability; opId: string | null; block: string | null; onCommit: (o?: { push?: boolean }) => void }) {
  const b = view.button;
  const s = t.git.sync;
  const more = (items: () => MenuItem[], label: string = s.more) => (
    <button type="button" className="ab-more" aria-label={label} data-tip={label} aria-haspopup="menu" onClick={(e) => menuAt(e.currentTarget.parentElement!, items())}>
      <Icon name="chevronDown" size={12} stroke={2} />
    </button>
  );
  if (b.kind === 'running') {
    return (
      <div className="ab-btn is-running" role="group">
        <button type="button" className="ab-main" aria-busy="true"><i className="git-spin" aria-hidden="true" /><span className="ab-label">{runningLabel(b.op)}</span>{view.countsOn === 'button' && <Counts view={view} />}</button>
        {opId && <button type="button" className="ab-more" aria-label={t.scm.all.cancel} data-tip={t.scm.all.cancel} onClick={() => void cancelOp(opId)}><Icon name="x" size={12} stroke={2} /></button>}
      </div>
    );
  }
  if (b.kind === 'commit') {
    const off = !!b.block;
    return (
      <div className={`ab-btn is-commit ${off ? 'is-off' : ''}`} role="group">
        <button type="button" className="ab-main" aria-disabled={off || undefined} data-tip={b.block ?? undefined} onClick={() => { if (!off) onCommit(); }}>
          <Icon name="check" size={13} stroke={2.4} />
          <span className="ab-label">{b.staged > 0 ? t.git.drawer.commitFiles(b.staged) : t.git.drawer.label}</span>
        </button>
        {more(() => [
          { id: 'commit-push', label: t.git.drawer.commitAndPush, icon: 'arrowUp', disabled: off, ...(b.block ? { tip: b.block } : {}), run: () => onCommit({ push: true }) },
          { id: 'open-drawer', label: t.scm.all.openDrawer, icon: 'commit', run: () => openDrawer(root) },
          'sep',
          ...syncItems(root, can, ['pull', 'push'])
        ], t.git.drawer.more)}
      </div>
    );
  }
  if (b.kind === 'sync') {
    // Pull with only commits to pull, Push with only commits to push, Sync with both; the counts ride along.
    const go = () => (b.action === 'pull' ? void startPull(root) : b.action === 'push' ? void push(root) : void startSync(root));
    return (
      <div className={`ab-btn is-sync is-${b.action}`} role="group">
        <button type="button" className="ab-main" onClick={go}>
          <span className="ab-sync-icon"><Icon name={b.action === 'pull' ? 'arrowDown' : b.action === 'push' ? 'arrowUp' : 'sync'} size={13} stroke={1.9} /></span>
          <span className="ab-label">{s[b.action]}</span><Counts view={view} />
        </button>
        {more(() => syncItems(root, can))}
      </div>
    );
  }
  if (b.kind === 'publish') {
    return (
      <div className="ab-btn is-publish" role="group">
        <button type="button" className="ab-main" onClick={() => st().setGitSheet({ kind: 'publish', root })}><Icon name="arrowUp" size={13} stroke={1.9} /><span className="ab-label">{s.publish}</span></button>
      </div>
    );
  }
  return (
    <div className="ab-btn is-commit is-off" role="group">
      <button type="button" className="ab-main" aria-disabled="true" data-tip={idleTip(view, block) ?? undefined}><Icon name="check" size={13} stroke={2.4} /><span className="ab-label">{t.git.drawer.label}</span></button>
      {more(() => syncItems(root, can))}
    </div>
  );
}
