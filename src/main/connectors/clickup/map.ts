// ClickUp's task data (as mcp.ts parses it) → the source-neutral TaskSummary / TaskDetail the renderer sees
// (src/shared/tasks.ts). Everything here is untrusted text: titles become one clean line, bodies lose control characters
// and are capped at 32 KB, colors pass only as #rrggbb, and the link is ClickUp's own https://app.clickup.com page or one
// built from the id (main opens it on request; it must never point anywhere else).
import type { WatchedTask } from '@shared/automations';
import { MAX_TASK_BODY_BYTES, type TaskCounts, type TaskDetail, type TaskSummary } from '@shared/tasks';
import { cleanText } from '@shared/clean-text';
import { MAX_TITLE_CHARS, capUtf8, oneLine } from '../text';
import type { ClickUpTask, ClickUpTaskDetail } from './tools';

export { MAX_TITLE_CHARS, oneLine };
const CLICKUP_APP_HOST = 'app.clickup.com';

/** A positive ms timestamp from ClickUp's string or number; anything else → undefined. */
function timestamp(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const hexColor = (c: string | undefined): string | undefined => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : undefined);

/** The task's page in ClickUp's web app, built from its id. */
export function clickupTaskUrl(id: string): string {
  return `https://${CLICKUP_APP_HOST}/t/${encodeURIComponent(id)}`;
}

function taskUrl(raw: string | undefined, id: string): string {
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && u.hostname === CLICKUP_APP_HOST && u.port === '' && u.username === '' && u.password === '') return u.href;
    } catch { /* fall through */ }
  }
  return clickupTaskUrl(id);
}

/** A listed task as automations read it: null without the list it came from. */
export function toWatchedTask(t: ClickUpTask): WatchedTask | null {
  const scope = t.list?.id;
  if (!scope) return null;
  const s = toTaskSummary(t);
  const out: WatchedTask = {
    id: s.id, scope, displayId: s.displayId, title: s.title, url: s.url, status: s.status.name,
    assignees: (t.assignees ?? []).map((a) => a.id),
    tags: (t.tags ?? []).map((g) => oneLine(g.name, 100)).filter(Boolean)
  };
  if (s.priority) out.priority = s.priority;
  if (s.due !== undefined) out.due = s.due;
  return out;
}

export function toTaskSummary(t: ClickUpTask): TaskSummary {
  const custom = oneLine(t.custom_id, 64);
  const displayId = custom || t.id;
  const color = hexColor(t.status?.color);
  const out: TaskSummary = {
    id: t.id,
    displayId,
    title: oneLine(t.name) || displayId,
    status: color ? { name: oneLine(t.status?.status, 100), color } : { name: oneLine(t.status?.status, 100) },
    url: taskUrl(t.url, t.id)
  };
  const priority = oneLine(t.priority?.priority, 50);
  if (priority) out.priority = priority;
  const due = timestamp(t.due_date);
  if (due !== undefined) out.due = due;
  const listName = oneLine(t.list?.name, 200);
  if (listName) out.listName = listName;
  const updatedAt = timestamp(t.date_updated);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  return out;
}

export function toTaskDetail(t: ClickUpTaskDetail): TaskDetail {
  const raw = t.markdown_description || t.text_content || '';
  // Multi-line: newlines (normalized to \n) and tabs kept, every other control or invisible character removed.
  const out: TaskDetail = { ...toTaskSummary(t), body: capUtf8(cleanText(raw), MAX_TASK_BODY_BYTES) };
  if (t.parent) out.parent = t.parent;
  if (t.counts) {
    const counts: TaskCounts = {};
    for (const k of ['subtasks', 'checklists', 'attachments', 'comments'] as const) {
      const n = t.counts[k];
      if (n !== undefined) counts[k] = n;
    }
    out.counts = counts;
  }
  return out;
}
