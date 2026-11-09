// The Redis view's states: no instance, a password wanted, not running, unsupported, denied —
// each says what happened and what to do; Atelier never starts servers, it offers commands to copy.
import { useState } from 'react';
import { endpointLabel, type RedisInstance, type RedisSnapshot } from '@shared/redis';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { openContainer } from '../docker/actions';
import { copyWithToast } from './actions';
import { NONE, useRedis } from './store';
import { agoText } from './view';

const where = (i: RedisInstance) => (i.endpoint.kind === 'tcp' ? `127.0.0.1:${i.endpoint.port}` : i.endpoint.path);

function Copyable({ cmd }: { cmd: string }) {
  return (
    <button type="button" className="rd-copy-cmd mono" data-tip={t.redis.copy} onClick={() => copyWithToast(cmd, cmd)}>
      <Icon name="copy" size={11} stroke={1.8} />{t.redis.copy} {cmd}
    </button>
  );
}

function AuthCard({ i, compact }: { i: RedisInstance; compact: boolean }) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = t.redis.states;
  const run = async (a: { useEnv?: boolean }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await window.atelier.redis.auth({ key: i.key, ...(a.useEnv ? { useEnv: true } : { password, ...(user.trim() ? { user: user.trim() } : {}) }) }).catch(() => ({ ok: false as const, reason: 'unreachable' as const }));
    setBusy(false);
    if (!r.ok) setError(r.reason === 'wrong' ? s.wrongPassword : s.unreachable);
    else setPassword('');
  };
  return (
    <div className={`rd-state is-auth ${compact ? 'is-compact' : ''}`} role="group" aria-label={s.authTitle(`${i.server?.name ?? 'redis'} · ${endpointLabel(i.endpoint)}`)}>
      <p className="rd-state-head"><i className="rd-dot is-warn" aria-hidden="true" />{s.authTitle(`${i.server?.name ?? 'redis'} · ${endpointLabel(i.endpoint)}`)}</p>
      {i.envPassword && (
        <div className="rd-env-found">
          <span>{s.envFound(i.envPassword)}</span>
          <button type="button" className="btn-primary sm" disabled={busy} onClick={() => void run({ useEnv: true })}>{s.useIt}</button>
        </div>
      )}
      <form className="rd-auth-form" onSubmit={(e) => { e.preventDefault(); if (password) void run({}); }}>
        <label className="rd-field"><span>{s.user}</span><input value={user} onChange={(e) => setUser(e.target.value)} placeholder={s.userPlaceholder} spellCheck={false} autoComplete="off" /></label>
        <label className="rd-field"><span>{s.password}</span><input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} autoComplete="off" /></label>
        {error && <p className="rd-error" role="alert">{error}</p>}
        <button type="submit" className="btn-ghost sm" disabled={!password || busy}>{s.connect}</button>
      </form>
      <p className="rd-state-note"><Icon name="lock" size={12} />{s.authNote}</p>
    </div>
  );
}

function StoppedCard({ i, snap, compact }: { i: RedisInstance; snap: RedisSnapshot; compact: boolean }) {
  const s = t.redis.states;
  const c = i.container;
  const service = c?.service;
  return (
    <div className={`rd-state is-stopped ${compact ? 'is-compact' : ''}`} role="status">
      <p className="rd-state-head"><i className="rd-dot is-off" aria-hidden="true" />{s.stoppedTitle}</p>
      <p className="rd-state-hint">{i.hint ? s.expects(where(i), i.hint.replace("this project's ", '')) : s.expectsPlain(where(i))}</p>
      {c && (
        <div className="rd-state-box">
          <p>{c.finishedAt ? s.containerExited(c.name, agoText(Date.now() - c.finishedAt)) : s.containerDown(c.name)}</p>
          <div className="rd-state-actions">
            <button type="button" className="btn-ghost sm" onClick={() => openContainer(c.id, 'inspect')}><Icon name="whale" size={12} />{s.openDocker}</button>
            <Copyable cmd={service ? `docker compose up -d ${service}` : `docker start ${c.name}`} />
          </div>
        </div>
      )}
      {snap.brew && !c && (
        <div className="rd-state-box">
          <p>{s.brewInstead}</p>
          <Copyable cmd="brew services start redis" />
        </div>
      )}
      <p className="rd-state-note">{s.neverStart}</p>
    </div>
  );
}

/** What to show instead of the view when the picked instance can't be read (null: it can). */
export function RedisStateCard({ compact = false }: { compact?: boolean }) {
  const snap = useRedis((s) => s.snap);
  const pick = snap?.instances.find((i) => i.key === snap.pick) ?? null;
  const s = t.redis.states;
  if (!snap?.probed) return <div className={`rd-state ${compact ? 'is-compact' : ''}`} role="status"><p className="rd-state-hint"><span className="dk-spin" aria-hidden="true" />{s.probing}</p></div>;
  if (!pick) {
    return (
      <div className={`rd-state is-none ${compact ? 'is-compact' : ''}`} role="status">
        <span className="rd-state-icon"><Icon name="redis" size={compact ? 24 : 30} /></span>
        <p className="rd-state-title">{s.noneTitle}</p>
        <p className="rd-state-hint">{s.noneHint}</p>
        <button type="button" className="btn-ghost sm" onClick={() => useRedis.getState().setSheet({ kind: 'instances' })}>{s.add}</button>
      </div>
    );
  }
  if (pick.state === 'running') return null;
  if (pick.state === 'auth') return <AuthCard key={pick.key} i={pick} compact={compact} />;
  if (pick.state === 'stopped') return <StoppedCard i={pick} snap={snap} compact={compact} />;
  const [title, hint] = pick.state === 'denied' ? [s.deniedTitle, s.deniedHint(where(pick))] : pick.why === 'tls' ? [s.tlsTitle, s.tlsHint(where(pick))] : [s.notRedisTitle, s.notRedisHint(where(pick))];
  return (
    <div className={`rd-state ${compact ? 'is-compact' : ''}`} role="status">
      <span className="rd-state-icon"><Icon name="redis" size={compact ? 24 : 30} /></span>
      <p className="rd-state-title">{title}</p>
      <p className="rd-state-hint">{hint}</p>
    </div>
  );
}

/** The amber note when this user can't run what some views need. */
export function LimitedNote() {
  const denied: readonly string[] = useRedis((s) => s.status?.denied) ?? NONE;
  const cmds = denied.flatMap((d) => (d === 'info' ? ['INFO'] : d === 'monitor' ? ['MONITOR'] : d === 'clients' ? ['CLIENT LIST'] : d === 'slowlog' ? ['SLOWLOG'] : []));
  if (!cmds.length) return null;
  return <div className="rd-note is-amber" role="note"><Icon name="warning" size={14} /><span>{t.redis.states.limited(cmds.join(', '))}</span></div>;
}

export function ModeNote() {
  const mode = useRedis((s) => s.snap?.instances.find((i) => i.key === s.snap?.pick)?.server?.mode);
  const settingsOpen = useApp((s) => s.settingsOpen);
  if (!mode || mode === 'standalone' || settingsOpen) return null;
  return <div className="rd-note is-amber" role="note"><Icon name="warning" size={14} /><span>{mode === 'cluster' ? t.redis.states.cluster : t.redis.states.sentinel}</span></div>;
}
