// The only Lua Atelier ever sends to Redis: retry, undo a retry, and remove for BullMQ 5 and
// Sidekiq, each checked and done atomically on the server. The client accepts EVAL/EVALSHA of exactly these texts
// (by SHA-1), nothing else. BullMQ's own reprocessJob is mirrored for a failed job; the refusals (queue paused, job
// gone or no longer failed, part of a flow) leave everything as it was.
import { createHash } from 'node:crypto';

export const QUEUE_SCRIPTS = {
  // KEYS: job, failed, wait, meta, active, marker, events. ARGV: id, LPUSH|RPUSH.
  // -1 no such job, -3 not failed (any more), -4 queue paused, 1 done.
  bullmqRetry: `-- Atelier: retry a failed BullMQ 5 job (BullMQ's reprocessJob for "failed")
local rcall = redis.call
if rcall("EXISTS", KEYS[1]) == 0 then return -1 end
if rcall("HEXISTS", KEYS[4], "paused") == 1 then return -4 end
if not rcall("ZSCORE", KEYS[2], ARGV[1]) then return -3 end
rcall("ZREM", KEYS[2], ARGV[1])
rcall("HDEL", KEYS[1], "finishedOn", "processedOn", "failedReason")
if ARGV[2] == "RPUSH" then rcall("RPUSH", KEYS[3], ARGV[1]) else rcall("LPUSH", KEYS[3], ARGV[1]) end
local conc = rcall("HGET", KEYS[4], "concurrency")
if not conc or rcall("LLEN", KEYS[5]) < tonumber(conc) then rcall("ZADD", KEYS[6], 0, "0") end
local maxEvents = tonumber(rcall("HGET", KEYS[4], "opts.maxLenEvents") or "10000") or 10000
rcall("XADD", KEYS[7], "MAXLEN", "~", maxEvents, "*", "event", "waiting", "jobId", ARGV[1], "prev", "failed")
return 1`,
  // KEYS: job, failed, wait. ARGV: id, failed score, finishedOn, processedOn, failedReason ('' = absent).
  // 0 already picked up (not waiting any more), 1 back in failed as it was.
  bullmqUnretry: `-- Atelier: undo a retry while the job still waits
local rcall = redis.call
if rcall("LREM", KEYS[3], 1, ARGV[1]) == 0 then return 0 end
rcall("ZADD", KEYS[2], ARGV[2], ARGV[1])
if ARGV[3] ~= "" then rcall("HSET", KEYS[1], "finishedOn", ARGV[3]) end
if ARGV[4] ~= "" then rcall("HSET", KEYS[1], "processedOn", ARGV[4]) end
if ARGV[5] ~= "" then rcall("HSET", KEYS[1], "failedReason", ARGV[5]) end
return 1`,
  // KEYS: job, failed, events, meta, logs, dependencies, processed, failed children, unsuccessful children. ARGV: id.
  // -1 no such job, -3 not failed, -6 part of a flow or deduplicated, 1 removed.
  bullmqRemove: `-- Atelier: remove a failed BullMQ 5 job that is not part of a flow
local rcall = redis.call
if rcall("EXISTS", KEYS[1]) == 0 then return -1 end
if not rcall("ZSCORE", KEYS[2], ARGV[1]) then return -3 end
local f = rcall("HMGET", KEYS[1], "parentKey", "parent", "deid")
if f[1] or f[2] or f[3] then return -6 end
if rcall("EXISTS", KEYS[6], KEYS[7], KEYS[8], KEYS[9]) > 0 then return -6 end
rcall("ZREM", KEYS[2], ARGV[1])
rcall("DEL", KEYS[1], KEYS[5])
local maxEvents = tonumber(rcall("HGET", KEYS[4], "opts.maxLenEvents") or "10000") or 10000
rcall("XADD", KEYS[3], "MAXLEN", "~", maxEvents, "*", "event", "removed", "jobId", ARGV[1], "prev", "failed")
return 1`,
  // KEYS: retry or dead zset, queue list, queues set. ARGV: the entry as stored, the entry to enqueue, queue name.
  // -3 not there any more, 1 enqueued.
  sidekiqRetry: `-- Atelier: retry a Sidekiq retry/dead entry (Sidekiq's SortedEntry#retry)
if redis.call("ZREM", KEYS[1], ARGV[1]) == 0 then return -3 end
redis.call("LPUSH", KEYS[2], ARGV[2])
redis.call("SADD", KEYS[3], ARGV[3])
return 1`,
  // KEYS: retry or dead zset, queue list. ARGV: the entry as it was, its score, the entry enqueued.
  // 0 already picked up, 1 back where it was.
  sidekiqUnretry: `-- Atelier: undo a Sidekiq retry while the job still waits
if redis.call("LREM", KEYS[2], 1, ARGV[3]) == 0 then return 0 end
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[1])
return 1`
} as const;

export type QueueScript = keyof typeof QUEUE_SCRIPTS;

export function scriptSha(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** SHA-1 → script, for the allowlist. */
export const SCRIPT_SHAS: ReadonlyMap<string, QueueScript> = new Map(
  (Object.keys(QUEUE_SCRIPTS) as QueueScript[]).map((k) => [scriptSha(QUEUE_SCRIPTS[k]), k])
);
