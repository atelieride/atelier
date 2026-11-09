import { useState } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { cancelOp } from './actions';
import { commitAllBar } from './commit-all';
import { reopenCommitAll } from './commit-all-run';
import { CommitAllBarText } from './CommitAllSheet';
import { CommitDrawer, Handle } from './CommitDrawer';
import { barChoice, barView, dragEnd, elapsed, type BarView } from './drawer';
import { useNow } from './OpLog';
import { defaultTarget } from './target';
import { isAbsPath } from '@shared/paths';

/**
 * The commit area at the bottom of the Changes panel: the bar while the drawer is closed, the
 * drawer while open. Part of the panel's column, never over its rows. Read-only: none at all.
 */
export function CommitArea() {
  const writes = useApp((s) => s.settings.gitActions === 'on');
  const open = useApp((s) => s.gitDrawer.open);
  const any = useApp((s) => s.repos.length > 0);
  if (!writes || !any) return null;
  return open ? <CommitDrawer /> : <CommitBar />;
}

/** The bar: one line, by precedence; a click or a drag of its handle up opens the drawer. Running: Cancel. */
export function CommitBar() {
  const repos = useApp((s) => s.repos);
  const ops = useApp((s) => s.gitOps);
  const results = useApp((s) => s.gitResult);
  const drafts = useApp((s) => s.gitDrafts);
  const lastStaged = useApp((s) => s.gitLastStaged);
  const activeTab = useApp((s) => s.activeTab);
  // The repository the drawer would open on, whose draft the bar shows.
  const target = defaultTarget({ openedFor: null, lastStaged, repos, activeFile: isAbsPath(activeTab) ? activeTab : null });
  const view = barView({ repos, ops: Object.values(ops), results, drafts, target });
  const now = useNow(view.kind === 'running');
  // Commit all closed while it runs (or with a failure to retry): the bar says so and reopens it; an op running
  // in the drawer still comes first over its kept failure, with Cancel.
  const all = commitAllBar(useApp((s) => s.commitAll));
  const choice = barChoice(view, all);
  const shownAll = choice.show === 'all' ? all : null;
  const [lift, setLift] = useState(0);
  const click = () => {
    if (choice.click.kind === 'reopenAll') reopenCommitAll();
    else useApp.getState().openGitDrawer(choice.click.root ? { root: choice.click.root } : undefined);
  };
  const kind = shownAll ? (shownAll.kind === 'running' ? 'running' : 'failed') : view.kind;
  return (
    <div className={`git-bar is-${kind}`} style={lift ? { ['--lift' as string]: `${lift}px` } : undefined}>
      <Handle onMove={(dy) => setLift(Math.max(-12, Math.min(0, dy / 3)))}
        onEnd={(dy) => { setLift(0); if (dragEnd({ open: false, natural: 0, max: 0, start: 0, dy }).kind === 'open') click(); }} />
      <button type="button" className="git-bar-main" aria-label={shownAll ? t.git.commitAll.reopen : t.git.bar.open} onClick={click}>
        {shownAll ? <CommitAllBarText bar={shownAll} /> : <BarText view={view} now={now} />}
        {kind !== 'running' && <span className="git-bar-chev" aria-hidden="true"><Icon name="chevronUp" size={12} stroke={2} /></span>}
      </button>
      {choice.cancel && <button type="button" className="git-bar-cancel" onClick={() => void cancelOp(choice.cancel!)}>{t.git.log.cancel}</button>}
    </div>
  );
}

function BarText({ view, now }: { view: BarView; now: number }) {
  switch (view.kind) {
    case 'running':
      return <><i className="git-spin is-working" aria-hidden="true" /><span className="git-bar-text">{view.text}</span><span className="git-bar-time mono">{elapsed(now - view.startedAt)}</span></>;
    case 'failed':
      return <><i className="git-bar-dot" aria-hidden="true" /><span className="git-bar-text">{view.text}</span></>;
    case 'draft':
      return <>{view.count > 0 && <span className="git-bar-count mono">{view.count}</span>}<span className="git-bar-text git-bar-draft">{view.text}</span></>;
    case 'staged':
      return <><span className="git-bar-label">{t.git.bar.commit}</span><span className="git-bar-count mono">{view.count}</span><span className="git-bar-text">{view.repos > 1 ? t.git.bar.inRepos(view.repos) : t.git.bar.inRepo(view.name)}</span></>;
    default:
      return <span className="git-bar-text git-bar-none">{t.git.bar.commit} · {t.git.bar.nothing}</span>;
  }
}
