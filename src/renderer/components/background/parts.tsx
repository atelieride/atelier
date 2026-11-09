// Pieces the Background tab's details share: the title row, meta cards, the live dot,
// the "not available" card and a scroller that follows its end until the user scrolls up.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Unavailable } from '@shared/background-feed';
import type { BgRow } from '../../background-view';
import { stickToEnd, type StateTone } from '../../background-output';
import { t } from '../../i18n/en';
import { useApp } from '../../store';
import { Icon } from '../Icon';
import { BG_GLYPH } from '../bg-shared';

export function DetailHead({ kind, label, pills, elapsed }: { kind: BgRow['kind']; label: string; pills: ReactNode; elapsed: string | null }) {
  return (
    <div className="bgv-head">
      <span className={`bgv-glyph k-${kind}`}><Icon name={BG_GLYPH[kind]} size={16} stroke={1.8} /></span>
      <h2 className="bgv-name" data-tip={label}>{label}</h2>
      <span className="bgv-pills-inline">{pills}</span>
      {elapsed !== null && <span className="bgv-elapsed mono"><Icon name="clock" size={12} stroke={1.8} />{elapsed}</span>}
    </div>
  );
}

export function StatePill({ tone, label }: { tone: StateTone; label: string }) {
  return <span className={`bgv-state tone-${tone}`}><i />{label}</span>;
}

export function Card({ k, children }: { k: string; children: ReactNode }) {
  return <div className="bgv-card"><span className="bgv-card-k">{k}</span><span className="bgv-card-v">{children}</span></div>;
}

export function LiveDot() {
  return <span className="bgv-live"><i className="pulse" />{t.bg.live}</span>;
}

export function UnavailableCard({ reason }: { reason: Unavailable }) {
  return (
    <div className="bgv-unavailable" role="status">
      <Icon name="info" size={16} stroke={1.8} />
      <div className="bgv-unavailable-text"><strong>{t.bg.unavailable}</strong><span>{t.bg.why[reason]}</span></div>
    </div>
  );
}

/**
 * A scroller that follows its end while the user is there (within 24 px), pauses when they scroll up and resumes from
 * `jump`. `deps` are what grows the content (line count, live text…): while following, a change scrolls to the end.
 */
export function useFollow(deps: unknown[]) {
  const node = useRef<HTMLDivElement | null>(null);
  // The box can mount after the hook (a feed that was not available, then is): a callback ref sees it come and go.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => { node.current = el; setBox(el); }, []);
  const [follow, setFollow] = useState(true);
  const following = useRef(follow);
  following.current = follow;
  useLayoutEffect(() => {
    if (box && follow) box.scrollTop = box.scrollHeight;
  }, [box, follow, ...deps]);
  // The box itself shrinking (the pane resized, a card above it grew) keeps the end in view while following.
  useEffect(() => {
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (following.current) box.scrollTop = box.scrollHeight; });
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  const onScroll = useCallback(() => {
    const el = node.current;
    if (el) setFollow(stickToEnd(el));
  }, []);
  const jump = useCallback(() => {
    const el = node.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
    el?.focus({ preventScroll: true });
  }, []);
  return { ref, follow, onScroll, jump };
}

/** The pill over a followed scroller: "Following" while at the end of something live, else a button back to the end. */
export function FollowPill({ follow, live, jump }: { follow: boolean; live: boolean; jump: () => void }) {
  if (follow) return live ? <span className="bgv-jump is-following" role="status"><i className="pulse" />{t.bg.following}</span> : null;
  return (
    <button type="button" className="bgv-jump" onClick={jump}>
      <Icon name="chevronDown" size={12} stroke={2} />{live ? t.bg.jumpToLive : t.bg.jumpToEnd}
    </button>
  );
}

/**
 * Selects an item from inside the detail (a link that unmounts with it) and gives the focus to that item's row, pill or
 * the menu button, whichever the tab's width shows: the keyboard is never dropped on the page.
 */
export function selectAndFocus(from: HTMLElement, id: string) {
  const root = from.closest('.bgv');
  useApp.getState().selectBackgroundItem(id);
  requestAnimationFrame(() => {
    const targets = root ? [...root.querySelectorAll<HTMLElement>('.bgv-list [aria-selected="true"], .bgv-pill[aria-checked="true"], .bgv-menu-btn')] : [];
    targets.find((el) => el.offsetParent !== null)?.focus();
  });
}

/** Settings › Reduce motion, or the system's. */
export function reducedMotion(): boolean {
  if (document.documentElement.dataset.motion === 'reduced') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
