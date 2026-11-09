import { useEffect, useState } from 'react';
import { counts, displayCommand } from '../selectors';
import { goToAttention } from '../attention-nav';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { useRisingKey } from '../motion';
import { footerUpdate } from '../update-view';
import { applyUpdate } from '../update-actions';
import { useDocker } from '../docker/store';
import { dockerShown, hasProblem } from '../docker/view';
import { openStack } from '../docker/actions';
import { groupContainers } from '@shared/docker';
import { fmtBytes } from '@shared/redis';
import { useRedis } from '../redis/store';
import { redisShown } from '../redis/view';
import { openRedis } from '../redis/actions';
import { footerCounts } from '../automations/view';
import { servicesView } from '../features';
import type { ServicePane } from '@shared/services';
import { useShallow } from 'zustand/react/shallow';
import { useDb } from '../databases/store';
import { dbFoot, liveConn } from '../databases/view';

const NO_PANES: ServicePane[] = [];
import { Icon } from './Icon';

/**
 * Databases: with a database connected in this window, `pg · <the connection in use>` (the
 * danger color for production); a click opens the view. Its name ellipsizes before any other item moves.
 */
export function DbFootItem() {
  const show = useApp((s) => s.settings.showDatabases);
  const db = useDb(useShallow((s) => dbFoot(liveConn(show, s.snap))));
  return db && (
    <button type="button" className={`foot-item db-foot-item ${db.prod ? 'is-prod' : 'is-ok'}`} data-tip={db.tip} onClick={() => useApp.getState().setActivity('databases')}>
      <i /><span>{t.db.foot(db.name)}</span>
    </button>
  );
}

export function Footer() {
  const daemon = useApp((s) => s.daemon);
  const size = useApp((s) => s.size);
  const terminals = useApp((s) => s.terminals);
  const selectedId = useApp((s) => s.selectedId);
  // Services (tmux): only once turned on in Settings › Appearance (2026-11-02); the list empties as it turns off anyway.
  const services = useApp((s) => (servicesView(s.settings.showServices) ? s.services : NO_PANES));
  const openServices = useApp((s) => s.openServices);
  const updateStatus = useApp((s) => s.updateStatus);
  const pill = footerUpdate(useApp((s) => s.updateReady), updateStatus);
  const updatePhase = updateStatus?.phase.kind;
  const svcErrors = services.reduce((n, p) => n + p.errors, 0);
  // Docker: this project's stack at a glance, like Services; a click opens its logs.
  const project = useApp((s) => s.project);
  // Automations: every project's runs at work, and those waiting.
  const autoOn = useApp((s) => s.settings.automationsEnabled);
  const autoAutomated = useApp((s) => footerCounts(s.automations).automated);
  const autoWaiting = useApp((s) => footerCounts(s.automations).waiting);
  const auto = { automated: autoAutomated, waiting: autoWaiting };
  const showDocker = useApp((s) => s.settings.showDocker);
  const dockerKey = useDocker((s) => {
    if (s.engine.state !== 'running' || !project || !dockerShown(showDocker, s.engine.state)) return '';
    const g = groupContainers(s.containers, project, false).mine[0];
    return g ? `${g.project}|${g.running}|${g.total}|${g.containers.filter(hasProblem).length}` : '';
  });
  const [dp, du, dt, df] = dockerKey.split('|');
  const docker = dockerKey ? { project: dp!, up: Number(du), total: Number(dt), failed: Number(df) } : null;
  // Redis: the picked instance at a glance; failed jobs open Queues, else Overview.
  const showRedis = useApp((s) => s.settings.showRedis);
  const redisKey = useRedis((s) => {
    const info = s.status?.info;
    if (!info || !redisShown(showRedis, s.snap)) return '';
    const failed = (s.status?.queues ?? []).reduce((n, q) => n + (q.counts.failed ?? 0), 0);
    return `${info.usedMemory}|${info.ops}|${failed}`;
  });
  const [rm, ro, rf] = redisKey.split('|');
  const redis = redisKey ? { mem: Number(rm), ops: Number(ro), failed: Number(rf) } : null;
  const c = counts(terminals);
  // Each new waiting session replays the dot's cue; an answered one does not.
  const waitKey = useRisingKey(c.waiting);
  const cur =terminals.find((x) => x.id === selectedId);
  // This app's version: atelierd's is the one of the app that started it, often older yet running the same code.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { void window.atelier.appInfo().then((i) => setVersion(i?.version ?? null)).catch(() => {}); }, []);
  return (
    <footer className="footer">
      <button type="button" className={`foot-item ${c.waiting ? 'is-waiting' : ''}`} disabled={!c.waiting}
        onClick={goToAttention}>
        <i key={waitKey} className={c.waiting ? 'pulse' : ''} />{t.waitingCount(c.waiting)}
      </button>
      <span className={`foot-item ${c.running ? 'is-working' : ''}`}><i /><span>{t.runningCount(c.running)}</span></span>
      {services.length > 0 && (
        <button type="button" className={`foot-item ${svcErrors ? 'is-error' : 'is-ok'}`} onClick={() => openServices()}>
          <i />{t.servicesSummary(services.filter((p) => p.running).length, services.length, svcErrors)}
        </button>
      )}
      {docker && (
        <button type="button" className={`foot-item ${docker.failed ? 'is-error' : 'is-ok'}`} onClick={() => openStack(docker.project)}>
          <i />{t.docker.footer(docker.up, docker.total, docker.failed)}
        </button>
      )}
      {autoOn && auto.automated + auto.waiting > 0 && (
        <button type="button" className="foot-item au-foot-item" onClick={() => useApp.getState().setActivity('automations')}>
          <Icon name="automation" size={12} />{t.auto.footer(auto.automated, auto.waiting)}
        </button>
      )}
      {redis && (
        <button type="button" className={`foot-item rd-foot-item ${redis.failed ? 'is-error' : 'is-ok'}`} onClick={() => openRedis(redis.failed ? 'queues' : 'overview')}>
          <i />{t.redis.footerHead(fmtBytes(redis.mem), redis.ops)}{redis.failed > 0 && <span className="rd-foot-failed">{t.redis.footerFailed(redis.failed)}</span>}
        </button>
      )}
      <DbFootItem />
      {daemon.incompatible && <span className="footer-warn">{t.daemonIncompatible}</span>}
      {(daemon.incompatible || daemon.mismatch) && <button type="button" className="footer-action" onClick={() => void window.atelier.restartDaemon()}>{t.restartDaemon}</button>}
      {!daemon.connected && !daemon.incompatible && <span className="footer-warn">{t.daemonDown}</span>}
      {daemon.mismatch && daemon.version && <span className="footer-warn">{t.daemonMismatch(daemon.version)}</span>}
      <span className="grow" />
      {pill === 'ready' && (
        <button type="button" className="foot-update" data-tip={t.updateTip} onClick={applyUpdate}>
          <i />{t.updateReady}<b>{t.updateRestart}</b>
        </button>
      )}
      {pill === 'available' && (
        <button type="button" className="foot-update is-quiet" data-tip={updatePhase === 'location' ? t.updateMoveTip : updatePhase === 'store' ? t.updateStoreTip : t.updateAvailableTip} onClick={() => useApp.getState().setSettingsOpen('about')}>
          <i />{t.updateAvailable}
        </button>
      )}
      {cur && size.cols > 0 && <span className="mono foot-dim">{displayCommand(cur)} · {t.footerTerm(size.cols, size.rows)}</span>}
      {version && <span className="mono foot-dim">{t.footerVersion(version)}</span>}
    </footer>
  );
}
