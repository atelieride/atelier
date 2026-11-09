// The Source Control sidebar: the Read-only badge (only in Read-only), the
// repository switcher with its Sync button and the selected repository's sections, or the empty and error states; with
// more than one repository, a switch to the All Repositories view.
import { useEffect } from 'react';
import type { ScmRefs, ScmRepoEntry } from '@shared/scm';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { loadRefs, loadRepos } from './data';
import { RefSections } from './RefSections';
import { RepoSwitcher } from './RepoSwitcher';
import { SyncButton } from '../git/SyncButton';
import { fetchAll, showHistory } from './actions';
import { AllRepos } from './AllRepos';
import { FetchButton } from './FetchControls';
import { GitMissing } from '../git/GitMissing';
import { gitMissing } from '../git/missing';
import { RepoTrouble } from '../git/RepoTrouble';
import { dubiousOwnership } from '../git/unsafe';
import { useViewFetch } from './view-fetch';

export function ScmSidebar() {
  const entries = useApp((s) => s.scmRepos);
  const root = useApp((s) => s.scmRepo);
  const refs = useApp((s) => (s.scmRepo ? s.scmRefs[s.scmRepo] : undefined));
  // The badge only in Read-only: with Git actions on, Sync and the rest are the sidebar's own.
  const readOnly = useApp((s) => s.settings.gitActions !== 'on');
  // First shown: the entries (and again on every visit, they may have changed while hidden).
  useEffect(() => { loadRepos(); }, []);
  useEffect(() => { if (root) void loadRefs(root); }, [root]);
  const view = useApp((s) => s.scmView);
  // All Repositories: a second view, only where there is more than one repository.
  const many = (entries?.length ?? 0) > 1;
  const all = many && view === 'all';
  // "When viewing": the selected repository, on show, on selection and on window focus.
  useViewFetch(root, !all);
  return (
    <div className="scm-sidebar" aria-label={t.scm.title}>
      <div className="sidebar-head">
        <span className="section-label">{t.scm.title}</span>
        {readOnly && <span className="scm-ro" data-tip={t.scm.readOnlyTip} aria-label={t.scm.readOnly}><Icon name="lock" size={9} stroke={2} /><span className="scm-ro-text">{t.scm.readOnly}</span></span>}
        <span className="grow" />
        {many && <ViewSwitch view={all ? 'all' : 'one'} />}
        {all ? <FetchAllButton /> : root && <FetchButton root={root} />}
        {root && <button type="button" className="icon-btn scm-history-btn" aria-label={t.scm.menu.showHistory} data-tip={t.scm.menu.showHistory} onClick={() => showHistory('all')}><Icon name="commit" size={14} /></button>}
      </div>
      {all && <AllRepos />}
      {!all && <OneRepo entries={entries} root={root} refs={refs} />}
    </div>
  );
}

/** One Repository / All Repositories: a radio group of two icons (arrow keys move between them). */
function ViewSwitch({ view }: { view: 'one' | 'all' }) {
  const a = t.scm.all;
  const pick = (v: 'one' | 'all', focus?: HTMLElement | null) => { useApp.getState().setScmView(v); focus?.focus(); };
  const seg = (v: 'one' | 'all', icon: 'repoOne' | 'repoAll', label: string) => (
    <button type="button" role="radio" aria-checked={view === v} aria-label={label} data-tip={label} tabIndex={view === v ? 0 : -1}
      className={`scm-view-seg ${view === v ? 'is-on' : ''}`} onClick={() => pick(v)}>
      <Icon name={icon} size={12} stroke={1.8} />
    </button>
  );
  return (
    <div className="scm-view" role="radiogroup" aria-label={a.view}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const next = view === 'one' ? 'all' : 'one';
        pick(next, e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next === 'one' ? 0 : 1]);
      }}>
      {seg('one', 'repoOne', a.one)}
      {seg('all', 'repoAll', a.all)}
    </div>
  );
}

/** The All view's ↻: fetches every repository of the project with a remote. */
function FetchAllButton() {
  const running = useApp((s) => Object.values(s.scmFetch).some((f) => f.running));
  return (
    <button type="button" className={`icon-btn scm-fetch-btn ${running ? 'is-running' : ''}`} aria-label={t.git.sync.fetchAll} data-tip={running ? t.scm.fetch.runningTip : t.git.sync.fetchAll}
      aria-busy={running} onClick={() => { if (!running) void fetchAll(); }}>
      <Icon name="fetch" size={14} />
    </button>
  );
}

/** Today's view: the switcher, its Sync button and the selected repository's sections, or the empty and error states. */
function OneRepo({ entries, root, refs }: { entries: ScmRepoEntry[] | null; root: string | null; refs: ScmRefs | undefined }) {
  return (
    <>
      {entries === null && <p className="empty">{t.scm.loading}</p>}
      {entries !== null && entries.length === 0 && (
        <div className="scm-empty">
          <span className="scm-empty-icon"><Icon name="git" size={20} /></span>
          <p className="scm-empty-title">{t.scm.noRepos}</p>
          <p className="scm-empty-body">{t.scm.noReposBody}</p>
          <button type="button" className="btn-ghost sm" onClick={() => void window.atelier.openFolder()}>{t.scm.openFolder}</button>
        </div>
      )}
      {entries !== null && entries.length > 0 && <RepoSwitcher />}
      {root && <SyncButton root={root} />}
      {root && refs && gitMissing([refs.error]) && <GitMissing />}
      {root && refs && refs.error && dubiousOwnership(refs.error) && (
        <RepoTrouble name={entries?.find((e) => e.root === root)?.name ?? root.split('/').at(-1) ?? root} root={root} error={refs.error} onRetry={() => void loadRefs(root)} />
      )}
      {root && refs && refs.error && !gitMissing([refs.error]) && !dubiousOwnership(refs.error) && (
        <div className="scm-error" role="alert">
          <span>{t.scm.errorLine(refs.error)}</span>
          <button type="button" className="btn-ghost sm" onClick={() => void loadRefs(root)}>{t.scm.retry}</button>
        </div>
      )}
      {root && refs && !refs.error && !refs.head.oid && refs.refs.length === 0 && <p className="empty scm-no-commits">{t.scm.noCommits}</p>}
      {root && refs && !refs.error && (refs.head.oid || refs.refs.length > 0) && <RefSections key={root} root={root} refs={refs} />}
    </>
  );
}
