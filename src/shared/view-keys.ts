// Spaces: the keys of Docker, Redis and Automations tabs, well formed. The renderer's
// encoders (docker/tabs.ts, redis/tabs.ts, automations/tabs.ts) write them; a pop-out or a saved state only names them,
// so main checks them here.

export const MAX_VIEW_KEY = 300;

/** One URI-encoded part, as encodeURIComponent writes it (never a slash, a space or a bare %). */
const PART = "(?:[A-Za-z0-9\\-_.!~*'()]|%[0-9A-F]{2})+";
/** `dk:overview`, `dk:s:<compose project>` or `dk:c:<container id>`. */
const DOCKER = new RegExp(`^dk:(?:overview|s:${PART}|c:[0-9a-f]{12,64})$`);
const REDIS = /^rd:(?:keys|queues|live|overview)$/;
/** `au:all` (every project's list) or `au:<automation id>`. */
const AUTO = /^au:[A-Za-z0-9_-]{1,64}$/;

export function isDockerTabKey(k: string): boolean {
  return k.length <= MAX_VIEW_KEY && DOCKER.test(k);
}

export function isRedisTabKey(k: string): boolean {
  return REDIS.test(k);
}

export function isAutoTabKey(k: string): boolean {
  return AUTO.test(k);
}
