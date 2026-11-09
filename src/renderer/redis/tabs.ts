// Redis tabs: one per view, keyed `rd:<view>`.
import type { QueueInfo } from '@shared/redis-queues';
import { isRedisTabKey } from '@shared/view-keys';
import { t } from '../i18n/en';
import type { RedisView } from '../store';
import type { TabKey } from '../tabs-model';

const VIEWS: readonly RedisView[] = ['keys', 'queues', 'live', 'overview'];

/**
 * The views the instance offers: Queues only with queues, Live and Overview only with INFO. Before
 * the status is known, all of them.
 */
export function redisViewsShown(status: { queues?: readonly QueueInfo[] | null; denied?: readonly string[] } | null | undefined): RedisView[] {
  if (!status) return [...VIEWS];
  const queues = status.queues ?? [];
  const denied = status.denied ?? [];
  return VIEWS.filter((v) => (v !== 'queues' || queues.length > 0) && ((v !== 'live' && v !== 'overview') || !denied.includes('info')));
}

/** A tab's name: its view (its space says it is Redis's). */
export function redisTabTitle(view: RedisView): string {
  return t.redis.views[view] ?? view;
}

export function redisKey(view: RedisView): TabKey {
  return `rd:${view}`;
}

/** The view a key names; null for anything that isn't a Redis tab key. */
export function parseRedisKey(k: string): RedisView | null {
  return isRedisTabKey(k) ? (k.slice(3) as RedisView) : null;
}
