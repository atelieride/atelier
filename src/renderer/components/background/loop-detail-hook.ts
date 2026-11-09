// A self-paced loop's details for the open Scheduled card: asked from main when the card
// opens and again on each turn (a new cron id). The last answer stays, tagged with what it was asked for (loopShown
// decides what of it still counts); an answer that found nothing yet (the transcript lags the hook a moment) is
// asked again a few times.
import { useEffect, useState } from 'react';
import type { LoopResult } from '@shared/background-feed';
import type { LoopTagged } from '../../cron-view';

const RETRY_MS = 1500;
const RETRIES = 3;

/**
 * Asks for one cron's details, retrying "missing", and hands each answer to `set` as an update of what is held.
 * Returns the stop: no late answer and no retry after it.
 */
export function followLoopDetail(
  ask: (terminalId: string, cronId: string) => Promise<LoopResult>, terminalId: string, cronId: string,
  set: (update: (prev: LoopTagged | null) => LoopTagged | null) => void
): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const go = (left: number) => {
    ask(terminalId, cronId).then((result) => {
      if (!live) return;
      if (!result.ok && result.reason === 'missing' && left > 0) { timer = setTimeout(() => go(left - 1), RETRY_MS); return; }
      // A final "missing" keeps the last good answer (loopShown shows only what is still this cron's).
      set((prev) => (!result.ok && result.reason === 'missing' && prev?.result.ok ? prev : { terminalId, cronId, result }));
    }).catch(() => { if (live) set((prev) => prev ?? { terminalId, cronId, result: { ok: false, reason: 'unreadable' } }); });
  };
  go(RETRIES);
  return () => { live = false; if (timer) clearTimeout(timer); };
}

export function useLoopDetail(terminalId: string, cronId: string): LoopTagged | null {
  const [tagged, setTagged] = useState<LoopTagged | null>(null);
  useEffect(() => followLoopDetail((t, c) => window.atelier.background.loop(t, c), terminalId, cronId, setTagged), [terminalId, cronId]);
  return tagged;
}
