// The Automations tab (1b): one automation with its runs, or every project's.
import { useRef, useState, type CSSProperties } from 'react';
import type { AutomationView } from '@shared/api';
import type { Run } from '@shared/automation-run';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { relativeTime } from '../history';
import {
  askTurnOn, catchUp, checkNow, editAutomation, openRunSession, removeAutomation, skipRun, startRun, stopRun, turnOff
} from './actions';
import { byProject, canCloseRun, conditionSentence, costLabel, durationLabel, runCounts, runLabel, runSentence } from './view';
import { ConfirmActions, onEscCancel, useDismiss } from '../confirms/InlineConfirm';

const ta = t.auto;
const MODELS: Record<string, string> = { default: 'Default', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
type Filter = 'all' | 'active' | 'review' | 'done';
const ACTIVE = new Set(['queued', 'held', 'starting', 'working', 'needsYou']);

function StateChip({ v }: { v: AutomationView }) {
  if (v.status.kind === 'paused') return <span className="au-chip is-waiting"><i />{ta.paused}</span>;
  return v.automation.enabled ? <span className="au-chip is-done"><i />{ta.on}</span> : <span className="au-chip is-muted">{ta.off}</span>;
}

function RunActions({ r }: { r: Run }) {
  switch (r.state) {
    case 'working': case 'starting':
      return <>{r.terminalId && <button type="button" className="btn-small" onClick={() => openRunSession(r.terminalId!)}>{ta.openSession}</button>}
        <button type="button" className="btn-small is-ghost" onClick={() => stopRun(r.id)}>{ta.stopRun}</button></>;
    case 'needsYou': return r.terminalId ? <button type="button" className="btn-small is-warn" onClick={() => openRunSession(r.terminalId!)}>{ta.answer}</button> : null;
    case 'review': return <>{r.terminalId && <button type="button" className="btn-small is-ok" onClick={() => openRunSession(r.terminalId!)}>{ta.review}</button>}<CloseButton r={r} /></>;
    case 'queued': return <><button type="button" className="btn-small" onClick={() => startRun(r.id)}>{ta.startNow}</button><button type="button" className="btn-small is-ghost" onClick={() => skipRun(r.id)}>{ta.skip}</button></>;
    case 'held': return <><button type="button" className="btn-small is-brand" onClick={() => startRun(r.id)}>{ta.start}</button><button type="button" className="btn-small is-ghost" onClick={() => skipRun(r.id)}>{ta.skip}</button></>;
    case 'failed': return <><button type="button" className="btn-small" onClick={() => startRun(r.id)}>{ta.retry}</button><CloseButton r={r} /></>;
    case 'skipped': return <button type="button" className="btn-small" onClick={() => startRun(r.id)}>{ta.runAnyway}</button>;
    default: return <CloseButton r={r} />;
  }
}

function CloseButton({ r }: { r: Run }) {
  if (!canCloseRun(r)) return null;
  return <button type="button" className="btn-small is-ghost" onClick={() => useApp.getState().askCloseRun(r.id)}>{ta.closeRun}</button>;
}

function RunRow({ r, v, cap, now }: { r: Run; v: AutomationView; cap: number; now: number }) {
  const l = runLabel(r);
  const tone: CSSProperties = {};
  return (
    <div className={`au-run is-${r.state}`} style={tone}>
      <div className="au-run-task">
        <span className="mono au-id">{r.task.displayId}</span>
        <span className="au-title">{r.task.title}</span>
        <span className="au-sub">{r.startedAt ? relativeTime(r.startedAt, now) : relativeTime(r.createdAt, now)}</span>
      </div>
      <div className="au-run-state">
        <span className={`au-chip is-${l.tone}`}><i />{l.label}</span>
        <span className="au-sub">{runSentence(r, v.automation, { cap })}</span>
      </div>
      <span className="au-run-wt">{r.branch ? <span className="au-wt mono">{r.branch}</span> : <span className="au-faint mono">—</span>}</span>
      <span className="mono au-num">{r.startedAt ? durationLabel(r.startedAt, r.endedAt ?? now) : '—'}</span>
      <span className="mono au-num">{costLabel(r.cost)}</span>
      <span className="au-run-actions"><RunActions r={r} /></span>
    </div>
  );
}

/** The header turned into Delete's question: what goes and what stays, Delete and Cancel (focused). */
function DeleteConfirm({ name, onDelete, onCancel }: { name: string; onDelete: () => void; onCancel: () => void }) {
  const box = useRef<HTMLElement>(null);
  useDismiss(box, onCancel);
  const title = t.confirm.deleteTitle(name);
  return (
    <header ref={box} className="au-head is-confirming" role="group" aria-label={title} data-own-esc="" onKeyDown={onEscCancel(onCancel)}>
      <span className="au-head-mark is-danger"><Icon name="trash" size={16} /></span>
      <div className="au-head-text">
        <h2>{title}</h2>
        <span className="confirm-stops">{t.confirm.deleteAutomationBody}</span>
      </div>
      <span className="grow" />
      <ConfirmActions end small={false} confirm={t.confirm.delete} onConfirm={onDelete} onCancel={onCancel} />
    </header>
  );
}

function Detail({ v }: { v: AutomationView }) {
  const a = v.automation;
  const cap = useApp((s) => s.settings.automationsCap);
  const accounts = useApp((s) => s.settings.claudeAccounts.list);
  const [filter, setFilter] = useState<Filter>('all');
  const [deleting, setDeleting] = useState(false);
  const now = Date.now();
  const account = accounts.find((x) => x.id === a.claude.account)?.name ?? 'Claude';
  const today = v.runs.filter((r) => r.startedAt !== undefined && new Date(r.startedAt).toDateString() === new Date(now).toDateString()).length;
  const instructions = a.instructions.split('\n').filter((l) => l.trim()).length;
  const caught = v.runs.filter((r) => r.state === 'held' && r.held === 'catchUp');
  const runs = [...v.runs].sort((x, y) => y.createdAt - x.createdAt).filter((r) =>
    filter === 'all' ? true : filter === 'active' ? ACTIVE.has(r.state) : filter === 'review' ? r.state === 'review' : !ACTIVE.has(r.state) && r.state !== 'review');
  const c = runCounts(v.runs);
  const project = a.project.split('/').pop() ?? a.project;
  return (
    <div className="au-detail">
      {deleting ? <DeleteConfirm name={a.name} onDelete={() => { setDeleting(false); removeAutomation(a.id); }} onCancel={() => setDeleting(false)} /> : <header className="au-head">
        <span className="au-head-mark"><Icon name="automation" size={18} /></span>
        <div className="au-head-text">
          <h2>{a.name}</h2>
          <span className="au-faint">{project}{v.status.kind === 'on' && v.status.nextPollAt ? ` · ${ta.nextCheck(new Date(v.status.nextPollAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : ''}{v.status.kind === 'paused' ? ` · ${v.status.reason}` : ''}</span>
        </div>
        <StateChip v={v} />
        <span className="grow" />
        {a.enabled && <button type="button" className="btn-secondary" onClick={() => checkNow(a.id)}><Icon name="sync" size={13} />{ta.checkNow}</button>}
        <button type="button" className="btn-secondary" onClick={() => editAutomation(a)}><Icon name="edit" size={13} />{ta.edit}</button>
        {a.enabled
          ? <button type="button" className="btn-secondary" onClick={() => turnOff(a.id)}><Icon name="pause" size={13} />{ta.pause}</button>
          : <button type="button" className="btn-primary" onClick={() => askTurnOn(a)}><Icon name="automation" size={13} />{ta.turnOn}</button>}
        {/* Asked in this header, never by the browser's confirm(). */}
        <button type="button" className="icon-btn au-delete" aria-label={ta.remove} data-tip={ta.remove}
          onClick={() => setDeleting(true)}><Icon name="trash" size={13} /></button>
      </header>}
      <div className="au-summary">
        <div><span className="section-label">{ta.when}</span><p>{conditionSentence(a)}</p></div>
        <div><span className="section-label">{ta.then}</span><p>{ta.thenSentence(MODELS[a.claude.model] ?? a.claude.model, ta.editor.modes[a.claude.mode], account, a.isolation.worktree, instructions)}</p></div>
        <div><span className="section-label">{ta.guardrails}</span><p>{ta.guardSentence(a.limits.concurrent, today, a.limits.perDay, a.limits.usagePause)}</p></div>
      </div>
      {caught.length > 0 && (
        <div className="au-catchup" role="note">
          <Icon name="automation" size={14} />
          <span>{ta.catchUp(caught.length, new Date(Math.min(...caught.map((r) => r.createdAt))).toLocaleString())}</span>
          <span className="grow" />
          <button type="button" className="btn-small" onClick={() => setFilter('active')}>{ta.showThem}</button>
          <button type="button" className="btn-small is-brand" onClick={() => catchUp(a.id, 'start')}>{ta.startAll}</button>
          <button type="button" className="btn-small is-ghost" onClick={() => catchUp(a.id, 'skip')}>{ta.skipAll}</button>
        </div>
      )}
      <div className="au-runs-head">
        <span className="section-label">{ta.runs}</span>
        <span className="mono au-count">{v.runs.length}</span>
        <div className="au-seg is-inline" role="radiogroup" aria-label={ta.runs}>
          {(Object.keys(ta.filter) as Filter[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? 'is-on' : ''} onClick={() => setFilter(f)}>
              {ta.filter[f]}{f === 'review' && c.review > 0 ? ` · ${c.review}` : ''}
            </button>
          ))}
        </div>
      </div>
      <div className="au-runs" role="table" aria-label={ta.runs}>
        <div className="au-run is-head" role="row">
          <span>{ta.cols.task}</span><span>{ta.cols.state}</span><span>{ta.cols.worktree}</span><span className="au-num">{ta.cols.time}</span><span className="au-num">{ta.cols.cost}</span><span />
        </div>
        {runs.map((r) => <RunRow key={r.id} r={r} v={v} cap={cap} now={now} />)}
        {runs.length === 0 && <p className="au-empty-runs">{ta.noRuns}</p>}
      </div>
    </div>
  );
}

function All() {
  const state = useApp((s) => s.automations);
  const project = useApp((s) => s.project?.root ?? null);
  const groups = byProject(state, project);
  const on = state.automations.filter((v) => v.automation.enabled).length;
  const now = Date.now();
  return (
    <div className="au-detail">
      <header className="au-head">
        <div className="au-head-text">
          <h2>{ta.allTitle}</h2>
          <span className="au-faint">{ta.allSub(state.automations.length, groups.length, on)}</span>
        </div>
      </header>
      <div className="au-all">
        {groups.map((g) => (
          <section key={g.project} className="au-all-group">
            <div className="au-group-head"><b>{g.name}</b><span className="mono au-faint">{g.project}</span>
              {g.project === project ? <span className="au-chip is-violet">{ta.thisWindow}</span> : <span className="au-faint">{ta.noWindow}</span>}</div>
            {g.views.map((v) => {
              const c = runCounts(v.runs);
              const today = v.runs.filter((r) => r.startedAt !== undefined && new Date(r.startedAt).toDateString() === new Date(now).toDateString()).length;
              return (
                <div key={v.automation.id} className={`au-all-row ${v.automation.enabled ? '' : 'is-off'}`}>
                  <span className="au-all-name"><span className={`au-src is-${v.automation.source.connector}`} aria-hidden="true"><Icon name={v.automation.source.connector} size={12} /></span>{v.automation.name}</span>
                  <span className="au-cond">{conditionSentence(v.automation)}</span>
                  <span>{v.status.kind === 'paused' ? <span className="au-chip is-waiting"><i />{v.status.reason}</span>
                    : c.working + c.needsYou > 0 ? <span className="au-chip is-working"><i />{ta.working(c.working + c.needsYou)}</span> : <StateChip v={v} />}</span>
                  <span className="mono au-num">{today} / {v.automation.limits.perDay}</span>
                  <span className="au-run-actions">
                    {g.project === project && <button type="button" className="btn-small" onClick={() => useApp.getState().openAutomations(v.automation.id)}>{ta.show}</button>}
                    {v.automation.enabled
                      ? <button type="button" className="btn-small is-ghost" onClick={() => turnOff(v.automation.id)}>{ta.pause}</button>
                      : <button type="button" className="btn-small" onClick={() => askTurnOn(v.automation)}>{ta.turnOn}</button>}
                  </span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

/** An Automations tab: one automation (`id`) with its runs, or every project's list (null). */
export function AutomationsView({ id, visible, place }: { id: string | null; visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const shown = useApp((s) => (id === null ? undefined : s.automations.automations.find((v) => v.automation.id === id)));
  return (
    <section className="au-view" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={ta.tab} tabIndex={-1}>
      {shown ? <Detail key={shown.automation.id} v={shown} /> : <All />}
    </section>
  );
}
