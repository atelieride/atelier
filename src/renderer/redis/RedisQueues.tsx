// The Queues view: a card per queue (depths, workers, throughput), the selected queue's jobs by
// state, a job's error, stacks, options and data; Retry and Remove where Atelier writes, a command to copy elsewhere.
import { useEffect, useMemo } from 'react';
import { maskTree } from '@shared/redis';
import type { JobInfo, JobState, QueueInfo } from '@shared/redis-queues';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { radioNext } from '../radio';
import { sendTarget } from '../docker/actions';
import { Sparkline } from '../docker/Sparkline';
import { askJob, askJobs, copyJobJson, copyWithToast, libLabel, loadJob, openNamespace, reloadJobs, sendJob } from './actions';
import { JsonView } from './RedisValue';
import { NONE, useRedis } from './store';
import { doneRate, queueDot, relTime } from './view';
import { kbd } from '../kbd';

const STATES: JobState[] = ['waiting', 'active', 'delayed', 'failed'];

function Card({ q, selected }: { q: QueueInfo; selected: boolean }) {
  const v = t.redis.queuesView;
  const dot = queueDot(q);
  const rate = doneRate(q.done);
  const workers = q.counts.paused && !q.workers ? v.pausedNoWorker : q.workers === null ? v.unknown : v.worker(q.workers);
  const n = (x: number | null) => (x === null ? v.unknown : x.toLocaleString('en-US'));
  return (
    <button type="button" className={`rd-qcard ${selected ? 'is-selected' : ''}`} aria-pressed={selected}
      onClick={() => { useRedis.getState().pickQueue(q.id, (q.counts.failed ?? 0) > 0 ? 'failed' : 'waiting'); window.atelier.redis.seen(q.id); }}>
      <span className="rd-qcard-head">
        <i className={`rd-dot is-${dot}`} aria-hidden="true" />
        <span className="rd-qcard-name dk-ellipsis">{q.name}</span>
        <span className="grow" />
        <span className={`rd-qcard-workers ${q.counts.paused ? 'is-warn' : ''}`}>{workers}</span>
      </span>
      <span className="rd-qcard-counts">
        <span className="rd-qnum"><b className="mono">{n(q.counts.waiting)}</b>{v.counts.waiting}</span>
        <span className="rd-qnum"><b className="mono is-active">{n(q.counts.active)}</b>{v.counts.active}</span>
        <span className="rd-qnum"><b className="mono">{n(q.counts.delayed)}</b>{v.counts.delayed}</span>
        <span className="rd-qnum"><b className={`mono ${(q.counts.failed ?? 0) > 0 ? 'is-failed' : ''}`}>{n(q.counts.failed)}</b>{v.counts.failed}</span>
      </span>
      <span className="rd-qcard-foot">
        <Sparkline values={q.done ?? []} width={150} height={26} floor={2} tone={dot === 'err' ? 'pink' : dot === 'work' ? 'sky' : dot === 'warn' ? 'dim' : 'done'} />
        <span className="grow" />
        <span className="mono rd-dim">{rate === '—' || rate === 'idle' ? (rate === 'idle' ? v.idle : rate) : v.done(rate)}</span>
      </span>
      {q.error && <span className="rd-qcard-error">{v.queueError}</span>}
    </button>
  );
}

function StateTabs({ q, state }: { q: QueueInfo; state: JobState }) {
  const v = t.redis.queuesView;
  const count = (s: JobState) => q.counts[s];
  return (
    <div className="seg rd-seg" role="radiogroup" aria-label={v.statesLabel} onKeyDown={(e) => {
      const next = radioNext(STATES, state, e.key);
      if (next === null) return;
      e.preventDefault();
      useRedis.getState().setJobState(next);
    }}>
      {STATES.map((s) => (
        <button key={s} type="button" role="radio" aria-checked={state === s} tabIndex={state === s ? 0 : -1} className={state === s ? 'is-on' : ''} onClick={() => useRedis.getState().setJobState(s)}>
          {v.states[s]} <span className={`mono ${s === 'failed' && (count(s) ?? 0) > 0 ? 'is-failed' : ''}`}>{count(s) ?? '—'}</span>
        </button>
      ))}
    </div>
  );
}

function JobRow({ j, state, selected, now }: { j: JobInfo; state: JobState; selected: boolean; now: number }) {
  const tries = j.attempts !== null ? `${j.attempts}${j.maxAttempts !== null ? `/${j.maxAttempts}` : ''}` : '—';
  return (
    <button type="button" className={`rd-jrow ${selected ? 'is-selected' : ''}`} aria-current={selected || undefined} onClick={() => void loadJob(j.id)}>
      <span className="mono rd-dim">#{j.id.length > 8 ? `${j.id.slice(0, 7)}…` : j.id}</span>
      <span className="rd-jrow-main">
        <span className="rd-jrow-name dk-ellipsis">{j.name}</span>
        {j.reason && <span className="mono rd-jrow-reason dk-ellipsis">{j.reason}</span>}
      </span>
      <span className={`mono is-right ${state === 'failed' ? 'is-failed' : 'rd-dim'}`}>{tries}</span>
      <span className="mono is-right rd-dim">{j.at ? relTime(j.at, now) : '—'}</span>
    </button>
  );
}

function Detail({ q, state }: { q: QueueInfo; state: JobState }) {
  const job = useRedis((s) => s.job);
  const all = useRedis((s) => s.allStacks);
  const folds = useRedis((s) => s.folds);
  const edits = useApp((s) => s.settings.redisEdits === 'ask');
  const v = t.redis.queuesView;
  const target = sendTarget();
  if (!job) return <div className="rd-jdetail"><p className="rd-pane-empty">{v.pick}</p></div>;
  const j = job.info;
  const stacks = all ? j.stacks : j.stacks.slice(-1);
  const now = Date.now();
  const chip = state === 'failed' ? v.chipFailed(`${j.attempts ?? '?'}${j.maxAttempts !== null ? `/${j.maxAttempts}` : ''}`) : v.chip[state];
  const can = q.actions && state === 'failed' && edits;
  const time = (x: number | null) => (x ? new Date(x).toLocaleTimeString('en-GB') : '');
  return (
    <section className="rd-jdetail" aria-label={`${j.name} #${j.id}`}>
      <div className="rd-jdetail-head">
        <span className="rd-jdetail-name">{j.name}</span>
        <span className="mono rd-dim">#{j.id}</span>
        <span className={`dk-chip-state tone-${state === 'failed' ? 'err' : state === 'active' ? 'ok' : 'off'}`}><i className={`dk-dot is-${state === 'failed' ? 'err' : state === 'active' ? 'ok' : 'off'}`} aria-hidden="true" />{chip}</span>
        <span className="grow" />
        {can ? (
          <>
            <button type="button" className="btn-ghost sm" data-tip={v.retryTip} onClick={() => useRedis.getState().setSheet({ kind: 'job', action: 'retry', queue: q.id, job: j })}>{v.retry}</button>
            <button type="button" className="btn-ghost sm is-danger" onClick={() => useRedis.getState().setSheet({ kind: 'job', action: 'remove', queue: q.id, job: j })}>{v.remove}</button>
          </>
        ) : state === 'failed' && job.command ? (
          <button type="button" className="btn-ghost sm mono" data-tip={v.unsupported(libLabel(q.lib))} onClick={() => copyWithToast(job.command!, job.command!)}><Icon name="copy" size={11} />{v.copyRetry}</button>
        ) : (
          <button type="button" className="btn-ghost sm" onClick={() => copyWithToast(j.id, `#${j.id}`)}><Icon name="copy" size={11} />{v.copyId}</button>
        )}
      </div>
      <div className="rd-jdetail-body">
        {(j.reason || stacks.length > 0) && (
          <div className={`rd-errbox ${state === 'failed' ? '' : 'is-neutral'}`}>
            {j.reason && <span className="mono rd-errbox-reason">{j.reason}</span>}
            {stacks.map((st, si) => (
              <div key={si} className="rd-stack">
                {all && j.stacks.length > 1 && <span className="section-label">{v.attempt(j.stacks.length - stacks.length + si + 1)}</span>}
                {st.filter((line, i) => !(i === 0 && line.trim() === `Error: ${j.reason}`.trim()) && /^\s*(at |File |#\d|\S+\.(rb|py|php|go|ts|js):\d)/.test(line)).slice(0, all ? 40 : 6).map((line, i) => <Frame key={i} line={line} />)}
                {!all && st.length > 7 && <span className="mono rd-dim">{v.moreFrames(st.length - 7)}</span>}
              </div>
            ))}
            {j.stacks.length > 1 && (
              <button type="button" className="link-btn mono" onClick={() => useRedis.getState().setAllStacks(!all)}>{all ? v.lastAttempt : v.eachAttempt(j.stacks.length)}</button>
            )}
          </div>
        )}
        <dl className="rd-jmeta mono">
          {j.queuedAt && <><dt>{v.queued}</dt><dd>{time(j.queuedAt)} <span className="rd-dim">· {relTime(j.queuedAt, now)}</span></dd></>}
          {(j.attempts !== null || j.backoff) && <><dt>{v.attempts}</dt><dd>{v.attemptsLine(j.attempts, j.maxAttempts, time(j.processedOn), j.backoff)}</dd></>}
          {j.opts && <><dt>{v.options}</dt><dd className="dk-ellipsis">{Object.entries(j.opts).filter(([k]) => k !== 'jobId').slice(0, 6).map(([k, x]) => `${k} ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(' · ')}</dd></>}
          {j.key && <><dt>{v.key}</dt><dd><button type="button" className="link-btn mono" onClick={() => { useRedis.getState().setKey(j.key!); openNamespace(j.key!.split(':')[0]!); }}>{j.key}</button></dd></>}
        </dl>
        {j.data !== null && j.data !== undefined && (
          <div className="rd-jdata">
            <span className="section-label">{v.data}</span>
            {typeof j.data === 'object' ? <JsonView value={maskTree(j.data, true)} folds={folds} onToggle={(p) => useRedis.getState().toggleFold(`job:${p}`)} /> : <pre className="rd-text mono">{String(j.data)}</pre>}
          </div>
        )}
      </div>
      <div className="rd-selbar" role="toolbar" aria-label={`${j.name} #${j.id}`}>
        {state === 'failed' && <button type="button" className="btn-primary sm" onClick={() => void askJob(q.id, state, j.id)}><Icon name="sparkle" size={12} />{v.askWhy}</button>}
        <button type="button" className={`${state === 'failed' ? 'btn-ghost' : 'btn-primary'} sm sel-send`} disabled={!target} data-tip={target ? t.redis.bar.sendTip : t.redis.noSession} onClick={() => void sendJob(q.id, state, j.id)}>
          <span className="dk-ellipsis">{target ? t.redis.bar.sendTo(target.title) : t.redis.bar.sendNone}</span>{target && <span className="kbd-in">{kbd('⌥↩')}</span>}
        </button>
        <button type="button" className="btn-ghost sm rd-wide" onClick={() => copyJobJson(j)}>{v.copyJson}</button>
      </div>
    </section>
  );
}

/** A stack frame; one pointing into the project opens the file at its line. */
function Frame({ line }: { line: string }) {
  const project = useApp((s) => s.project);
  const m = /((?:\/[\w.@-]+)+\.(?:ts|tsx|js|mjs|cjs|py|rb|php|go)):(\d+)(?::\d+)?/.exec(line);
  const path = m?.[1];
  // A frame inside the container (/app/src/…) maps to the project when the same relative path exists there.
  const rel = path ? path.replace(/^\/(app|usr\/src\/app|srv|code|var\/www(\/html)?)\//, '') : null;
  if (!m || !project || !rel || rel === path || rel.includes('node_modules/') || rel.includes('vendor/')) return <span className="mono rd-frame">{line.trim()}</span>;
  const start = line.indexOf(path!);
  return (
    <span className="mono rd-frame">
      {line.slice(0, start).trimStart()}
      <button type="button" className="link-btn mono" onClick={() => useApp.getState().openFile(`${project.root}/${rel}`, rel, Number(m[2]), undefined, { preview: true })}>{rel}:{m[2]}</button>
      {line.slice(start + m[0].length)}
    </span>
  );
}

export function RedisQueues({ visible }: { visible: boolean }) {
  const queues: readonly QueueInfo[] = useRedis((s) => s.status?.queues) ?? NONE;
  const queue = useRedis((s) => s.queue);
  const state = useRedis((s) => s.jobState);
  const jobs = useRedis((s) => s.jobs);
  const loading = useRedis((s) => s.jobsLoading);
  const jobId = useRedis((s) => s.jobId);
  const q = queues.find((x) => x.id === queue) ?? null;
  const v = t.redis.queuesView;
  useEffect(() => { if (visible && !q && queues.length) useRedis.getState().pickQueue(queues.find((x) => (x.counts.failed ?? 0) > 0)?.id ?? queues[0]!.id, queues.some((x) => (x.counts.failed ?? 0) > 0) ? 'failed' : 'waiting'); }, [visible, q, queues]);
  useEffect(() => { if (visible && queue) { void reloadJobs(); window.atelier.redis.seen(queue); } }, [visible, queue, state]);
  // The counts moved: the list follows (a job failed, one was retried).
  const sig = q ? `${q.counts.waiting}|${q.counts.active}|${q.counts.delayed}|${q.counts.failed}` : '';
  useEffect(() => { if (visible && queue && sig) void reloadJobs(); }, [sig]);
  const same = useMemo(() => (state === 'failed' && jobs && jobs.length > 1 && jobs.every((j) => j.reason && j.reason === jobs[0]!.reason) ? jobs.length : 0), [jobs, state]);
  const now = Date.now();
  if (!queues.length) return <div className="dk-center"><p className="dk-dim">{v.noQueues}</p></div>;
  return (
    <div className="rd-queues">
      <div className="rd-qcards">{queues.map((x) => <Card key={x.id} q={x} selected={x.id === queue} />)}</div>
      {q && (
        <div className="rd-qsplit">
          <section className="rd-jlist" aria-label={q.name}>
            <div className="rd-jlist-head">
              <span className="rd-jlist-name">{q.name}</span>
              <span className="grow" />
              <StateTabs q={q} state={state} />
            </div>
            <div className="rd-jrow is-head" aria-hidden="true"><span>{v.cols.job}</span><span>{v.cols.reason}</span><span className="is-right">{v.cols.tries}</span><span className="is-right">{v.cols.when}</span></div>
            <div className="rd-jscroll">
              {jobs?.map((j) => <JobRow key={j.id} j={j} state={state} selected={j.id === jobId} now={now} />)}
              {jobs && jobs.length === 0 && <p className="rd-pane-empty">{v.none}</p>}
              {!jobs && loading && <p className="rd-pane-empty">{v.loading}</p>}
            </div>
            {state === 'failed' && jobs && jobs.length > 0 && (
              <div className="rd-jlist-foot">
                <span className="rd-dim">{same ? v.sameReason(same) : ''}</span>
                <span className="grow" />
                <button type="button" className="btn-ghost sm" onClick={() => void askJobs(q.id)}><Icon name="sparkle" size={12} />{v.askAll(Math.min(20, q.counts.failed ?? jobs.length))}</button>
              </div>
            )}
          </section>
          <Detail q={q} state={state} />
        </div>
      )}
    </div>
  );
}
