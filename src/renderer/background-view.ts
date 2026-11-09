// What the Background popover and tab list: sections in chip order, items an agent
// launched nested under it, servers/watchers/capped items marked, crons and recent items last. Pure.
import type { TerminalInfo } from '@shared/protocol';
import type { BackgroundKind, SessionInfo } from '@shared/session';
import { loopRowId, selfPacedLoop } from '@shared/loop';
import type { InspectorEntry } from '@shared/background';
import { t } from './i18n/en';
import { clockTime, formatDuration } from './work-view';
import { cronEvery, loopBusy, loopTitle } from './cron-view';

/** Whether this chip (its session, its side — session bar or sidebar row — and its section) is the one whose popover is open. */
export function bgChipOpen(pop: { terminalId: string; side: 'below' | 'right'; section: 'all' | 'scheduled' } | null, terminalId: string, side: 'below' | 'right', section: 'all' | 'scheduled'): boolean {
  return !!pop && pop.terminalId === terminalId && pop.side === side && pop.section === section;
}

export type RowState = 'running' | 'idle' | 'watcher' | 'server' | 'ended' | 'scheduled';
export interface BgRow { id: string; kind: BackgroundKind | 'cron' | 'loop'; label: string; depth: 0 | 1; state: RowState; elapsed: string; sub: string; ports?: number[]; exit?: number | null }
export interface BgSection { key: 'agents' | 'shells' | 'monitors' | 'other' | 'scheduled' | 'recent'; title: string; rows: BgRow[] }

/** "42 s", "1 min", "2 h": at least 1 s (never "0 s", "60 s" or a negative). */
export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${Math.max(1, s)} s` : formatDuration(ms);
}

/** A server, a counted item, a watcher (flagged by main: it lasts the whole session), else a capped (idle) one. */
function stateOf(e: InspectorEntry): RowState {
  if (e.server) return 'server';
  if (e.counted) return 'running';
  return e.watcher ? 'watcher' : 'idle';
}

/** The items of a terminal whose exit code is known (from the followed outputs): id → code. */
export type Exits = ReadonlyMap<string, number>;
const NO_EXITS: Exits = new Map();

function row(e: InspectorEntry, depth: 0 | 1, now: number, exits: Exits): BgRow {
  const code = exits.get(e.id);
  // An exit is known: it no longer runs (nor counts, nor is a server or a watcher) anywhere in this view.
  if (code !== undefined && e.kind !== 'agent') {
    return { id: e.id, kind: e.kind, label: e.label, depth, state: 'ended', elapsed: formatElapsed(now - e.since), sub: t.bg.exited(code), exit: code };
  }
  const state = stateOf(e);
  const sub = e.kind === 'agent'
    ? e.waiting ? t.bg.waitingOnShell : e.lastEvent !== undefined ? t.bg.lastEvent(formatElapsed(now - e.lastEvent)) : ''
    // A shell with no description is labelled by its command: no second copy of it.
    : e.display && e.display !== e.label ? e.display : '';
  return { id: e.id, kind: e.kind, label: e.label, depth, state, elapsed: formatElapsed(now - e.since), sub, ...(e.server ? { ports: e.server.ports } : {}) };
}

const KIND_SECTION: Record<BackgroundKind, BgSection['key']> = { agent: 'agents', shell: 'shells', monitor: 'monitors', other: 'other' };

export function backgroundSections(term: Pick<TerminalInfo, 'work' | 'recent'> & { session?: SessionInfo | null }, now: number, exits: Exits = NO_EXITS): BgSection[] {
  const entries = term.work?.entries ?? [];
  const agents = new Set(entries.filter((e) => e.kind === 'agent').map((e) => e.id));
  const nested = (e: InspectorEntry) => e.kind !== 'agent' && !!e.owner && agents.has(e.owner);
  const out: BgSection[] = [];
  const push = (key: BgSection['key'], rows: BgRow[]) => { if (rows.length) out.push({ key, title: t.bg.section[key]!, rows }); };
  push('agents', entries.filter((e) => e.kind === 'agent').flatMap((a) => [row(a, 0, now, exits), ...entries.filter((e) => nested(e) && e.owner === a.id).map((e) => row(e, 1, now, exits))]));
  for (const kind of ['shell', 'monitor', 'other'] as const) push(KIND_SECTION[kind], entries.filter((e) => e.kind === kind && !nested(e)).map((e) => row(e, 0, now, exits)));
  push('scheduled', (term.work?.crons ?? []).map((c) => {
    const elapsed = c.next !== null ? clockTime(c.next) : '';
    const loop = selfPacedLoop(c.label, c.recurring);
    if (loop) {
      // A fired wake-up (main nulls its next): Claude is on it, or the turn ended without the next Stop.
      const when = c.next !== null ? t.bg.inTime(formatElapsed(c.next - now)) : loopBusy(term.session) ? t.bg.loop.checkingNow : t.bg.loop.passed;
      return { id: loopRowId(c.label), kind: 'loop' as const, label: loopTitle(loop), depth: 0 as const, state: 'scheduled' as const, elapsed, sub: `${t.bg.loop.selfPaced} · ${when}` };
    }
    return {
      id: `cron:${c.id}`, kind: 'cron' as const, label: c.label, depth: 0 as const, state: 'scheduled' as const, elapsed,
      sub: [cronEvery(c.schedule, c.recurring) ?? c.schedule, c.next !== null ? t.bg.inTime(formatElapsed(c.next - now)) : ''].filter(Boolean).join(' · ')
    };
  }));
  push('recent', (term.recent ?? []).map((r) => ({
    id: r.id, kind: r.kind, label: r.label, depth: 0 as const, state: 'ended' as const, elapsed: formatElapsed(r.endedAt - r.since),
    sub: r.exit !== null ? t.bg.exited(r.exit) : t.bg.ended, exit: r.exit
  })));
  return out;
}

/** The first row the Background tab lists for a terminal (the item it shows when none is chosen), or null. */
export function firstItemId(term: Pick<TerminalInfo, 'work' | 'recent'> | undefined): string | null {
  return term ? backgroundSections(term, 0)[0]?.rows[0]?.id ?? null : null;
}

const NONE: { has(id: string): boolean } = new Set<string>();

/**
 * "Open inspector": the first item that runs and counts (not a server, a watcher or a capped one, nor one whose exit
 * code is already known), else the first row.
 */
export function inspectorTarget(term: Pick<TerminalInfo, 'work' | 'recent'>, exited: { has(id: string): boolean } = NONE): string | null {
  const rows = backgroundSections(term, 0).flatMap((s) => s.rows);
  return rows.find((r) => r.state === 'running' && !exited.has(r.id))?.id ?? rows[0]?.id ?? null;
}

/** "3 running · 1 scheduled": every listed entry but those whose exit code is known (`exited`). */
export function backgroundSummary(term: Pick<TerminalInfo, 'work' | 'recent'>, exited: { has(id: string): boolean } = NONE): string | null {
  const running = (term.work?.entries ?? []).filter((e) => !exited.has(e.id)).length;
  const scheduled = term.work?.crons.length ?? 0;
  return running || scheduled ? t.bg.summary(running, scheduled) : null;
}

/** The items of a terminal whose followed output already carries an exit code (from the store's feeds): id → code. */
export function exitedIds(feeds: Readonly<Record<string, { exit: number | null }>>, terminalId: string): Map<string, number> {
  const prefix = `${terminalId}:`;
  const out = new Map<string, number>();
  for (const [k, f] of Object.entries(feeds)) if (f.exit !== null && k.startsWith(prefix)) out.set(k.slice(prefix.length), f.exit);
  return out;
}

/** A string form of the exits, stable across renders: a feed that changes nothing here does not re-render a view. */
export const exitsKey = (m: Exits): string => [...m].map(([id, code]) => `${id}=${code}`).join('\n');
export function parseExits(key: string): Exits {
  return new Map(key ? key.split('\n').map((x) => { const i = x.lastIndexOf('='); return [x.slice(0, i), Number(x.slice(i + 1))] as const; }) : []);
}

/** The command a shell or monitor row copies (redacted by main), listed or recent; undefined when it has none. */
export function commandOf(term: Pick<TerminalInfo, 'work' | 'recent'>, id: string): string | undefined {
  return term.work?.entries.find((x) => x.id === id)?.display ?? term.recent?.find((x) => x.id === id)?.display;
}

/**
 * Whether an item has anything for the inspector to follow: an agent (its transcript) or a shell/monitor with a command
 * (its output file). Monitors and tasks without a command (MCP or internal watches) never get a file: Claude Code watches
 * them itself and delivers their events to Claude as notifications. Scheduled rows and placeholders have no file either.
 */
export function isFollowable(item: { id: string; kind: BackgroundKind; display?: string }): boolean {
  if (item.id.startsWith('cron:') || item.id.startsWith('subagent-')) return false;
  return item.kind === 'agent' || !!item.display;
}
