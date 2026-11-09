// The compiled world: what src/demo/compile produces in Node at build time and
// the runtime (bridge, engine) plays back. Plain JSON: the reducers, builders and parsers that made it never ship.
// Times are milliseconds (seconds where a field says so) around `t0`; the runtime moves them to its own clock once
// (engine/time.ts), so a demo opened days after the build still says "just now".
import type { Attribution } from '@shared/attribution';
import type { DfSummary, DockerContainer, DockerDetail, DockerEventEntry, DockerSnapshot } from '@shared/docker';
import type { TerminalInfo } from '@shared/protocol';
import type { ClientRow, RedisSnapshot, RedisStatus, SlowEntry } from '@shared/redis';
import type { JobInfo, JobState, QueueInfo } from '@shared/redis-queues';
import type { UsageEntry } from '@shared/session';
import type { Commit } from './world/project';
import type { ScenarioName } from './world/scenarios';
import type { ClaudeScreen } from './engine/claude-screen';
import type { DemoBeats } from './engine/beats-types';
import type { ScmCommit } from '@shared/scm';

/** Source Control's history as compile/scm.ts makes it: git's answers become lookups and a line diff at runtime. */
export interface CompiledScm {
  /** Newest first, as `git log --topo-order` lists them. */
  commits: ScmCommit[];
  /** Full messages (subject, body) by commit id. */
  messages: Record<string, string>;
  /** Each commit's tree: rel → blob id. */
  trees: Record<string, Record<string, string>>;
  /** Blob id → content. */
  blobs: Record<string, string>;
}

/** A queue's jobs in one state as main's adapters answer them: the list row (summarized) and the detail with its command. */
export interface CompiledJob { summary: JobInfo; detail?: { job: JobInfo; command: string | null } }

/** The keyspace's queues as compile/redis-queues.ts reads them with main's adapters. */
export interface CompiledQueues {
  infos: QueueInfo[];
  /** By queue id, then state, in the order the adapters list them. */
  jobs: Record<string, Partial<Record<JobState, CompiledJob[]>>>;
}

/**
 * The Redis world as compile/redis.ts makes it: the instance, its INFO, clients and slow log. The keyspace itself is
 * seeded at runtime from world/redis.ts (engine/redis.ts): its values embed times (stream ids, BullMQ timestamps).
 */
export interface CompiledRedis {
  snapshot: RedisSnapshot;
  status: RedisStatus;
  clients: ClientRow[];
  slowlog: { threshold: number | null; entries: SlowEntry[] };
  /** null when compiled synchronously (compileWorld, for tests that don't need them); compileDemoWorld fills them. */
  queues: CompiledQueues | null;
}

/** A container's log line at a time (ms), as the engine's log stream has it. */
export interface DemoLogLine { at: number; err: boolean; text: string }

/**
 * The Docker world as compile/docker.ts makes it with the app's parsers: the overview's containers, their lines so far,
 * disk usage, recent events, and the Docker beat — the worker crashing a little after the demo opens (engine/docker.ts).
 */
export interface CompiledDocker {
  snapshot: DockerSnapshot;
  details: Record<string, DockerDetail>;
  /** Each container's lines before t0, oldest first (the live part is generated). */
  logs: Record<string, DemoLogLine[]>;
  df: DfSummary;
  /** Newest first. */
  events: DockerEventEntry[];
  crash: {
    /** The worker once exited (restarts used up), parsed like the rest; its times are set when it happens. */
    container: DockerContainer;
    detail: DockerDetail;
    /** Its last lines, ms after the crash starts. */
    lines: { afterMs: number; err: boolean; text: string }[];
    /** Docker's events while it crash-loops, ms after the crash starts. */
    events: { afterMs: number; entry: Omit<DockerEventEntry, 'at'> }[];
    /** The note's line: the error itself, redacted, as main's notify picks it. */
    note: string;
  };
}

export interface DemoSession {
  /** The scenario it plays (also its name in the sidebar). */
  scenario: ScenarioName;
  /** As main sends it: atelierd's session through the reducers, the background work attached. */
  terminal: TerminalInfo;
  /** What its Claude screen draws now. */
  screen: ClaudeScreen;
}

export interface DemoWorld {
  /** The build's clock: every time below is relative to it. */
  t0: number;
  project: { root: string; name: string };
  /** File contents at HEAD (rel → text): what diffs compare with. */
  head: Record<string, string>;
  /** The working tree at startup: HEAD plus the sessions' edits. */
  files: Record<string, string>;
  /** `main`'s history, oldest first, with stable fake ids (Source Control, later). */
  commits: (Commit & { oid: string })[];
  /** The last commit's id: HEAD. */
  headOid: string;
  /** Source Control's history: the commits as git lists them, their trees and blobs. */
  scm: CompiledScm;
  /** In the sidebar's creation order. */
  sessions: DemoSession[];
  /** What the sessions do next (Claude's beats), a new session's template, the background feeds (compile/beats.ts). */
  beats: DemoBeats;
  /** The startup layout: the overview shot's tabs, the waiting session in front. */
  tabs: { order: string[]; active: string };
  usage: UsageEntry[];
  /** Who edited which file, as atelierd's Edit hooks say it. */
  attributions: Attribution[];
  docker: CompiledDocker;
  redis: CompiledRedis;
}
