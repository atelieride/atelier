// The Sync split button under the repository card: "↓ Pull ↓1" with only commits to pull,
// "↑ Push ↑2" with only commits to push, "⇅ Sync ↓1 ↑2" with both, "Sync" dimmed when in sync, "Publish Branch" without
// an upstream; ▾ Pull, Push, Fetch, Sync All Repositories, Fetch All Repositories. Hidden in
// Read-only, on a detached HEAD, and in a repository with no remote.
import type { MenuItem } from '../menu-model';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { fetchAll, fetchRepo } from '../scm/actions';
import { push, syncAll } from './actions';
import { startPull, startSync, syncAction, syncView } from './sync';

const SYNC_OPS = new Set(['pull', 'push', 'sync']);

/** `publishing`: the reason Pull is off (the Publish tooltip), null when Sync is the main action. */
function syncMenu(root: string, publishing: string | null): MenuItem[] {
  const s = t.git.sync;
  const publishSheet = () => useApp.getState().setGitSheet({ kind: 'publish', root });
  return [
    { id: 'pull', label: s.pull, icon: 'arrowDown', disabled: !!publishing, ...(publishing ? { tip: publishing } : {}), run: () => void startPull(root) },
    { id: 'push', label: s.push, icon: 'arrowUp', run: () => (publishing ? publishSheet() : void push(root)) },
    { id: 'fetch', label: s.fetch, icon: 'fetch', run: () => void fetchRepo(root, 'manual') },
    'sep',
    { id: 'sync-all', label: s.syncAll, icon: 'sync', run: () => void syncAll() },
    { id: 'fetch-all', label: s.fetchAll, icon: 'fetch', run: () => void fetchAll() }
  ];
}

export function SyncButton({ root }: { root: string }) {
  const s = t.git.sync;
  const on = useApp((x) => x.settings.gitActions === 'on');
  const status = useApp((x) => x.scmRepos?.find((e) => e.root === root)?.status ?? null);
  const hasRemote = useApp((x) => x.scmRefs[root]?.hasRemote ?? !!status?.upstream);
  const running = useApp((x) => Object.values(x.gitOps).find((o) => o.root === root && SYNC_OPS.has(o.op))?.op ?? null);
  if (!on) return null;
  const view = syncView(status, hasRemote);
  if (view.kind === 'none') return null;

  const publishing = view.kind === 'publish';
  const quiet = view.kind === 'sync' && view.ahead === 0 && view.behind === 0;
  // Pull with only commits to pull, Push with only commits to push, Sync with both (or in sync: it asks the remote).
  const action = view.kind === 'sync' ? syncAction(view) : 'sync';
  const tip = publishing
    ? (view.reason?.kind === 'gone' ? s.tipPublishGone(view.branch, view.reason.upstream) : view.reason?.kind === 'other' ? s.tipPublishOther(view.branch, view.reason.upstream) : s.tipPublish(view.branch))
    : quiet ? s.tipInSync(view.upstream) : s.tip(view.behind, view.ahead, view.upstream);
  const main = () => {
    if (running) return;
    if (publishing) useApp.getState().setGitSheet({ kind: 'publish', root });
    else if (action === 'pull') void startPull(root);
    else if (action === 'push') void push(root);
    else void startSync(root);
  };
  return (
    <div className={`git-sync ${quiet ? '' : 'is-due'} ${running ? 'is-running' : ''}`} role="group" aria-label={s.sync}>
      <button type="button" className={`git-sync-main ${quiet ? 'is-quiet' : ''}`} data-tip={running ? undefined : tip} aria-busy={!!running} onClick={main}>
        {running ? <i className="git-spin" aria-hidden="true" /> : <span className="git-sync-icon" aria-hidden="true"><Icon name={publishing || action === 'push' ? 'arrowUp' : action === 'pull' ? 'arrowDown' : 'sync'} size={13} stroke={1.9} /></span>}
        {running ? <span>{s.running[running]}</span> : publishing ? <span>{s.publish}</span> : (
          <>
            <span>{s[action]}</span>
            {(view.behind > 0 || view.ahead > 0) && (
              <span className="git-sync-counts mono">
                {view.behind > 0 && <span className="git-sync-behind">↓{view.behind}</span>}
                {view.ahead > 0 && <span className="git-sync-ahead">↑{view.ahead}</span>}
              </span>
            )}
          </>
        )}
      </button>
      <button type="button" className="git-sync-more" aria-label={s.more} data-tip={s.more} aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.parentElement!.getBoundingClientRect();
          useApp.getState().openMenu({ x: r.left, y: r.bottom + 4, anchor: { left: r.left, right: r.right, bottom: r.bottom + 4 } }, syncMenu(root, view.kind === 'publish' ? (view.reason ? tip : s.noUpstreamTip) : null));
        }}>
        <Icon name="chevronDown" size={13} stroke={2} />
      </button>
    </div>
  );
}
