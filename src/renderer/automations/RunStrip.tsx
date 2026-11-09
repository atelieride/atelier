// Under the session bar of a session an automation started (3b): who started it and
// why, how it handles questions, that merge is blocked; Stop Run while it works; Review Changes once done.
import { useState } from 'react';
import type { TerminalInfo } from '@shared/protocol';
import { copyText } from '../clipboard';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { startRun, stopRun } from './actions';
import { canCloseRun, costLabel, runOf } from './view';

const ts = t.auto.strip;
const SOURCE_NAMES = { clickup: 'ClickUp', notion: 'Notion', jira: 'Jira' } as const;

export function RunStrip({ term }: { term: TerminalInfo }) {
  // Two selectors: each returns an object of the state itself, so nothing renders until a run changes.
  const [open, setOpen] = useState(false);
  const run = useApp((s) => runOf(s.automations, term.id)?.run ?? null);
  const a = useApp((s) => runOf(s.automations, term.id)?.automation ?? null);
  if (!run || !a) return null;
  const at = new Date(run.startedAt ?? run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const openTask = () => void window.atelier.connectors.openTask(run.task.source, run.task.id);
  const show = () => useApp.getState().openAutomations(a.id);
  if (run.state === 'review' || run.state === 'merged' || run.state === 'closed') {
    const decisions = run.decisions ?? [];
    return (
      <>
      <div className="au-strip is-done" role="status">
        <Icon name="check" size={14} />
        <span><b>{ts.done}</b> <span className="au-faint">· {run.branch ? <span className="mono">{run.branch}</span> : null} · {run.state === 'merged' ? ts.mergedByYou : ts.nothingMerged}{run.cost !== undefined ? ` · ${costLabel(run.cost)}` : ''}</span></span>
        <span className="grow" />
        <button type="button" className="btn-small is-ok" onClick={() => useApp.getState().openReview(term.id)}><Icon name="eye" size={12} />{ts.reviewChanges}</button>
        <button type="button" className="btn-small" onClick={() => useApp.getState().setActivity('scm')}>{ts.openScm}</button>
        {decisions.length > 0 && <button type="button" className="btn-small" aria-expanded={open} onClick={() => setOpen(!open)}>{ts.decisions(decisions.length)}</button>}
        <button type="button" className="btn-small is-ghost" onClick={openTask}>{t.auto.openTask}</button>
        {canCloseRun(run) && <button type="button" className="btn-small is-ghost" onClick={() => useApp.getState().askCloseRun(run.id)}>{t.auto.closeRun}</button>}
      </div>
      {open && decisions.length > 0 && (
        <div className="au-decisions">
          <div className="au-decisions-head"><span className="section-label">{ts.decisionsTitle}</span><span className="grow" />
            <button type="button" className="btn-small is-ghost" onClick={() => void copyText(decisions.map((d, i) => `${i + 1}. ${d}`).join('\n'))}>{ts.copy}</button></div>
          <ol>{decisions.map((d, i) => <li key={i}>{d}</li>)}</ol>
        </div>
      )}
      </>
    );
  }
  const ended = run.state === 'failed' || run.state === 'stopped';
  return (
    <div className={`au-strip ${ended ? 'is-ended' : ''}`} role="status">
      <Icon name="automation" size={13} />
      <span>{ts.startedBy(a.name, at)}</span><span className="au-sep">·</span>
      <span>{SOURCE_NAMES[run.task.source]} {run.task.displayId}</span><span className="au-sep">·</span>
      <span>{a.claude.decideAlone ? ts.decides : ts.asks}</span><span className="au-sep">·</span>
      <span className="au-faint">{ts.blocked}</span>
      {ended && run.reason && <><span className="au-sep">·</span><span className="au-faint">{run.reason}</span></>}
      <span className="grow" />
      <button type="button" className="btn-small is-ghost" onClick={show}>{t.auto.instructions}</button>
      <button type="button" className="btn-small is-ghost" onClick={openTask}>{t.auto.openTask}</button>
      {ended && canCloseRun(run) && <button type="button" className="btn-small is-ghost" onClick={() => useApp.getState().askCloseRun(run.id)}>{t.auto.closeRun}</button>}
      {ended
        ? <button type="button" className="btn-small" onClick={() => startRun(run.id)}>{t.auto.retry}</button>
        : <button type="button" className="btn-small is-danger" onClick={() => stopRun(run.id)}><Icon name="stop" size={11} />{t.auto.stopRun}</button>}
    </div>
  );
}
