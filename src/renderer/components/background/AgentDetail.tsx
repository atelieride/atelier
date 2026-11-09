// A subagent's detail in the Background tab: title row with its model,
// meta cards, the task it was given and its activity live (tool calls and messages, from its transcript).
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { InspectorEntry } from '@shared/background';
import type { RecentItem } from '@shared/background-recent';
import type { TerminalInfo } from '@shared/protocol';
import type { TimelineEntry } from '@shared/transcript';
import { useBackgroundFeed } from '../../background-feed-hook';
import { clockSeconds, formatTokens, outputState, shortModel } from '../../background-output';
import { formatElapsed } from '../../background-view';
import { t } from '../../i18n/en';
import { Icon } from '../Icon';
import { Card, DetailHead, FollowPill, LiveDot, StatePill, UnavailableCard, selectAndFocus, useFollow } from './parts';

const NO_ENTRIES: TimelineEntry[] = [];

/** The timeline's rows. */
function timelineRows(entries: TimelineEntry[], known: Set<string>) {
  return entries.map((e, i) => {
    const time = <span className="bgv-tl-time mono">{e.at !== null ? clockSeconds(e.at) : ''}</span>;
    if (e.kind === 'text') {
      return (
        <div key={`m${i}`} className="bgv-tl-row is-text">
          {time}<i className="bgv-tl-dot" />
          <div className="bgv-tl-msg"><span>{e.text}</span></div>
        </div>
      );
    }
    const watch = e.taskId && known.has(e.taskId) ? e.taskId : null;
    return (
      <div key={e.id} className={`bgv-tl-row is-tool ${e.result === 'error' ? 'is-error' : ''}`}>
        {time}<i className="bgv-tl-dot" />
        <span className="bgv-tl-main">
          <span className="bgv-tl-tool mono">{e.tool}</span>
          <span className="bgv-tl-target mono" data-tip={e.target}>{e.target}</span>
          {e.result && (
            <span className={`bgv-tl-res res-${e.result}`} data-tip={e.summary || undefined}>
              <Icon name={e.result === 'ok' ? 'check' : 'x'} size={11} stroke={2.2} />{e.summary && <span className="bgv-tl-sum">{e.summary}</span>}
            </span>
          )}
          {watch && (
            <button type="button" className="bgv-watch" onClick={(ev) => selectAndFocus(ev.currentTarget, watch)}>
              {t.bg.watch}<Icon name="chevron" size={11} stroke={2} />
            </button>
          )}
        </span>
      </div>
    );
  });
}

export function AgentDetail({ term, id, entry, recent, now, visible }: { term: TerminalInfo; id: string; entry: InspectorEntry | undefined; recent: RecentItem | undefined; now: number; visible: boolean }) {
  const feed = useBackgroundFeed(term.id, id, visible);
  const item = (entry ?? recent)!;
  const tl = feed && !feed.unavailable && feed.kind === 'timeline' ? feed : null;
  const meta = tl?.meta ?? null;
  const placeholder = id.startsWith('subagent-');
  const [tools, setTools] = useState(true);
  const [messages, setMessages] = useState(true);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskLong, setTaskLong] = useState(false);
  const taskRef = useRef<HTMLParagraphElement>(null);

  const elapsed = formatElapsed((entry ? now : recent!.endedAt) - item.since);
  const state = entry?.waiting ? { tone: 'watching' as const, label: t.bg.waitingOnShell } : outputState({ exit: null, ended: !entry });
  const lastAt = meta?.lastAt ?? entry?.lastEvent;
  const all = tl?.entries ?? NO_ENTRIES;
  const entries = useMemo(() => all.filter((e) => (e.kind === 'tool' ? tools : messages)), [all, tools, messages]);
  // Items a background Bash can link to ("Watch ›"), as a stable key: the 1 s tick does not rebuild the rows.
  const known = [...(term.work?.entries ?? []).map((e) => e.id), ...(term.recent ?? []).map((r) => r.id)].join('\n');
  const rows = useMemo(() => timelineRows(entries, new Set(known.split('\n'))), [entries, known]);
  const follow = useFollow([entries.length, tools, messages, visible]);

  // "Show more" only when the clamp hides something; measured again whenever the box changes size.
  useLayoutEffect(() => {
    const el = taskRef.current;
    if (!el || taskOpen) return;
    const measure = () => setTaskLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta?.task, taskOpen, visible]);

  return (
    <div className="bgv-detail-in">
      <DetailHead kind="agent" label={item.label} elapsed={elapsed} pills={<>
        <StatePill tone={state.tone} label={state.label} />
        {meta?.model && <span className="bgv-model mono" data-tip={meta.model}>{shortModel(meta.model)}</span>}
      </>} />
      {placeholder ? <div className="bgv-note"><Icon name="info" size={14} stroke={1.8} /><span>{t.bg.noTranscript}</span></div> : feed?.unavailable ? <UnavailableCard reason={feed.unavailable} /> : (
        <>
          <div className="bgv-cards">
            <Card k={t.bg.toolCalls}><span className="mono">{meta ? meta.tools : '—'}</span></Card>
            <Card k={t.bg.filesRead}><span className="mono">{meta ? meta.files : '—'}</span></Card>
            <Card k={t.bg.tokens}><span className="mono">{meta ? formatTokens(meta.tokens) : '—'}</span></Card>
            <Card k={t.bg.lastEventCard}>{lastAt !== undefined ? t.bg.ago(formatElapsed(now - lastAt)) : '—'}</Card>
          </div>
          {meta?.task && (
            <div className="bgv-task-box">
              <span className="section-label">{t.bg.task}</span>
              <p ref={taskRef} className={`bgv-task ${taskOpen ? 'is-open' : ''}`}>{meta.task}</p>
              {(taskLong || taskOpen) && (
                <button type="button" className="bgv-more" aria-expanded={taskOpen} onClick={() => setTaskOpen((v) => !v)}>
                  {taskOpen ? t.bg.showLess : t.bg.showMore}<Icon name={taskOpen ? 'chevronUp' : 'chevronDown'} size={11} stroke={2} />
                </button>
              )}
            </div>
          )}
          <div className="bgv-sechead">
            <span className="bgv-sec-title">
              <span className="section-label">{t.bg.activity}</span>
              {entry && <LiveDot />}
            </span>
            <span className="bgv-actions">
              <button type="button" className="bgv-tog" aria-pressed={tools} onClick={() => setTools((v) => !v)}>{t.bg.tools}</button>
              <button type="button" className="bgv-tog" aria-pressed={messages} onClick={() => setMessages((v) => !v)}>{t.bg.messages}</button>
            </span>
          </div>
          <div className="bgv-logwrap">
            <div ref={follow.ref} className="bgv-log bgv-timeline" onScroll={follow.onScroll} tabIndex={0} role="region" aria-label={t.bg.activity}>
              {rows}
              {tl && entries.length === 0 && <div className="bgv-log-empty">{t.bg.noActivity}</div>}
            </div>
            {tl && <FollowPill follow={follow.follow} live={!!entry} jump={follow.jump} />}
          </div>
        </>
      )}
    </div>
  );
}
