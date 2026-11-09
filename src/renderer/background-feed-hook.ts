import { useEffect } from 'react';
import { feedKey } from '@shared/background-feed';
import { useApp, type BgFeedState } from './store';

/**
 * Follows one item while it is shown: watch on show, unwatch on hide/change/unmount.
 * The buffer outlives a hide (the tab switched away and back): a monitor's events keep their arrival times, merged
 * into main's fresh snapshot by the store. It goes when the item changes, the view unmounts or the terminal leaves.
 * Cron rows, placeholders and items Claude Code watches itself (no command) have no file: nothing is watched for them.
 */
export function useBackgroundFeed(terminalId: string | null, itemId: string | null, visible: boolean, followable = true): BgFeedState | null {
  const key = terminalId && itemId ? feedKey(terminalId, itemId) : null;
  const feed = useApp((s) => (key ? s.bgFeeds[key] ?? null : null));
  const follows = followable && !!terminalId && !!itemId && !itemId.startsWith('cron:') && !itemId.startsWith('subagent-');
  useEffect(() => {
    if (!follows) return;
    const k = feedKey(terminalId!, itemId!);
    return () => useApp.getState().dropBackgroundFeed(k);
  }, [terminalId, itemId, follows]);
  useEffect(() => {
    if (!follows || !visible) return;
    let live = true;
    const k = feedKey(terminalId!, itemId!);
    useApp.getState().watchBackground(terminalId!, itemId!).then((r) => {
      if (live && !r.ok) useApp.getState().applyBackgroundFeed({ key: k, kind: 'output', lines: [], live: '', reset: true, seq: 0, dropped: 0, exit: null, at: Date.now(), unavailable: r.reason });
    }).catch(() => {});
    return () => {
      live = false;
      useApp.getState().unwatchBackground(terminalId!, itemId!);
    };
  }, [terminalId, itemId, visible, follows]);
  return feed;
}
