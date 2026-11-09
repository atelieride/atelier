import type { MouseEvent } from 'react';
import { useApp } from '../store';
import { CONNECTOR_ICONS } from '../connectors-view';
import { openLinkedTask, taskMenuItems } from '../menus';
import { taskChipLabel, taskChipTip } from '../task-view';
import { Icon } from './Icon';
import { afterLeavingApp } from '../pane-focus';

/**
 * The task a session was started from: the connector's glyph and the task's display id (a task without one: its title,
 * cut short, in the UI font), in the session bar (and its pane header in split view). Click opens the task in
 * the browser — main opens the task's own page, also with the connector disconnected; the tooltip has its live title,
 * status, list, due date and last change when the connector lists it; the context menu opens, copies or unlinks it.
 */
export function TaskChip({ id }: { id: string }) {
  const link = useApp((s) => s.taskLinks[id]);
  const live = useApp((s) => (link ? s.taskLists.find((l) => l.source === link.source)?.tasks.find((x) => x.id === link.taskId) : undefined));
  if (!link) return null;
  const tip = taskChipTip(link, live, Date.now());
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useApp.getState().openMenu(e, taskMenuItems(id));
  };
  return (
    <button type="button" className={`tchip ${link.displayId ? 'mono' : 'tchip-titled'}`} aria-label={taskChipLabel(link, tip)} data-tip={tip.join('\n')}
      onClick={(e) => { e.stopPropagation(); openLinkedTask(link); afterLeavingApp(); }} onContextMenu={menu} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="tchip-icon"><Icon name={CONNECTOR_ICONS[link.source]} size={12} stroke={1.8} /></span>
      {link.displayId || <span className="tchip-title">{link.title}</span>}
    </button>
  );
}
