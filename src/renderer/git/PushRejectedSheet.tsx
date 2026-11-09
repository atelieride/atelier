// A push the remote rejected: "origin/main moved on" with up to three of its commits
// (main fetches first) and how many more, then Pull Then Push, Cancel, or Force Push…, whose second sheet names the
// commits it would drop and pushes with a lease on the oid shown here. Both open from an op's answer, not a click:
// Cancel takes the focus, so an Enter meant for something else never pulls or forces.
import { useEffect, useState } from 'react';
import type { RemoteCommit } from '@shared/git-write';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { push } from './actions';
import { SheetCommit, SheetFrame, closeGitSheet } from './SheetFrame';
import { commitsShown, pullThenPush, sentence } from './sync';

function useUpstream(root: string): string {
  return useApp((x) => x.gitFacts[root]?.upstream ?? x.scmRepos?.find((e) => e.root === root)?.status?.upstream ?? x.repos.find((r) => r.root === root)?.upstream ?? t.git.sync.theRemote);
}

/** The first commits and "and N more" (`total`: how many the remote has that HEAD lacks, from main). */
function Commits({ commits, total }: { commits: RemoteCommit[]; total: number }) {
  const { shown, more } = commitsShown(commits, total);
  return (
    <ul className="git-sheet-commits">
      {shown.map((c) => <SheetCommit key={c.oid} {...c} />)}
      {more > 0 && <li className="git-sheet-more">{t.git.sync.andMore(more)}</li>}
    </ul>
  );
}

type Remote = { commits: RemoteCommit[]; remoteOid: string | null; total: number };

export function PushRejectedSheet({ root }: { root: string }) {
  const s = t.git.sync;
  const upstream = useUpstream(root);
  const [data, setData] = useState<Remote | 'failed' | null>(null);
  useEffect(() => {
    let alive = true;
    window.atelier.git.remoteCommits(root, 20)
      // An older main answers no total: the list is all it knows.
      .then((d) => { if (alive) setData({ ...d, total: Math.max(d.total ?? 0, d.commits.length) }); })
      .catch(() => { if (alive) setData('failed'); });
    return () => { alive = false; };
  }, [root]);
  const loaded = data && data !== 'failed' ? data : null;
  const force = () => {
    if (!loaded?.remoteOid) return;
    useApp.getState().setGitSheet({ kind: 'forcePush', root, commits: loaded.commits, total: loaded.total, remoteOid: loaded.remoteOid });
  };
  return (
    <SheetFrame title={sentence(s.rejectedTitle(upstream))} icon="warning" tone="warn">
      {data === null && <p className="git-sheet-body is-loading">{s.looking}</p>}
      {data === 'failed' && <p className="git-sheet-body">{s.lookFailed}</p>}
      {loaded && <p className="git-sheet-body">{loaded.total ? s.rejectedBody(loaded.total) : s.rejectedNone}</p>}
      {loaded && loaded.commits.length > 0 && <Commits commits={loaded.commits} total={loaded.total} />}
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" onClick={() => { closeGitSheet(); void pullThenPush(root); }}>{s.pullThenPush}</button>
        <button type="button" className="btn-ghost" data-autofocus onClick={closeGitSheet}>{s.cancel}</button>
        <span className="grow" />
        <button type="button" className="btn-ghost is-danger" disabled={!loaded?.remoteOid} onClick={force}>{s.forcePush}</button>
      </div>
    </SheetFrame>
  );
}

export function ForcePushSheet({ root, commits, total, remoteOid }: { root: string; commits: RemoteCommit[]; total: number; remoteOid: string }) {
  const s = t.git.sync;
  const upstream = useUpstream(root);
  return (
    <SheetFrame title={s.forceTitle(upstream)} icon="caution" tone="danger">
      {total > 0 && <p className="git-sheet-body">{s.forceBody(total, upstream)}</p>}
      {commits.length > 0 && <Commits commits={commits} total={total} />}
      <p className="git-sheet-note">{s.forceNote}</p>
      <div className="git-sheet-actions">
        <button type="button" className="btn-danger" onClick={() => { closeGitSheet(); void push(root, { lease: { oid: remoteOid } }); }}>{s.forceGo}</button>
        {/* The safe answer takes the focus: Enter never forces by accident. */}
        <button type="button" className="btn-ghost" data-autofocus onClick={closeGitSheet}>{s.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">esc</span>
      </div>
    </SheetFrame>
  );
}
