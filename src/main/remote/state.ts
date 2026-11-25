// What a paired phone sees of this computer: its projects (by opaque ids, never paths), the terminals in them with
// everything their sidebar row shows, the sessions offered to resume, and the Claude accounts' limits. Pure: the
// remote hub feeds it the terminals, the open windows, the recent projects, the settings and what the other hubs know
// (ports, pull requests), and sends the result whenever it changes.
import { createHash } from 'node:crypto';
import { effectiveState, workCounts, type BackgroundWork } from '@shared/background';
import { accountOf, accountsFor, type ClaudeAccounts } from '@shared/claude-accounts';
import type { PortInfo } from '@shared/ports';
import type { PrEntry } from '@shared/pr';
import { projectColorOf, type ProjectColors } from '@shared/project-color';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { UsageEntry, UsageWindow } from '@shared/session';
import { isLimitPaused, modeBadge, waitKind } from '@shared/session-view';
import { selfPacedLoop } from '@shared/loop';
import { isShell } from '@shared/shells';
import { isBelow, samePath } from '@shared/paths';
import type { RemoteAccount, RemoteFeatures, RemoteProject, RemoteResumable, RemoteSession } from './messages';
import { WaitBook, detailOf, permissionOf, sectionOf } from './rows';

/** b64url(SHA-256(root)), its first 16 characters: stable for a project, and nothing of its path. */
export const projectIdOf = (root: string): string => createHash('sha256').update(root, 'utf8').digest('base64url').slice(0, 16);

const lastSegment = (p: string): string => p.split('/').filter(Boolean).at(-1) ?? p;
const nameOf = lastSegment;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const HEX = /^#[0-9A-Fa-f]{6}$/;
/** A color atelierd didn't give as #RRGGBB (never seen): the first session color. */
const colorOf = (c: string) => (HEX.test(c) ? c : '#B794F6');

/**
 * The state a session's badge shows: background work counts as running, a session paused at its usage limit is idle.
 * A plain terminal is running while a command is in front of its shell.
 */
function shownState(t: TerminalInfo): RemoteSession['state'] {
  if (!t.session) return isShell(t.foreground) ? 'idle' : 'running';
  if (isLimitPaused(t.session)) return 'idle';
  return effectiveState(t) ?? 'idle';
}

/** The program in front of a plain terminal, as its sidebar row names it: no path, no login dash, Claude's binary as claude. */
function commandOf(t: TerminalInfo): string | null {
  const fg = typeof t.foreground === 'string' ? t.foreground : '';
  const name = fg.replace(/^-/, '').split('/').at(-1) || fg;
  if (/^\d+(\.\d+)+$/.test(name)) return 'claude';
  return name ? clip(name, 64) : null;
}

export interface StateInput {
  terminals: readonly TerminalInfo[];
  /** The roots of the open project windows, in order. */
  open: readonly string[];
  recent: readonly string[];
  colors: { projectTint: boolean; projectColors: ProjectColors };
  now?: number;
  /** Terminals launched as Claude sessions whose Claude hasn't started yet. */
  starting?: ReadonlySet<string>;
  resumables?: readonly Resumable[];
  /** Settings' Claude accounts and the default account's dir (a session's account is found by its config dir). */
  accounts?: ClaudeAccounts;
  defaultDir?: string;
  /** A terminal's listening ports as its row shows them (none with Show listening ports off). */
  ports?(id: string): readonly PortInfo[] | undefined;
  /** The pull request of a session's branch. */
  pr?(id: string): PrEntry | undefined;
  /** A path with its links resolved (a folder that is the project root under another name). */
  realOf?(p: string): string;
  /** The keys of the waits rows can answer, kept across states (a wait's key lasts the whole wait). */
  waits?: WaitBook;
  /** The terminal profile's label as its row's chip shows it: null for the default one. */
  profileOf?(t: TerminalInfo): string | null;
  /** The working trees a project's windows show, each with the repository it is a linked worktree of (none without a window). */
  trees?(root: string): readonly WorkingTreeLink[];
  /** Settings' Workspaces in every project and Activities inside workspaces (both off when not given). */
  features?: RemoteFeatures;
}

/** A working tree (real path) and the repository it is a linked worktree of, null for a main checkout. */
export interface WorkingTreeLink { root: string; worktreeOf: string | null }

export interface RemoteState {
  projects: RemoteProject[];
  sessions: RemoteSession[];
  resumables: RemoteResumable[];
  features: RemoteFeatures;
  /** Project id → root: what a phone's `create` resolves against (only listed projects). */
  roots: Map<string, string>;
}

/** The folder a terminal runs in when it isn't the project root: its name (a worktree's is its folder's). */
function folderOf(t: TerminalInfo, realOf: (p: string) => string): string | null {
  const cwd = (t.session?.cwd ?? t.cwd).replace(/\/+$/, '');
  const root = t.projectRoot.replace(/\/+$/, '');
  if (!cwd || samePath(cwd, root) || samePath(realOf(cwd), realOf(root))) return null;
  return clip(lastSegment(cwd), 64);
}

/** The linked worktree a folder (real path) lies in, the deepest working tree holding it: its folder's name. */
function worktreeOf(cwd: string, trees: readonly WorkingTreeLink[]): string | null {
  const tree = trees
    .filter((r) => samePath(r.root, cwd) || isBelow(r.root, cwd))
    .sort((a, b) => b.root.length - a.root.length)[0];
  return tree?.worktreeOf ? clip(lastSegment(tree.root), 64) : null;
}

const KIND_KEY = { agent: 'agents', shell: 'shells', monitor: 'monitors', other: 'tasks' } as const;

/** The work chip's counts per kind, as the desktop row shows them; idle when none counts (past its cap, a watcher). */
function workOf(w: BackgroundWork | undefined): RemoteSession['work'] | null {
  if (!w || w.items.length === 0) return null;
  const counts = Object.fromEntries(workCounts(w).map(([kind, n]) => [KIND_KEY[kind], n]));
  return { ...counts, ...(w.items.some((i) => i.counted) ? {} : { idle: true as const }) };
}

/**
 * How many wake-ups are set, and the time the row's chip shows: the soonest that has one, none while a self-paced
 * loop's wake-up has fired (it is happening now, sooner than any time; it has no time until it sets the next).
 */
function wakeOf(w: BackgroundWork | undefined): { scheduled?: number; wakeAt?: number } {
  const crons = w?.crons ?? [];
  if (crons.length === 0) return {};
  const fired = crons.some((c) => c.next === null && selfPacedLoop(c.label, c.recurring));
  const timed = crons.flatMap((c) => (c.next === null ? [] : [c.next]));
  return { scheduled: crons.length, ...(!fired && timed.length > 0 ? { wakeAt: Math.min(...timed) } : {}) };
}

/** A profile's label without the folder that tells two shells of one name apart ("bash (/opt/homebrew/bin)"): no paths. */
function profileName(label: string): string {
  return label.replace(/\s*\([^)]*[/\\][^)]*\)\s*$/, '');
}

const PR_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;
const CHECKS = { passing: 'pass', failing: 'fail', pending: 'pending' } as const;

function prOf(e: PrEntry | undefined): RemoteSession['pr'] | null {
  if (!e || e.status !== 'ok') return null;
  const { pr } = e;
  const state = pr.state === 'OPEN' && pr.isDraft ? 'draft' : PR_STATE[pr.state];
  const checks = pr.ci.state === 'none' ? undefined : CHECKS[pr.ci.state];
  return { number: pr.number, title: clip(pr.title, 120), state, ...(checks ? { checks } : {}) };
}

/** An account's id for a config dir, when it is a configured account other than the default. */
function accountIdOf(configDir: string | undefined, accounts: ClaudeAccounts | undefined, defaultDir: string | undefined): string | null {
  if (!accounts || defaultDir === undefined) return null;
  const acc = accountOf(configDir, accountsFor(accounts, defaultDir), defaultDir);
  return acc && acc.id !== accounts.list[0]?.id ? acc.id : null;
}

export function remoteState(i: StateInput): RemoteState {
  const now = i.now ?? Date.now();
  const realOf = i.realOf ?? ((p: string) => p);
  const waits = i.waits ?? new WaitBook();
  const byAge = [...i.terminals].sort((a, b) => a.createdAt - b.createdAt);
  const order: string[] = [];
  const add = (root: string) => { if (!order.includes(root)) order.push(root); };
  i.open.forEach(add);
  byAge.forEach((t) => add(t.projectRoot));
  i.recent.forEach(add);
  const open = new Set(i.open);
  const roots = new Map(order.map((root) => [projectIdOf(root), root]));
  const listed = new Set(order);
  const projects = order.map((root) => ({ id: projectIdOf(root), name: nameOf(root), color: projectColorOf(i.colors, root), open: open.has(root) }));
  const sessions = byAge.map((t): RemoteSession => {
    const s = t.session;
    const starting = !s && !!i.starting?.has(t.id);
    // What it waits for, by the shared definition (a usage-limit pause is no wait).
    const wait = isLimitPaused(s) ? null : waitKind(s);
    const detail = detailOf(t, { starting, now });
    const permission = permissionOf(s);
    const key = waits.keyOf(t);
    const mode = modeBadge(s?.permissionMode);
    const account = s || starting ? accountIdOf(t.configDir, i.accounts, i.defaultDir) : null;
    const plainFolder = folderOf(t, realOf);
    // A folder inside a linked worktree is named as the worktree, as the desktop row does. Working trees are real
    // paths; the folder may be spelled through a link.
    const worktree = plainFolder ? worktreeOf(realOf((s?.cwd ?? t.cwd).replace(/\/+$/, '')), i.trees?.(t.projectRoot) ?? []) : null;
    const folder = worktree ?? plainFolder;
    const work = s ? workOf(t.work) : null;
    const wake = s ? wakeOf(t.work) : {};
    const label = i.profileOf?.(t);
    const profile = label ? profileName(label) : null;
    const command = !s && !starting ? commandOf(t) : null;
    const ports = i.ports?.(t.id)?.map((p) => ({ port: p.port, ...(p.name ? { name: clip(p.name, 64) } : {}) }));
    const pr = s ? prOf(i.pr?.(t.id)) : null;
    const cost = s?.cost;
    return {
      id: t.id, project: projectIdOf(t.projectRoot), title: t.title, claude: s !== null || starting, state: shownState(t),
      ...(wait === 'permission' || wait === 'question' ? { waitingFor: wait } : {}),
      createdAt: t.createdAt,
      section: sectionOf(t),
      color: colorOf(t.color),
      ...(starting ? { starting: true as const } : {}),
      ...(s?.unread ? { unread: true as const } : {}),
      ...(detail ? { detail } : {}),
      ...(permission ? { permission } : {}),
      ...(key ? { wait: key } : {}),
      ...(typeof s?.lastMessageAt === 'number' ? { lastMessageAt: s.lastMessageAt } : {}),
      ...(s?.model ? { model: clip(s.model, 40) } : {}),
      ...(typeof s?.contextPct === 'number' ? { contextPct: Math.max(0, Math.min(100, Math.round(s.contextPct))) } : {}),
      ...(mode ? { mode } : {}),
      // With the work known, the subagents its chip counts (one kept only for a server it started isn't); from an
      // atelierd without it, the session's own count, as the desktop's chip falls back to.
      ...(t.work ? (work?.agents ? { agents: work.agents } : {}) : s?.subagents ? { agents: s.subagents } : {}),
      ...(work ? { work } : {}),
      ...wake,
      ...(profile ? { profile: clip(profile, 40) } : {}),
      ...(account ? { account } : {}),
      ...(folder ? { folder } : {}),
      ...(worktree ? { worktree: true as const } : {}),
      ...(command ? { command } : {}),
      ...(ports?.length ? { ports } : {}),
      ...(pr ? { pr } : {}),
      ...(cost ? { cost: { usd: cost.usd, added: cost.linesAdded, removed: cost.linesRemoved } } : {})
    };
  });
  const resumables = [...(i.resumables ?? [])]
    .filter((r) => listed.has(r.projectRoot))
    .sort((a, b) => b.endedAt - a.endedAt)
    .map((r): RemoteResumable => {
      const account = accountIdOf(r.configDir, i.accounts, i.defaultDir);
      return {
        id: r.id, project: projectIdOf(r.projectRoot), title: r.title, color: colorOf(r.color), endedAt: r.endedAt,
        ...(typeof r.lastMessageAt === 'number' ? { lastMessageAt: r.lastMessageAt } : {}),
        ...(account ? { account } : {})
      };
    });
  const features = { workspacesEverywhere: i.features?.workspacesEverywhere ?? false, activities: i.features?.activities ?? false };
  return { projects, sessions, resumables, features, roots };
}

export interface UsageInput {
  usage: readonly UsageEntry[];
  accounts: ClaudeAccounts;
  defaultDir: string;
  now: number;
}

/**
 * The Claude accounts a phone shows limits for: the default one, then every one configured, with their 5-hour and
 * 7-day windows when the status line reported them and their reset is still ahead (in ms). Names and colors only.
 */
export function remoteUsage(i: UsageInput): RemoteAccount[] {
  const nowSec = i.now / 1000;
  const live = (w: UsageWindow | null | undefined) => (w && w.resetsAt > nowSec ? { pct: Math.max(0, Math.min(100, Math.round(w.pct))), resetsAt: Math.round(w.resetsAt * 1000) } : null);
  const list = accountsFor(i.accounts, i.defaultDir).list;
  return list.map((acc, n) => {
    const dir = n === 0 ? i.defaultDir : acc.dir;
    // atelierd keys usage by the transcript's dir; an older one sent the default account's with none.
    const entry = i.usage.find((e) => e.configDir !== null && samePath(e.configDir, dir)) ?? (n === 0 ? i.usage.find((e) => e.configDir === null) : undefined);
    const fiveHour = live(entry?.usage.fiveHour);
    const sevenDay = live(entry?.usage.sevenDay);
    return {
      id: acc.id, name: acc.name, color: acc.color, default: n === 0,
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      ...(entry && (fiveHour || sevenDay) ? { updatedAt: entry.usage.updatedAt } : {})
    };
  });
}
