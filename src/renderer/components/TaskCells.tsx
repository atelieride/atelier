// A task's cells as the palette shows them: status dot, display id, title, list, due
// date. Shared by the palette's task rows and the head of a task's actions, and by Notion's fields editor preview,
//so the preview is exactly what the palette will show.
import { t } from '../i18n/en';
import { dueLabel, type TaskRow } from '../task-view';

export function TaskCells({ row, now }: { row: TaskRow; now: number }) {
  const due = row.task.due !== undefined ? dueLabel(row.task.due, now) : null;
  return (
    <>
      <span className={`task-dot tone-${row.tone}`} role="img" aria-label={row.task.status.name} data-tip={row.task.status.name || undefined} />
      {/* No ID (a Notion database without a unique-ID column): the dot, then the title. */}
      {row.task.displayId && <span className="task-id mono">{row.task.displayId}</span>}
      <span className="palette-label task-title">{row.task.title}</span>
      {row.task.listName && <span className="task-list">{row.task.listName}</span>}
      {due && <span className={`task-due mono ${due.overdue ? 'is-overdue' : ''}`} data-tip={due.overdue ? t.tasks.overdueTip(due.text) : t.tasks.dueTip(due.text)}>{due.text}</span>}
    </>
  );
}
