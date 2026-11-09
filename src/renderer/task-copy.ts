// "Copy Task" in the palette: the task as Markdown — title with its id, the fields it has, its
// link, then the description as written. Task text is untrusted: cleaned the same way as the prompt (task-prompt.ts).
// Pure.

import type { TaskDetail } from '@shared/tasks';
import { cleanLine, cleanText } from '@shared/clean-text';

const pad = (n: number) => String(n).padStart(2, '0');
/** A due date as the day it falls on, here (YYYY-MM-DD): clear in any language, unlike "Tomorrow". */
const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

type Copied = Pick<TaskDetail, 'displayId' | 'title' | 'status' | 'url' | 'body'> & Partial<Pick<TaskDetail, 'priority' | 'listName' | 'due'>>;

export function taskMarkdown(task: Copied): string {
  const fields: [string, string | undefined][] = [
    ['Status', task.status.name], ['Priority', task.priority], ['List', task.listName],
    ['Due', task.due !== undefined ? day(task.due) : undefined], ['Link', task.url]
  ];
  const lines = fields.map(([k, v]) => [k, cleanLine(v ?? '').trim()] as const).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  const body = cleanText(task.body).replace(/^\s*\n/, '').trimEnd();
  const id = cleanLine(task.displayId);
  return `# ${id ? `${id} · ` : ''}${cleanLine(task.title)}\n\n${lines.join('\n')}\n\n${body.trim() ? body : '_No description._'}\n`;
}
