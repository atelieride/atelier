// Sessions started from a task: terminal id → the task, per project root, saved in localStorage like
// the pins (pins.ts). The link outlives the connection: with the connector disconnected the chip still opens the task.
import { CONNECTOR_IDS, type ConnectorId } from '@shared/tasks';
import { oneLine } from '@shared/task-prompt';

export interface TaskLink {
  source: ConnectorId;
  /** The source's own id (what connectors:openTask and tasks:get take). */
  taskId: string;
  displayId: string;
  title: string;
  /** The task's page, as the source gave it (copied by Copy Task Link). */
  url: string;
}

/** Terminal id → its task. */
export type TaskLinks = Record<string, TaskLink>;
export type TaskLinksByProject = Record<string, TaskLinks>;

/** Projects come and go: the least recently changed ones are forgotten past this many. */
export const MAX_LINKED_PROJECTS = 50;
export const KEY = 'atelier.taskLinks';
/** The same rule as main's task id schema (ipc-schemas.ts). */
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Each source's web app: the only hosts a saved link may point to (Notion links come in three shapes). Jira has one host
 * per site: any `<label>.atlassian.net`, on its issue pages only (JIRA_HOST, JIRA_PATH).
 */
export const TASK_HOSTS: Readonly<Record<ConnectorId, readonly string[]>> = {
  clickup: ['app.clickup.com'],
  notion: ['app.notion.com', 'www.notion.so', 'notion.so'],
  jira: []
};
const JIRA_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;
const JIRA_PATH = /^\/(?:browse\/[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8}|issues\/)$/;

function isTaskUrl(source: ConnectorId, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (source === 'jira') return JIRA_HOST.test(u.hostname) && JIRA_PATH.test(u.pathname) && !u.hash;
    return TASK_HOSTS[source].includes(u.hostname);
  } catch { return false; }
}

/** The link to copy: the saved one when it is the source's own page, else ClickUp's short link / the Notion page. */
export function taskLinkUrl(link: TaskLink): string {
  // A Jira link is only ever saved valid (its site can't be rebuilt from the id).
  if (isTaskUrl(link.source, link.url) || link.source === 'jira') return link.url;
  return link.source === 'notion' ? `https://www.notion.so/${link.taskId}` : `https://${TASK_HOSTS.clickup[0]}/t/${link.taskId}`;
}

/**
 * What a chip opens when main has no link for its task (Jira disconnected: main has no site to build one from): the
 * Jira page the link saved, which parseLink only keeps when it is a site's issue page. ClickUp and Notion: never
 * (main always builds theirs from the id).
 */
export function fallbackUrl(link: TaskLink): string | null {
  return link.source === 'jira' && isTaskUrl('jira', link.url) ? link.url : null;
}

function parseLink(v: unknown): TaskLink | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const source = CONNECTOR_IDS.find((id) => id === o.source);
  if (!source || typeof o.taskId !== 'string' || !TASK_ID.test(o.taskId)) return null;
  if (typeof o.displayId !== 'string' || typeof o.title !== 'string' || typeof o.url !== 'string') return null;
  const displayId = oneLine(o.displayId);
  const title = oneLine(o.title).slice(0, 300);
  // A Notion row whose database has no unique-ID column has no display id: it then needs a title to be told apart.
  if (displayId.length > 64 || !isTaskUrl(source, o.url)) return null;
  if (!displayId && (source !== 'notion' || !title)) return null;
  return { source, taskId: o.taskId, displayId, title: title || displayId, url: o.url };
}

/** From the saved value (whatever it contains) to valid links. */
export function parseTaskLinks(raw: string | null): TaskLinksByProject {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: no links */ }
  const out: TaskLinksByProject = {};
  for (const [root, links] of Object.entries(o)) {
    if (!links || typeof links !== 'object' || Array.isArray(links)) continue;
    const valid: TaskLinks = {};
    for (const [id, v] of Object.entries(links as Record<string, unknown>)) {
      const l = parseLink(v);
      if (l && id) valid[id] = l;
    }
    if (Object.keys(valid).length) out[root] = valid;
  }
  return out;
}

/** The links of `root` replaced by `links` (none: the project is removed); the project becomes the most recent one. */
export function withProjectLinks(all: TaskLinksByProject, root: string, links: TaskLinks): TaskLinksByProject {
  const rest = Object.entries(all).filter(([r]) => r !== root);
  if (Object.keys(links).length) rest.push([root, links]);
  return Object.fromEntries(rest.slice(-MAX_LINKED_PROJECTS));
}

/**
 * Links of terminals that no longer exist are dropped (the same object when nothing goes). An empty list drops nothing:
 * it is also what arrives before atelierd has sent the first one.
 */
export function pruneTaskLinks(links: TaskLinks, alive: string[]): TaskLinks {
  if (alive.length === 0) return links;
  const ids = new Set(alive);
  const keep = Object.entries(links).filter(([id]) => ids.has(id));
  return keep.length === Object.keys(links).length ? links : Object.fromEntries(keep);
}

export function loadTaskLinks(root: string): TaskLinks {
  try { return parseTaskLinks(localStorage.getItem(KEY))[root] ?? {}; } catch { return {}; }
}

export function saveTaskLinks(root: string, links: TaskLinks): void {
  try { localStorage.setItem(KEY, JSON.stringify(withProjectLinks(parseTaskLinks(localStorage.getItem(KEY)), root, links))); } catch { /* not saved: stays for this session */ }
}
