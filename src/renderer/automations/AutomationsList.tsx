// The Automations sidebar (1b, 4b): this project's automations as cards, or
// every project's grouped; the empty state says what to connect first.
import type { AutomationView } from '@shared/api';
import type { ConnectorId } from '@shared/tasks';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { Toggle } from '../components/Settings';
import { askTurnOn, newAutomation, setPaused, turnOff } from './actions';
import { byProject, conditionSentence, runCounts } from './view';
import { automationServiceKeys } from '../jira-view';

const ta = t.auto;

function SourceGlyph({ connector }: { connector: ConnectorId }) {
  return <span className={`au-src is-${connector}`} aria-hidden="true"><Icon name={connector} size={12} /></span>;
}

function Card({ v, selected }: { v: AutomationView; selected: boolean }) {
  const c = runCounts(v.runs);
  const a = v.automation;
  // An off automation on a Jira service project without a named Created by can't turn on (main refuses too).
  const blocked = useApp((s) => !a.enabled && automationServiceKeys(a, s.connectors).length > 0);
  const chips = [
    c.working > 0 && <span key="w" className="au-chip is-working"><i />{ta.working(c.working)}</span>,
    c.needsYou > 0 && <span key="n" className="au-chip is-waiting"><i />{ta.needsYou(c.needsYou)}</span>,
    c.review > 0 && <span key="r" className="au-chip is-done"><i />{ta.forReview(c.review)}</span>,
    c.queued > 0 && <span key="q" className="au-chip">{ta.queued(c.queued)}</span>,
    c.held > 0 && <span key="h" className="au-chip is-violet"><i />{ta.held(c.held)}</span>
  ].filter(Boolean);
  return (
    <div className={`au-card ${selected ? 'is-selected' : ''} ${a.enabled ? '' : 'is-off'} ${v.status.kind === 'paused' ? 'is-paused' : ''}`}>
      {/* A click opens its tab as the preview, a double click keeps it. */}
      <button type="button" className="au-card-main" onClick={() => useApp.getState().openAutomations(a.id, { preview: true })}
        onDoubleClick={() => useApp.getState().openAutomations(a.id)} aria-current={selected || undefined}>
        <span className="au-card-head"><SourceGlyph connector={a.source.connector} /><span className="au-card-name">{a.name}</span></span>
        <span className="au-cond">{conditionSentence(a)}</span>
        <span className="au-chips">
          {v.status.kind === 'paused' ? <span className="au-chip is-waiting"><i />{v.status.reason}</span>
            : !a.enabled ? <span className="au-chip is-muted">{ta.off}</span>
            : chips.length ? chips : <span className="au-chip is-muted"><Icon name="clock" size={11} />{ta.watching}</span>}
        </span>
      </button>
      <span className="au-card-toggle">
        <Toggle label={a.enabled ? ta.pause : ta.turnOn} value={a.enabled} disabled={blocked} onChange={(on) => (on ? askTurnOn(a) : turnOff(a.id))} />
      </span>
    </div>
  );
}

function EmptyState() {
  const connectors = useApp((s) => s.connectors);
  const live = connectors.some((c) => c.status === 'connected');
  if (live) {
    return (
      <div className="au-empty is-small">
        <p>{ta.noneHere}</p>
        <button type="button" className="btn-primary" onClick={newAutomation}><Icon name="plus" size={13} />{ta.newOne}</button>
      </div>
    );
  }
  return (
    <div className="au-empty">
      <span className="au-empty-mark"><Icon name="automation" size={20} /></span>
      <h3>{ta.emptyTitle}</h3>
      <p>{ta.emptyBody}</p>
      <div className="au-empty-actions">
        {connectors.map((c) => (
          <button key={c.id} type="button" className="btn-secondary" onClick={() => { const st = useApp.getState(); st.setSettingsOpen('connectors'); st.openConnector(c.id); }}>
            <SourceGlyph connector={c.id} />{ta.connect(c.name)}
          </button>
        ))}
      </div>
      <p className="au-empty-note">{ta.emptyNote}</p>
    </div>
  );
}

export function AutomationsList() {
  const state = useApp((s) => s.automations);
  const project = useApp((s) => s.project?.root ?? null);
  // The card of the Automations tab in front is lit; This project / All only filters the list.
  const frontId = useApp((s) => (s.activeTab.startsWith('au:') ? s.autoTabs.find((r) => r.key === s.activeTab)?.id ?? null : null));
  const paused = useApp((s) => s.settings.automationsPaused);
  const scope = useApp((s) => s.autoFilter);
  const groups = byProject(state, project);
  const mine = groups.find((g) => g.project === project)?.views ?? [];
  const others = groups.filter((g) => g.project !== project).flatMap((g) => g.views);
  return (
    <div className="au-side">
      <div className="sidebar-head">
        <span className="section-label">{ta.title}</span>
        <span className="mono au-count">{mine.length}</span>
        <span className="grow" />
        <button type="button" className={`icon-btn ${paused ? 'is-on' : ''}`} aria-label={paused ? ta.resumeAll : ta.pauseAll} data-tip={paused ? ta.resumeAll : ta.pauseAll}
          onClick={() => setPaused(!paused)}><Icon name={paused ? 'play' : 'pause'} size={13} /></button>
        <button type="button" className="icon-btn" aria-label={ta.newOne} data-tip={ta.newOne} onClick={newAutomation}><Icon name="plus" size={13} /></button>
      </div>
      <div className="au-seg" role="tablist" aria-label={ta.title}>
        <button type="button" role="tab" aria-selected={scope === 'project'} className={scope === 'project' ? 'is-on' : ''} onClick={() => useApp.getState().setAutoFilter('project')}>{ta.thisProject}</button>
        <button type="button" role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'is-on' : ''} onClick={() => useApp.getState().setAutoFilter('all')}>{ta.all(state.automations.length)}</button>
      </div>
      {paused && <p className="au-paused"><Icon name="pause" size={12} />{ta.pausedAll}</p>}
      <div className="au-cards">
        {scope === 'project'
          ? (mine.length ? mine.map((v) => <Card key={v.automation.id} v={v} selected={frontId === v.automation.id} />) : <EmptyState />)
          : groups.map((g) => (
            <div key={g.project} className="au-group">
              <div className="au-group-head"><span className="mono">{g.name}</span>{g.project === project && <span className="au-chip is-violet">{ta.thisWindow}</span>}</div>
              {g.views.map((v) => <Card key={v.automation.id} v={v} selected={frontId === v.automation.id} />)}
            </div>
          ))}
      </div>
      {scope === 'project' && others.length > 0 && (
        <button type="button" className="au-others" onClick={() => useApp.getState().setAutoFilter('all')}>
          <span className="au-others-text"><span>{ta.otherProjects}</span><span className="au-faint">{ta.otherSummary(others.filter((v) => v.automation.enabled).length, others.length)}</span></span>
          <Icon name="chevron" size={12} />
        </button>
      )}
    </div>
  );
}
