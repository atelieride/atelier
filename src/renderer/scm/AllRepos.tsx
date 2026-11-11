// Source Control's All Repositories view: Sync All on top, then one block per
// working tree in a fixed order. A second view of the sidebar: the One view (the switcher) stays as it was.
import { useMemo } from 'react';
import { syncAction } from '@shared/git-write';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { runGitCommand } from '../git/commands';
import { fetchAll } from './actions';
import { pullAll, pushAll, syncAllRun } from './all-actions';
import { allRows, syncTotals } from './all-view';
import { RepoBlock } from './RepoBlock';
import './all-repos.css';

const st = () => useApp.getState();

export function AllRepos() {
  const repos = useApp((s) => s.repos);
  const entries = useApp((s) => s.scmRepos);
  const folds = useApp((s) => s.scmFolds);
  const writes = useApp((s) => s.settings.gitActions === 'on');
  const rows = useMemo(() => allRows(repos, entries), [repos, entries]);
  return (
    <div className="scm-all">
      {writes && <SyncAll totals={syncTotals(repos)} />}
      <div className="scm-all-list" role="list" aria-label={t.scm.all.all}>
        {rows.map((r) => <RepoBlock key={r.root} row={r} folds={folds} writes={writes} />)}
      </div>
    </div>
  );
}

/** Sync All with what it would move; ▾ Pull All, Push All, Fetch All, Commit All. One run at a time (all-actions). */
function SyncAll({ totals }: { totals: { ahead: number; behind: number } }) {
  const a = t.scm.all;
  const bulk = useApp((s) => s.scmBulk);
  const busy = bulk !== null;
  const quiet = totals.ahead === 0 && totals.behind === 0;
  const menu = (): MenuItem[] => [
    { id: 'pull-all', label: a.pullAll, icon: 'arrowDown', disabled: busy, run: () => void pullAll() },
    { id: 'push-all', label: a.pushAll, icon: 'arrowUp', disabled: busy, run: () => void pushAll() },
    { id: 'fetch-all', label: t.git.sync.fetchAll, icon: 'fetch', run: () => void fetchAll() },
    'sep',
    // As Git › Commit All Repositories…: with nothing staged anywhere it says so instead of opening an empty sheet.
    { id: 'commit-all', label: a.commitAll, icon: 'commit', run: () => void runGitCommand('git-commit-all') }
  ];
  const label = bulk === 'pull' ? t.git.sync.running.pull : bulk === 'push' ? t.git.sync.running.push : a.syncing;
  // As every sync button: Pull All with only commits to pull, Push All with only commits to push, Sync All with both.
  const action = syncAction(totals);
  const idle = { pull: { text: a.pullAllShort, tip: a.pullAllTip, icon: 'arrowDown' as const, run: pullAll }, push: { text: a.pushAllShort, tip: a.pushAllTip, icon: 'arrowUp' as const, run: pushAll }, sync: { text: a.syncAll, tip: a.syncAllTip, icon: 'sync' as const, run: syncAllRun } }[action];
  return (
    <div className={`git-sync scm-all-sync ${quiet ? '' : 'is-due'} ${busy ? 'is-running' : ''}`} role="group" aria-label={a.syncAll}>
      <button type="button" className={`git-sync-main ${quiet ? 'is-quiet' : ''}`} data-tip={busy ? undefined : idle.tip} aria-busy={busy} onClick={() => { if (!busy) void idle.run(); }}>
        {busy ? <i className="git-spin" aria-hidden="true" /> : <span className="git-sync-icon" aria-hidden="true"><Icon name={idle.icon} size={13} stroke={1.9} /></span>}
        <span>{busy ? label : idle.text}</span>
        {!busy && !quiet && (
          <span className="git-sync-counts mono">
            {totals.behind > 0 && <span className="git-sync-behind">↓{totals.behind}</span>}
            {totals.ahead > 0 && <span className="git-sync-ahead">↑{totals.ahead}</span>}
          </span>
        )}
      </button>
      <button type="button" className="git-sync-more" aria-label={t.git.sync.more} data-tip={t.git.sync.more} aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.parentElement!.getBoundingClientRect();
          st().openMenu({ x: r.left, y: r.bottom + 4, anchor: { left: r.left, right: r.right, bottom: r.bottom + 4 } }, menu());
        }}>
        <Icon name="chevronDown" size={13} stroke={2} />
      </button>
    </div>
  );
}
