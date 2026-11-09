// What the palette's task sections (one per connector) and the task chip show.
// Pure: tested alone.
import { textFilter } from '@shared/fuzzy';
import { CONNECTOR_IDS, type ConnectorId, type ConnectorInfo, type ConnectorStatus, type TaskList, type TaskSummary, type TaskTone } from '@shared/tasks';
import { t } from './i18n/en';
import { checkedAgo } from './update-view';
import type { TaskLink } from './task-links';
import { oneLine } from '@shared/task-prompt';
import { resolveToken } from '@shared/theme-resolve';
import { THEME_BLOCKS } from './theme-source';

export type { TaskTone };

const aurora = (name: string) => resolveToken(THEME_BLOCKS, 'aurora', name);

/**
 * The state tokens a status color is matched against: Aurora's, read from theme.css, used only to measure (a task's
 * status color comes from the tracker, whatever the theme), never painted. Grey, very dark and very light colors are
 * `idle`.
 */
export const TONE_COLORS: Readonly<Record<Exclude<TaskTone, 'idle'>, string>> = {
  waiting: aurora('--waiting'), working: aurora('--working'), done: aurora('--done'), error: aurora('--error'), violet: aurora('--violet')
};

/** Hue (degrees), saturation and lightness (0..1) of `#rgb` / `#rrggbb`; null for anything else. */
function hsl(color: string | undefined): { h: number; s: number; l: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color?.trim() ?? '');
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

const REFS = Object.entries(TONE_COLORS).map(([tone, hex]) => ({ tone: tone as TaskTone, h: hsl(hex)!.h }));

/** The nearest state token by hue; washed-out colors (greys, near black or white) are idle. */
export function statusTone(color: string | undefined): TaskTone {
  const c = hsl(color);
  if (!c || c.s < 0.2 || c.l < 0.12 || c.l > 0.92) return 'idle';
  let best: TaskTone = 'idle';
  let bestD = Infinity;
  for (const ref of REFS) {
    const d = Math.min(Math.abs(c.h - ref.h), 360 - Math.abs(c.h - ref.h));
    if (d < bestD) { bestD = d; best = ref.tone; }
  }
  return best;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayStart = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today", "Tomorrow", "Yesterday", "Oct 16", "Jan 5, 2027"; overdue once its day has passed. */
export function dueLabel(due: number, now: number): { text: string; overdue: boolean } {
  const days = Math.round((dayStart(due) - dayStart(now)) / 86_400_000);
  const d = new Date(due);
  const text = days === 0 ? t.tasks.today : days === 1 ? t.tasks.tomorrow : days === -1 ? t.tasks.yesterday
    : `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date(now).getFullYear() ? `, ${d.getFullYear()}` : ''}`;
  return { text, overdue: days < 0 };
}

export interface TaskRow { source: ConnectorId; task: TaskSummary; tone: TaskTone }

/**
 * One connector's section of the palette: its tasks (`count` = the rows shown), or what
 * it needs instead — a Connect / Reconnect row, "Connecting…", the offline line, "Loading tasks…", its unavailable
 * reason, Notion's "Choose Notion Databases…".
 */
export type TaskSection =
  | { source: ConnectorId; kind: 'tasks'; rows: TaskRow[]; stale: boolean; since?: number; count: number }
  | { source: ConnectorId; kind: 'loading' | 'connecting' | 'offline' | 'unavailable' | 'connect' | 'reconnect' | 'choose-sources' };

/** Rows per connector in the everything search (the rest are a `task:` away). */
export const ALL_MODE_ROWS = 5;
export const TASK_MODE_ROWS = 100;

const live = (s: ConnectorStatus) => s === 'connected' || s === 'offline';

export interface TaskQuery {
  mode: 'all' | 'tasks';
  /** `clickup:` / `notion:`: that connector only. */
  source?: ConnectorId;
  text: string;
  /** What each connector's own search (tasks:search) found beyond its cached list. */
  found?: Partial<Record<ConnectorId, TaskSummary[]>>;
  /** The connectors' broadcast, newer than `lists`. */
  statuses?: Partial<Record<ConnectorId, ConnectorStatus>>;
  /**
   * The connectors' chosen sources (ConnectorInfo.sources, Jira's `projects`): an empty array is a Notion with no
   * database, or a Jira with no project, chosen yet.
   */
  sources?: Partial<Record<ConnectorId, readonly unknown[] | undefined>>;
}

/**
 * The palette's tasks, one section per connector in the connectors' order.
 * Everything search: each live (connected or offline) connector's matches while typing, at most ALL_MODE_ROWS each,
 * nothing else. `task:`: every live connector's section (its tasks, or the matches plus what its own search found;
 * "Loading tasks…" before its first list; the offline line when offline with nothing ever fetched; "Choose Notion
 * Databases…" with none chosen); a disconnected one says nothing while another is live, and when none is, each says
 * what it needs. `clickup:` / `notion:`: that connector's section alone, whatever its state.
 */
export function taskSections(lists: readonly TaskList[], q: TaskQuery): TaskSection[] {
  const listOf = (id: ConnectorId) => lists.find((l) => l.source === id);
  const statusOf = (id: ConnectorId): ConnectorStatus => q.statuses?.[id] ?? listOf(id)?.status ?? 'disconnected';
  // The connectors main has told about (all of them before it has said anything), in the connectors' order.
  const told = CONNECTOR_IDS.filter((id) => listOf(id) !== undefined || q.statuses?.[id] !== undefined);
  const known = told.length ? told : CONNECTOR_IDS;

  const section = (id: ConnectorId): TaskSection | null => {
    const status = statusOf(id);
    if (!live(status)) {
      if (q.mode === 'all') return null;
      const kind = status === 'reconnect' || status === 'connecting' || status === 'unavailable' ? status : 'connect';
      return { source: id, kind };
    }
    if (q.mode === 'all' && !q.text) return null;
    const own = q.sources?.[id];
    if (own && own.length === 0) return q.mode === 'tasks' ? { source: id, kind: 'choose-sources' } : null;
    const l = listOf(id);
    const tasks = l?.tasks ?? [];
    if (tasks.length === 0) {
      // Offline with nothing ever fetched (offline at launch): that, not "No open tasks", nor "Loading" while it retries.
      if (status === 'offline' && l?.updatedAt === undefined) return q.mode === 'tasks' ? { source: id, kind: 'offline' } : null;
      // The first fetch is running, or its first tasks:list reply hasn't come.
      if (!l || l.loading) return q.mode === 'tasks' ? { source: id, kind: 'loading' } : null;
    }
    const row = (task: TaskSummary): TaskRow => ({ source: id, task, tone: statusTone(task.status.color) });
    // Free text (textScore): titles are prose, where letters in order anywhere match almost anything.
    const fields = (r: TaskRow) => [r.task.title, r.task.displayId, r.task.listName];
    let rows = textFilter(tasks.map(row), q.text, fields, q.mode === 'all' ? ALL_MODE_ROWS : TASK_MODE_ROWS);
    const found = q.found?.[id];
    if (q.mode === 'tasks' && q.text && found?.length) {
      const have = new Set(rows.map((r) => r.task.id));
      rows = [...rows, ...found.filter((x) => !have.has(x.id)).map(row)].slice(0, TASK_MODE_ROWS);
    }
    if (q.mode === 'all' && rows.length === 0) return null;
    const stale = status === 'offline';
    return { source: id, kind: 'tasks', rows, stale, ...(stale && l?.updatedAt !== undefined ? { since: l.updatedAt } : {}), count: rows.length };
  };

  if (q.mode === 'tasks' && q.source) return [section(q.source)!];
  const liveOnes = known.filter((id) => live(statusOf(id)));
  // task: with none live: one section per connector saying what it needs (Connect ClickUp…, Connect Notion…).
  const shown = q.mode === 'tasks' && liveOnes.length === 0 ? known : liveOnes;
  return shown.flatMap((id) => section(id) ?? []);
}

/** The connectors that can be searched now (connected or offline): their "Search <App> Tasks…" commands. */
export function liveConnectors(connectors: readonly ConnectorInfo[]): ConnectorId[] {
  return connectors.filter((c) => live(c.status)).map((c) => c.id);
}

/**
 * The everything search's footer on a highlighted task: "task: all tasks", and the highlighted task's own
 * prefix ("notion: only Notion") when two or more connectors are live — with one, `task:` already is that connector.
 * Null anywhere else (not on a task, another mode): the palette keeps its usual footer (⌥↵, ↑↓ ↵).
 */
export function taskFooter(mode: string, activeSource: ConnectorId | undefined, liveIds: readonly ConnectorId[]): { only: ConnectorId | null } | null {
  if (mode !== 'all' || !activeSource || liveIds.length === 0) return null;
  return { only: liveIds.length >= 2 && liveIds.includes(activeSource) ? activeSource : null };
}

/** A section's right-aligned count: `task:` only, where several connectors share the list; never with a prefix. */
export function sectionCount(q: { mode: string; source?: ConnectorId }, s: TaskSection): number | undefined {
  return q.mode === 'tasks' && !q.source && s.kind === 'tasks' && s.count > 0 ? s.count : undefined;
}

/** Changes with a connector's status or task list (tasksVersion), never with its loading flag: then tasks:list again. */
export function tasksKey(connectors: readonly ConnectorInfo[]): string {
  return connectors.map((c) => `${c.id}:${c.status}:${c.tasksVersion}`).join('|') || '-';
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The chip's accessible name: "Task <id>. <tip>", or for a task without an ID "Task <title>. <status>" (the title is the tip's first line). */
export function taskChipLabel(link: TaskLink, tip: readonly string[]): string {
  const name = t.tasks.chipLabel(link.displayId || link.title);
  const rest = link.displayId ? tip : tip.slice(1);
  return rest.length ? `${name}. ${rest.join('. ')}` : name;
}

/** What a toast calls a task: its ID, else its title on one line cut to 60 characters. */
export function taskToastName(displayId: string, title: string): string {
  if (displayId) return displayId;
  const chars = [...oneLine(title)];
  return chars.length <= 60 ? chars.join('') : chars.slice(0, 59).join('').trimEnd() + '…';
}

/**
 * The chip's tooltip lines: live (title, status · list, the due date as the palette's tip says it, when it last
 * changed) or the saved title alone.
 */
export function taskChipTip(link: TaskLink, liveTask: TaskSummary | undefined, now: number): string[] {
  if (!liveTask) return [link.title, link.displayId ? t.tasks.noLiveStatus(link.displayId) : t.tasks.noLiveStatusNoId];
  const where = [liveTask.status.name ? sentence(liveTask.status.name) : '', liveTask.listName ?? ''].filter(Boolean).join(' · ');
  const due = liveTask.due !== undefined ? dueLabel(liveTask.due, now) : null;
  const ago = liveTask.updatedAt !== undefined ? checkedAgo(liveTask.updatedAt, now) : null;
  return [
    liveTask.title, ...(where ? [where] : []),
    ...(due ? [due.overdue ? t.tasks.overdueTip(due.text) : t.tasks.dueTip(due.text)] : []),
    ...(ago ? [t.conn.updated(ago.charAt(0).toLowerCase() + ago.slice(1))] : [])
  ];
}

/**
 * An empty section's line: "No matching tasks" with a query; else "No open tasks assigned to you" when the connector
 * lists only yours (ClickUp; Notion when every database is "Assigned to me"), "No open tasks" when one lists everyone's.
 */
export function tasksEmptyLine(info: ConnectorInfo | undefined, query: boolean): string {
  // Jira's own section says issues; a project set to Everyone lists everyone's.
  if (info?.id === 'jira') return query ? t.tasks.noMatchIssues : info.projects?.some((p) => p.everyone) ? t.tasks.noneIssuesAnyone : t.tasks.noneIssues;
  if (query) return t.tasks.noMatch;
  return info?.sources?.some((s) => !s.fields.assignee?.mine) ? t.tasks.noneAnyone : t.tasks.none;
}

/** The row a section shows while nothing is chosen: "Choose Notion Databases…", "Choose Jira Projects…". */
export function chooseSourcesLabel(id: ConnectorId, name: string): string {
  return t.tasks.chooseSources(name, t.tasks.sourceNouns[id]);
}

/** "Search ClickUp Tasks…", "Search Jira Issues…". */
export function searchInLabel(id: ConnectorId, name: string): string {
  return t.tasks.searchIn(name, t.tasks.nouns[id]);
}

/**
 * Under a connector's own section with a query (`notion: rate`, `jira: bill`): its search only reaches the sources
 * chosen in Settings. Undefined anywhere else.
 */
export function onlyChosenNote(q: { source?: ConnectorId; text: string }, section: ConnectorId): string | undefined {
  if (!q.text || q.source !== section || (section !== 'notion' && section !== 'jira')) return undefined;
  return t.tasks.onlyChosen(t.tasks.sourceNouns[section].toLowerCase());
}
