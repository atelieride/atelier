// A shell's or monitor's detail in the Background tab: title row, meta
// cards, the redacted command, then its output live (or, for a monitor, the events it sent to Claude).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InspectorEntry } from '@shared/background';
import type { RecentItem } from '@shared/background-recent';
import type { TerminalInfo } from '@shared/protocol';
import { useBackgroundFeed } from '../../background-feed-hook';
import { clockSeconds, countLabel, countsAsWork, filterLines, outputState } from '../../background-output';
import { formatElapsed, isFollowable } from '../../background-view';
import { copyText } from '../../clipboard';
import { t } from '../../i18n/en';
import { Icon } from '../Icon';
import { LogLineView } from '../LogLineView';
import { Card, DetailHead, FollowPill, LiveDot, StatePill, UnavailableCard, selectAndFocus, useFollow } from './parts';

/** Lines rendered at most (the newest): the buffer holds 5,000, the filter searches them all. */
const SHOWN = 2000;
const noPaste = () => {};
const NO_LINES: { text: string; at: number | null }[] = [];

export function OutputDetail({ term, id, entry, recent, now, visible }: { term: TerminalInfo; id: string; entry: InspectorEntry | undefined; recent: RecentItem | undefined; now: number; visible: boolean }) {
  const item = (entry ?? recent)!;
  const display = entry?.display ?? recent?.display;
  const followable = isFollowable({ id, kind: item.kind, display });
  const feed = useBackgroundFeed(term.id, id, visible, followable);
  const output = feed && !feed.unavailable && feed.kind === 'output' ? feed : null;
  const exit = output?.exit ?? recent?.exit ?? null;
  const running = !!entry && exit === null;
  const state = outputState({ exit, ended: !entry, server: !!entry?.server, watcher: !!entry?.watcher });
  const elapsed = formatElapsed((entry ? now : recent!.endedAt) - item.since);
  const ownerId = item.owner;
  const owner = ownerId ? term.work?.entries.find((e) => e.id === ownerId) ?? term.recent?.find((r) => r.id === ownerId) : undefined;
  const isMonitor = item.kind === 'monitor';
  const [view, setView] = useState<'events' | 'raw'>(isMonitor ? 'events' : 'raw');
  const [needle, setNeedle] = useState('');
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1400); return () => clearTimeout(timer); }, [copied]);

  const lines = output?.lines ?? NO_LINES;
  const dropped = output?.dropped ?? 0;
  const events = isMonitor && view === 'events';
  // The clock ticks every second: the log's rows are rebuilt only when its lines, the filter or the view change.
  const filtered = useMemo(() => filterLines(lines, needle, dropped), [lines, needle, dropped]);
  const shown = useMemo(() => (filtered.length > SHOWN ? filtered.slice(-SHOWN) : filtered), [filtered]);
  const rows = useMemo(() => (events
    ? shown.map((l) => (
        <div key={l.n} className="bgv-event">
          <span className="bgv-ev-time">{l.at !== null ? clockSeconds(l.at) : ''}</span>
          <i className="bgv-ev-dot" />
          <span className="bgv-ev-text">{l.text}</span>
        </div>
      ))
    : shown.map((l) => (
        <div key={l.n} className="bgv-line"><span className="ln">{l.n}</span><LogLineView raw={l.text} paste={null} onPaste={noPaste} /></div>
      ))), [shown, events]);
  const earlier = (needle.trim() ? 0 : dropped) + filtered.length - shown.length;
  const liveText = output?.live ?? '';
  const q = needle.trim().toLowerCase();
  const showLive = !!output && (q ? !!liveText && liveText.toLowerCase().includes(q) : !!liveText || running);
  const lastN = dropped + lines.length;
  const lnWidth = String(lastN + 1).length;
  const follow = useFollow([shown.length, shown[shown.length - 1]?.n, liveText, wrap, view, needle, visible]);
  const filterRef = useRef<HTMLInputElement>(null);
  const filterBtn = useRef<HTMLButtonElement>(null);
  // Below 360 px the filter is an icon button (⌘F presses it): open, or holding a filter, the field shows.
  const [filterOpen, setFilterOpen] = useState(false);
  const openFilter = () => { setFilterOpen(true); requestAnimationFrame(() => { filterRef.current?.focus(); filterRef.current?.select(); }); };
  const foldFilter = () => { setFilterOpen(false); requestAnimationFrame(() => { if (filterBtn.current?.offsetParent) filterBtn.current.focus(); }); };

  const copy = () => { if (display) void copyText(display).then((ok) => { if (ok) setCopied(true); }); };
  // The incomplete last line (or, while it runs with nothing pending, the caret alone); events are whole lines only.
  const liveRow = showLive && !events;
  const count = countLabel({ events, matching: q ? filtered.length : null, total: lastN });

  return (
    <div className="bgv-detail-in">
      <DetailHead kind={item.kind} label={item.label} elapsed={elapsed} pills={<>
        <StatePill tone={state.tone} label={state.label} />
        {entry?.server?.ports.map((p) => <span key={p} className="bgp-port mono">:{p}</span>)}
      </>} />
      <div className="bgv-cards">
        <Card k={t.bg.launchedBy}>
          {owner ? <button type="button" className="bgv-link" onClick={(e) => selectAndFocus(e.currentTarget, owner.id)} data-tip={owner.label}>{owner.label}</button> : t.bg.mainAgent}
        </Card>
        <Card k={t.bg.started}><span className="mono">{clockSeconds(item.since)}</span></Card>
        <Card k={t.bg.process}><span className="mono">{entry?.pid !== undefined ? t.bg.pid(entry.pid) : '—'}</span></Card>
        <Card k={t.bg.countsAsWork}>{countsAsWork(entry ?? null, now, exit)}</Card>
      </div>
      {display && (
        <div className="bgv-cmd">
          <span className="bgv-cmd-prompt mono" aria-hidden="true">$</span>
          <span className="mono" data-tip={display}>{display}</span>
          <button type="button" className={`icon-btn bgv-copy ${copied ? 'is-done' : ''}`} onClick={copy} aria-label={copied ? t.bg.copied : t.bg.copyCommandTip} data-tip={copied ? t.bg.copied : t.bg.copyCommandTip}>
            <Icon name={copied ? 'check' : 'copy'} size={14} stroke={1.8} />
          </button>
        </div>
      )}
      {!followable ? (
        <div className="bgv-note bgv-watched" role="status"><Icon name="info" size={14} stroke={1.8} /><div className="bgv-unavailable-text"><strong>{t.bg.watchedTitle}</strong><span>{t.bg.watchedText}</span></div></div>
      ) : feed?.unavailable ? <UnavailableCard reason={feed.unavailable} /> : (
        <>
          <div className="bgv-sechead">
            <span className="bgv-sec-title">
              <span className="section-label">{events ? t.bg.events : t.bg.output}</span>
              {running && <LiveDot />}
              {events && <span className="bgv-sec-hint">{t.bg.eventsHint}</span>}
            </span>
            <span className="bgv-actions">
              {isMonitor && (
                <button type="button" className="bgv-tog" onClick={() => setView(events ? 'raw' : 'events')} data-tip={events ? t.bg.rawOutput : t.bg.eventsView} aria-label={events ? t.bg.rawOutput : t.bg.eventsView}>
                  <Icon name={events ? 'terminal' : 'eye'} size={13} stroke={1.8} /><span className="label">{events ? t.bg.rawOutput : t.bg.eventsView}</span>
                </button>
              )}
              <button ref={filterBtn} type="button" className="bgv-tog bgv-filter-btn" onClick={openFilter} aria-label={t.bg.filter} data-tip={t.bg.filter}>
                <Icon name="search" size={13} stroke={1.8} />
              </button>
              <label className={`bgv-filter ${filterOpen || needle ? 'is-open' : ''}`}>
                <Icon name="search" size={12} stroke={1.8} />
                <input ref={filterRef} value={needle} onChange={(e) => setNeedle(e.target.value)} aria-label={t.bg.filter} placeholder={t.bg.filter} spellCheck={false}
                  onBlur={() => { if (!needle) setFilterOpen(false); }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return;
                    // Esc clears the filter, then (an empty field below 360 px) folds it back into its button.
                    if (needle) { e.preventDefault(); e.stopPropagation(); setNeedle(''); }
                    else if (filterOpen) { e.preventDefault(); e.stopPropagation(); foldFilter(); }
                  }} />
                {needle && <button type="button" className="bgv-filter-clear" onClick={() => { setNeedle(''); filterRef.current?.focus(); }} aria-label={t.bg.clearFilter}><Icon name="x" size={11} stroke={2} /></button>}
              </label>
              {!events && (
                <button type="button" className="bgv-tog" aria-pressed={wrap} onClick={() => setWrap((v) => !v)} data-tip={t.bg.wrap} aria-label={t.bg.wrap}>
                  <Icon name="wrap" size={13} stroke={1.8} /><span className="label">{t.bg.wrap}</span>
                </button>
              )}
              <span className="bgv-count mono">{count}</span>
            </span>
          </div>
          <div className="bgv-logwrap">
            <div ref={follow.ref} className={`bgv-log mono ${wrap || events ? 'is-wrap' : ''} ${events ? 'is-events' : ''}`} onScroll={follow.onScroll}
              tabIndex={0} role="region" aria-label={events ? t.bg.events : t.bg.output} style={{ ['--ln' as string]: `${lnWidth}ch` }}>
              {earlier > 0 && <div className="bgv-earlier">{t.bg.earlier(earlier)}</div>}
              {rows}
              {liveRow && (
                <div className="bgv-line is-live"><span className="ln">{lastN + 1}</span><LogLineView raw={liveText} paste={null} onPaste={noPaste} /></div>
              )}
              {output && shown.length === 0 && !liveRow && (
                <div className="bgv-log-empty">{q ? t.bg.noMatch : events ? t.bg.noEvents : t.bg.noOutput}</div>
              )}
            </div>
            {output && <FollowPill follow={follow.follow} live={running} jump={follow.jump} />}
          </div>
        </>
      )}
    </div>
  );
}
