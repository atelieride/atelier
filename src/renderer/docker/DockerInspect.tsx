// Inspect: why it stopped, its environment (secrets masked), where it comes from, its mounts,
// network and health. Read-only; the only action that changes anything is a command to copy.
import { useEffect, useMemo, useState } from 'react';
import { dotOf, loopbackHint, maskValue, maskedText, serviceLine, type DockerContainer, type DockerDetail } from '@shared/docker';
import { clock, isFrame, type DockerLogLine } from '@shared/docker-logs';
import { portUrl } from '@shared/ports';
import { stripAnsi } from '@shared/logline';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { copyText } from '../clipboard';
import { useDocker } from './store';
import { askWhyCrashed, openCompose, startCommand } from './actions';
import { shortImage, stateText } from './view';
import { isBelow } from '@shared/paths';
import type { TabKey } from '../tabs-model';

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="dk-kv"><span className="dk-k">{k}</span><span className="dk-v">{children}</span></div>;
}

function Why({ c, lines, tabKey }: { c: DockerContainer; lines: DockerLogLine[] | null; tabKey: TabKey }) {
  const unhealthy = c.state === 'running' && c.health === 'unhealthy';
  const st = useApp.getState();
  const cmd = startCommand(c);
  const tail = (lines ?? []).filter((l) => stripAnsi(l.text).trim()).slice(-4);
  return (
    <section className="dk-card dk-why" aria-label={unhealthy ? t.docker.inspect.whyUnhealthy : t.docker.inspect.why}>
      <div className="dk-why-head">
        <Icon name="info" size={16} stroke={1.8} />
        <h3>{unhealthy ? t.docker.inspect.whyUnhealthy : t.docker.inspect.why}</h3>
        <span className="grow" />
        {c.finishedAt && !unhealthy && <span className="mono dk-dim">{t.docker.inspect.finished(clock(c.finishedAt).slice(0, 8))}</span>}
      </div>
      <div className="dk-why-facts">
        <div><span className="dk-k">{t.docker.inspect.exitCode}</span><span className={`mono dk-fact ${c.exitCode ? 'is-err' : ''}`}>{unhealthy ? '—' : c.exitCode ?? '—'}</span></div>
        <div><span className="dk-k">{t.docker.inspect.oom}</span><span className={`mono dk-fact ${c.oomKilled ? 'is-err' : ''}`}>{c.oomKilled ? t.docker.inspect.yes : t.docker.inspect.no}</span></div>
        <div><span className="dk-k">{t.docker.inspect.restarts}</span><span className={`mono dk-fact ${c.restarts ? 'is-err' : ''}`}>{c.restarts}</span></div>
        <div><span className="dk-k">{t.docker.inspect.policy}</span><span className="mono dk-fact is-small">{c.restartPolicy}</span></div>
      </div>
      {tail.length > 0 && (
        <div className="dk-why-lines mono">
          {tail.map((l) => (
            <div key={l.seq} className={isFrame(l.text) ? 'is-frame' : /error|exception|fatal|panic/i.test(l.text) ? 'is-err' : ''}>
              <span className="dk-dim">{l.at !== null ? clock(l.at) : ''}</span> {stripAnsi(l.text)}
            </div>
          ))}
        </div>
      )}
      <div className="dk-why-actions">
        <button type="button" className="btn-primary sm" onClick={() => void askWhyCrashed(c)}><Icon name="sparkle" size={12} />{t.docker.inspect.ask}</button>
        <button type="button" className="btn-ghost sm" onClick={() => st.setDockerView(tabKey, 'logs')}><Icon name="terminal" size={12} />{t.docker.inspect.openLogs}</button>
        <button type="button" className="btn-ghost sm dk-cmd" onClick={() => void copyText(cmd).then(() => st.showToast(t.docker.copied(cmd), undefined, 'info'))}
          data-tip={t.docker.inspect.copyCmd(cmd)}><Icon name="copy" size={12} /><span className="mono">{cmd}</span></button>
      </div>
    </section>
  );
}

function Env({ c, d, siblings }: { c: DockerContainer; d: DockerDetail; siblings: { name: string; exposed: readonly number[] }[] }) {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <section className="dk-card dk-env" aria-label={t.docker.inspect.env}>
      <div className="dk-card-h"><span className="section-label">{t.docker.inspect.env}</span><span className="mono dk-dim">{d.env.length}</span><span className="grow" /><span className="dk-dim">{t.docker.inspect.envNote}</span></div>
      <div className="dk-env-rows">
        {d.env.map((e) => {
          const parts = maskValue(e.key, e.value);
          const secret = parts.some((p) => p.secret);
          const open = shown.has(e.key);
          const hint = loopbackHint(e.value, d.hostNetwork, siblings, c.name, e.key);
          return (
            <div key={e.key} className={`dk-env-row ${hint ? 'has-hint' : ''}`}>
              <span className="mono dk-env-k">{e.key}</span>
              <span className="mono dk-env-v">
                {parts.length === 0 ? <span className="dk-dim">""</span> : parts.map((p, i) => (p.secret && !open ? <span key={i} className="dk-mask">••••••••</span> : <span key={i}>{p.text}</span>))}
                {hint && <span className="dk-env-hint"><Icon name="info" size={11} stroke={1.9} />{t.docker.inspect.loopback}{hint.suggestion ? ` · ${t.docker.inspect.loopbackSuggest(hint.suggestion)}` : ''}</span>}
              </span>
              {secret ? (
                <button type="button" className="icon-btn" aria-pressed={open} aria-label={open ? t.docker.inspect.hide(e.key) : t.docker.inspect.reveal(e.key)} data-tip={open ? t.docker.inspect.hide(e.key) : t.docker.inspect.reveal(e.key)}
                  onClick={() => setShown((s) => { const n = new Set(s); if (n.has(e.key)) n.delete(e.key); else n.add(e.key); return n; })}><Icon name="eye" size={13} /></button>
              ) : <span />}
            </div>
          );
        })}
        {d.env.length === 0 && <p className="dk-dim dk-pad">{t.docker.inspect.none}</p>}
      </div>
    </section>
  );
}

export function DockerInspect({ c, tabKey }: { c: DockerContainer; tabKey: TabKey }) {
  const entry = useDocker((s) => s.details[c.id]);
  const containers = useDocker((s) => s.containers);
  const project = useApp((s) => s.project);
  const [lines, setLines] = useState<DockerLogLine[] | null>(null);
  const [labels, setLabels] = useState(false);
  const [composeAt, setComposeAt] = useState<number | null>(null);
  // Fresh on open and whenever the container changes (an event re-listed it).
  const stamp = `${c.id}|${c.state}|${c.health}|${c.restarts}|${c.startedAt}|${c.finishedAt}`;
  useEffect(() => { void useDocker.getState().loadDetail(c.id); }, [stamp]);
  const problem = dotOf(c) === 'err';
  useEffect(() => {
    if (!problem) { setLines(null); return; }
    let live = true;
    void window.atelier.docker.tail(c.id, 30).then((l) => { if (live) setLines(l); }).catch(() => {});
    return () => { live = false; };
  }, [stamp, problem]);
  const composeFile = c.configFiles.find((f) => project && (isBelow(project.root, f) || isBelow(project.realRoot, f))) ?? c.configFiles[0] ?? null;
  useEffect(() => {
    setComposeAt(null);
    if (!composeFile || !c.service) return;
    let live = true;
    void window.atelier.files.read(composeFile).then((f) => { if (live && f.kind === 'text') setComposeAt(serviceLine(f.text, c.service!)); }).catch(() => {});
    return () => { live = false; };
  }, [composeFile, c.service]);
  const siblings = useMemo(() => containers.filter((x) => x.project && x.project === c.project).map((x) => ({ name: x.name, exposed: x.exposed })), [containers, c.project]);
  const d = entry?.detail;
  const st = useApp.getState();
  const rel = (p: string) => (project && isBelow(project.root, p) ? p.slice(project.root.length + 1) : project && isBelow(project.realRoot, p) ? p.slice(project.realRoot.length + 1) : null);
  const now = Date.now();
  const copyJson = () => {
    if (!d) return;
    const masked = { ...c, env: d.env.map((e) => `${e.key}=${maskedText(e.key, e.value)}`), mounts: d.mounts, networks: d.networks, labels: d.labels, restartPolicy: d.restartPolicy, command: d.command };
    void copyText(JSON.stringify(masked, null, 2)).then(() => st.showToast(t.docker.copied('JSON'), undefined, 'info'));
  };
  const healthOk = d?.healthLog.filter((p) => p.exitCode === 0).length ?? 0;
  return (
    <div className="dk-inspect">
      <div className="dk-inspect-col">
        {problem && <Why c={c} lines={lines} tabKey={tabKey} />}
        {d ? <Env c={c} d={d} siblings={siblings} /> : <p className="dk-dim dk-pad">{t.docker.inspect.loading}</p>}
      </div>
      <div className="dk-inspect-col">
        <section className="dk-card" aria-label={t.docker.inspect.overview}>
          <div className="dk-card-h"><span className="section-label">{t.docker.inspect.overview}</span></div>
          <Kv k={t.docker.inspect.image}><span className="mono">{shortImage(c.image)}</span>{d?.imageId && <span className="mono dk-dim"> {d.imageId.replace('sha256:', '').slice(0, 12)}</span>}</Kv>
          {d?.command && <Kv k={t.docker.inspect.command}><span className="mono">{d.command}</span></Kv>}
          {c.service && (
            <Kv k={t.docker.inspect.compose}>
              <span className="mono">{c.service}</span>
              {composeFile && <> in <button type="button" className="link-btn mono" onClick={() => void openCompose(c)}>{(rel(composeFile) ?? composeFile.split('/').at(-1))}{composeAt ? `:${composeAt}` : ''}</button></>}
            </Kv>
          )}
          {d?.workingDir && <Kv k={t.docker.inspect.workdir}><span className="mono">{d.workingDir}</span></Kv>}
          <Kv k={t.docker.inspect.started}>{stateText(c, now)}</Kv>
          {d?.created && <Kv k={t.docker.inspect.built}>{new Date(d.created).toLocaleString()}</Kv>}
          {d?.error && <Kv k={t.docker.inspect.error}><span className="dk-err-text">{d.error}</span></Kv>}
        </section>
        {d && d.mounts.length > 0 && (
          <section className="dk-card" aria-label={t.docker.inspect.mounts}>
            <div className="dk-card-h"><span className="section-label">{t.docker.inspect.mounts}</span><span className="mono dk-dim">{d.mounts.length}</span></div>
            {d.mounts.map((m) => {
              const r = m.type === 'bind' ? rel(m.source) : null;
              return (
                <div key={`${m.target}`} className="dk-mount">
                  <span className="dk-tag">{m.type}</span>
                  <span className="mono dk-mount-path">{m.type === 'volume' ? m.name : r ?? m.source} <span className="dk-dim">→</span> {m.target}{!m.rw && <span className="dk-dim"> ro</span>}</span>
                  {r !== null && <button type="button" className="link-btn" onClick={() => st.revealInTree(m.source)}>{t.docker.inspect.showInFiles}</button>}
                </div>
              );
            })}
          </section>
        )}
        <section className="dk-card" aria-label={t.docker.inspect.network}>
          <div className="dk-card-h"><span className="section-label">{t.docker.inspect.network}</span></div>
          {d?.networks.map((n) => <Kv key={n.name} k={n.name}><span className="mono">{n.ip || '—'}</span>{n.aliases.length > 0 && <span className="dk-dim"> · {n.aliases.filter((a) => a !== c.containerName).join(', ')}</span>}</Kv>)}
          <Kv k={t.docker.inspect.ports}>
            {c.ports.length ? <span className="dk-ports">{c.ports.map((p) => (
              <button key={`${p.host}/${p.proto}`} type="button" className="port-chip mono" onClick={() => void window.atelier.openUrl(portUrl(p.host))}>:{p.host}{p.host !== p.container ? `→${p.container}` : ''}</button>
            ))}</span> : <span className="dk-dim">{t.docker.inspect.noPorts}</span>}
          </Kv>
        </section>
        <section className="dk-card" aria-label={t.docker.inspect.health}>
          <div className="dk-card-h"><span className="section-label">{t.docker.inspect.health}</span></div>
          {d && d.healthLog.length > 0 ? (
            <div className="dk-health">
              <span className="dk-dim">{t.docker.inspect.passing(healthOk, d.healthLog.length)}</span>
              <span className="grow" />
              <span className="dk-pips">{d.healthLog.map((p, i) => <i key={i} className={p.exitCode === 0 ? 'is-ok' : 'is-err'} data-tip={`${clock(p.at)} · ${p.output || `exit ${p.exitCode}`}`} />)}</span>
            </div>
          ) : <p className="dk-dim dk-pad">{t.docker.inspect.noHealth}</p>}
        </section>
        {d && (
          <section className="dk-card" aria-label={t.docker.inspect.labels}>
            <div className="dk-card-h">
              <button type="button" className="dk-fold-head" aria-expanded={labels} onClick={() => setLabels(!labels)}>
                <Icon name={labels ? 'chevronDown' : 'chevron'} size={11} stroke={2} /><span className="section-label">{t.docker.inspect.labels}</span><span className="mono dk-dim">{Object.keys(d.labels).length}</span>
              </button>
              <span className="grow" />
              <button type="button" className="link-btn" data-tip={t.docker.inspect.copyJsonTip} onClick={copyJson}>{t.docker.inspect.copyJson}</button>
            </div>
            {labels && Object.entries(d.labels).map(([k, v]) => <Kv key={k} k={k}><span className="mono">{v}</span></Kv>)}
          </section>
        )}
      </div>
    </div>
  );
}
