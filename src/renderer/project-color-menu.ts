// Project Color: the eight colors a project's window can wear, as menu items — under the project chip's right-click
// menu, and on their own for the Project Color… command (menu bar, palette).
import { projectColorFor, PROJECT_COLOR_COUNT, withProjectColor } from '@shared/project-color';
import { useApp } from './store';
import { t } from './i18n/en';
import { wsColorVar } from './workspace-view';
import type { MenuItem } from './menu-model';

const st = () => useApp.getState();

/** The color this window's project has (worn or not: the tint may be off); null without a project. */
export function currentProjectColor(): number | null {
  const s = st();
  return s.project ? projectColorFor(s.settings.projectColors, s.project.root) : null;
}

/** The color saved for a project the welcome window lists; null while the tint is off or it has none yet. */
export function savedProjectColor(s: { projectTint: boolean; projectColors: Record<string, number> }, root: string): number | null {
  return s.projectTint ? s.projectColors[root] ?? null : null;
}

/**
 * The eight colors of `root` (this window's project when not given), its own checked while the tint is on; choosing
 * one saves it and turns the tint on.
 */
export function projectColorItems(root: string | undefined = st().project?.root): MenuItem[] {
  const s = st();
  if (!root) return [];
  const mine = !s.settings.projectTint ? null : root === s.project?.root ? currentProjectColor() : savedProjectColor(s.settings, root);
  return Array.from({ length: PROJECT_COLOR_COUNT }, (_, n) => ({
    id: `project-color:${n + 1}`, label: t.ws.colors[n]!, swatch: wsColorVar(n + 1), checked: mine === n + 1, radio: true as const,
    run: () => void window.atelier.settings.set({ projectTint: true, projectColors: withProjectColor(st().settings.projectColors, root, n + 1) })
  }));
}

/** The project chip's right-click menu. */
export function projectChipMenu(): MenuItem[] {
  const colors = projectColorItems();
  if (colors.length === 0) return [];
  const mine = currentProjectColor();
  return [
    { id: 'project-color', label: t.projectColor.menu, ...(mine ? { swatch: wsColorVar(mine) } : {}), run: () => {}, submenu: colors },
    'sep',
    { id: 'project-reveal', label: t.openInFinder, icon: 'folderOpen', run: () => void window.atelier.revealProject() }
  ];
}

/** A recent project's right-click menu in the welcome window. */
export function recentProjectMenu(root: string): MenuItem[] {
  const mine = savedProjectColor(st().settings, root);
  return [{ id: 'project-color', label: t.projectColor.menu, ...(mine ? { swatch: wsColorVar(mine) } : { icon: 'appearance' as const }), run: () => {}, submenu: projectColorItems(root) }];
}

/** Project Color…: the colors under the project chip. */
export function openProjectColorMenu(): void {
  const items = projectColorItems();
  const chip = document.querySelector('.project-chip');
  if (items.length === 0 || !chip) return;
  const r = chip.getBoundingClientRect();
  st().openMenu({ x: r.left, y: r.bottom + 6, anchor: { left: r.left, right: r.right, bottom: r.bottom } }, items);
}
