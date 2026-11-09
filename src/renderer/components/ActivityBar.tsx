import { Fragment, useEffect } from 'react';
import { spaceOfActivity } from '../spaces';
import { Icon, type IconName } from './Icon';
import { t } from '../i18n/en';
import { useApp, type Activity } from '../store';
import { counts } from '../selectors';
import { useRisingKey } from '../motion';
import { attentionConnector, needsAttention } from '../connectors-view';
import { useDocker } from '../docker/store';
import { dockerShown, hasProblem } from '../docker/view';
import { groupContainers } from '@shared/docker';
import { useRedis } from '../redis/store';
import { redisShown } from '../redis/view';
import { leaveRedis } from '../redis/install';
import { useDb } from '../databases/store';
import { databasesShown } from '../databases/view';
import { leaveDatabases } from '../databases/install';
import { leaveDocker } from '../docker/install';
import { servicesView } from '../features';
import { activeCount } from '../automations/view';
import { kbd } from '../kbd';

const items: { id: Activity; icon: IconName; label: string }[] = [
  { id: 'sessions', icon: 'sessions', label: t.activity.sessions },
  { id: 'files', icon: 'files', label: t.activity.files },
  { id: 'services', icon: 'services', label: t.activity.services },
  { id: 'scm', icon: 'git', label: t.activity.scm },
  { id: 'docker', icon: 'whale', label: t.activity.docker },
  { id: 'redis', icon: 'redis', label: t.activity.redis },
  { id: 'databases', icon: 'databases', label: t.activity.databases },
  { id: 'automations', icon: 'automation', label: t.activity.automations }
];

export function ActivityBar() {
  const activity = useApp((s) => s.activity);
  // Hidden: no view is shown in front; any item shows the sidebar on its view.
  const front = useApp((s) => (s.sidebarHidden ? null : s.activity));
  const clickActivity = useApp((s) => s.clickActivity);
  const waiting = useApp((s) => counts(s.terminals).waiting);
  const waitKey = useRisingKey(waiting);
  const svcErrors = useApp((s) => s.services.some((p) => p.errors > 0));
  const settingsOpen = useApp((s) => s.settingsOpen !== null);
  // A connector that needs you (signed out, unavailable) puts a quiet amber dot on the gear.
  const attention = useApp((s) => s.connectors.find((c) => needsAttention([c]))?.name ?? null);
  const settingsLabel = attention ? `${t.activity.settings} · ${t.conn.attention(attention)}` : t.activity.settings;
  // Docker: shown per Settings (Auto: an engine answers); a rose dot when one of this project's
  // containers failed or is unhealthy.
  const show = useApp((s) => s.settings.showDocker);
  const project = useApp((s) => s.project);
  const engine = useDocker((s) => s.engine.state);
  const dockerBad = useDocker((s) => !!project && groupContainers(s.containers, project, false).mine.some((g) => g.containers.some(hasProblem)));
  const docker = show !== 'never' && (dockerShown(show, engine) || activity === 'docker');
  // Never: the view goes at once, sidebar and tabs, as Redis's Never does.
  useEffect(() => { if (show === 'never') leaveDocker(); }, [show]);
  // Redis: shown per Settings (Auto: an instance answers or the project mentions one), dimmed
  // when the project's own isn't running; a rose dot for failed jobs not looked at yet.
  const showRedis = useApp((s) => s.settings.showRedis);
  const redisSnap = useRedis((s) => s.snap);
  const redis = showRedis !== 'never' && (redisShown(showRedis, redisSnap) || activity === 'redis');
  // Never: the view goes at once (sidebar and tab), unlike Auto's instance going away while you look at it.
  useEffect(() => { if (showRedis === 'never') leaveRedis(); }, [showRedis]);
  // Databases: shown per Settings (Auto: a connection shown in this project, a suggestion
  // found in it, or a mention); Never takes the view away at once, as Redis's does.
  const showDb = useApp((s) => s.settings.showDatabases);
  const dbSnap = useDb((s) => s.snap);
  const databases = showDb !== 'never' && (databasesShown(showDb, dbSnap) || activity === 'databases');
  useEffect(() => { if (showDb === 'never') leaveDatabases(); }, [showDb]);
  // Services and Automations (2026-11-02): only once turned on in Settings (Services never on Windows). Turned off, the
  // view goes at once, sidebar and tab, as Redis's Never does; a window restored on it opens Sessions instead.
  const services = useApp((s) => servicesView(s.settings.showServices));
  const automations = useApp((s) => s.settings.automationsEnabled);
  const loaded = useApp((s) => s.settingsLoaded);
  useEffect(() => {
    // The defaults (both off) before main's settings arrive must not close a tab restored on one of them.
    if (!loaded) return;
    const st = useApp.getState();
    if (!services) {
      if (st.activity === 'services') st.setActivity('sessions', { keepHidden: true });
      if (st.servicesOpen) st.closeTab('services');
    }
    if (!automations) {
      if (st.activity === 'automations') st.setActivity('sessions', { keepHidden: true });
      for (const r of st.autoTabs) st.closeTab(r.key);
    }
  }, [loaded, services, automations, activity]);
  const redisDim = useRedis((s) => !s.snap?.instances.some((i) => i.state === 'running'));
  const redisBad = useRedis((s) => Object.keys(s.status?.unseen ?? {}).length > 0);
  // Automations: this project's runs at work.
  const autoRuns = useApp((s) => activeCount(s.automations, s.project?.root ?? null));
  const shown = items.filter((it) => (it.id !== 'docker' || docker) && (it.id !== 'redis' || redis) && (it.id !== 'databases' || databases) && (it.id !== 'services' || services) && (it.id !== 'automations' || automations));
  // The spaces: Docker, Redis, Databases and Automations change the whole window; a hairline
  // with a little gap sets them apart from Sessions' own views.
  const firstSpace = shown.find((it) => spaceOfActivity(it.id) !== 'sessions')?.id;
  return (
    <nav className="activity-bar" aria-label={t.views}>
      {shown.map((it) => (
        <Fragment key={it.id}>
        {it.id === firstSpace && <span className="act-gap" aria-hidden="true" />}
        <button type="button" className={`act ${front === it.id ? 'is-active' : ''} ${it.id === 'docker' ? 'act-docker' : ''} ${it.id === 'redis' && redisDim ? 'is-dim' : ''}`} aria-label={it.label}
          // The view in front: a click hides the sidebar, and its tip says so.
          data-tip={front === it.id ? t.activity.hide : it.label.replace(/ \(.*\)$/, '')} data-kbd={front === it.id ? kbd('⌘B') : it.label.match(/\((.*)\)$/)?.[1]}
          aria-pressed={front === it.id} onClick={() => clickActivity(it.id)}>
          <span className="act-bar" />
          <Icon name={it.icon} />
          {it.id === 'sessions' && waiting > 0 && <span key={waitKey} className="act-dot is-waiting pulse" />}
          {it.id === 'services' && svcErrors && <span className="act-dot is-error" />}
          {it.id === 'docker' && dockerBad && <span className="act-dot is-error" />}
          {it.id === 'redis' && redisBad && <span className="act-dot is-error" />}
          {it.id === 'automations' && autoRuns > 0 && <span className="act-count">{autoRuns}</span>}
        </button>
        </Fragment>
      ))}
      <button type="button" className={`act act-bottom ${settingsOpen ? 'is-active' : ''}`} aria-label={settingsLabel} data-tip={settingsLabel} data-kbd={kbd('⌘,')}
        onClick={() => {
          const st = useApp.getState();
          // The dot opens the details of the connector that needs you.
          const id = settingsOpen ? null : attentionConnector(st.connectors);
          st.setSettingsOpen(settingsOpen ? null : id ? 'connectors' : 'appearance');
          if (id) st.openConnector(id);
        }}>
        <span className="act-bar" />
        <Icon name="settings" />
        {attention && <span className="act-dot is-waiting is-quiet" />}
      </button>
    </nav>
  );
}
