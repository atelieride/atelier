// Close Run: the session closes and, when ticked, the run's worktree goes if nothing is left to
// commit. The branch always stays; main says why when the worktree is kept.
import { useState } from 'react';
import type { Run } from '@shared/automation-run';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { closeRun } from './actions';

const tc = t.auto.close;

export function CloseRunSheet() {
  const id = useApp((s) => s.closingRun);
  const run = useApp((s) => (id ? s.automations.automations.flatMap((v) => v.runs).find((r) => r.id === id) ?? null : null));
  const open = useApp((s) => (run?.terminalId ? s.terminals.some((x) => x.id === run.terminalId) : false));
  if (!id || !run) return null;
  return <Sheet key={id} run={run} sessionOpen={open} />;
}

function Sheet({ run, sessionOpen }: { run: Run; sessionOpen: boolean }) {
  const canRemove = !!run.worktree && !run.worktreeRemoved;
  const [remove, setRemove] = useState(canRemove);
  const close = () => useApp.getState().askCloseRun(null);
  const where = run.worktree ? run.worktree.replace(/^.*?\/(\.claude\/worktrees\/)/, '$1') : null;
  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={close}>
      <div className="ac-sheet is-narrow" role="dialog" aria-modal="true" aria-label={tc.label} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="ac-head">
          <span className="section-label">{tc.label}</span>
          <h2>{tc.title(run.task.displayId)}</h2>
          <p className="ac-sub">{run.task.title}</p>
        </div>
        <div className="ac-points">
          <div className="ac-pt"><span className="ac-ic is-working"><Icon name="terminal" size={16} /></span>
            <div><b>{sessionOpen ? tc.session : tc.sessionGone}</b>{sessionOpen && <p>{tc.sessionB}</p>}</div></div>
          {canRemove ? (
            <label className="ac-check is-top">
              <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
              <span><b>{tc.remove}</b><br /><span className="mono au-faint ac-path">{where}</span><br /><span className="au-faint">{tc.removeB(run.branch ?? '')}</span></span>
            </label>
          ) : run.branch ? (
            <div className="ac-pt"><span className="ac-ic is-worktree"><Icon name="worktree" size={16} /></span>
              <div><p>{tc.noWorktree(run.branch)}</p></div></div>
          ) : null}
        </div>
        <footer className="ac-foot">
          <span className="grow" />
          <button type="button" className="btn-secondary is-ghost" onClick={close}>{tc.cancel}</button>
          <button type="button" className="btn-primary" autoFocus onClick={() => { close(); void closeRun(run.id, canRemove && remove); }}>{tc.close}</button>
        </footer>
      </div>
    </div>
  );
}
