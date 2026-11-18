/**
 * A project window's title, as the Window menu, the Dock menu and Mission Control show it: the selected session (or
 * terminal) first, so several windows tell apart at a glance, then the project. The app's name without a project.
 */
export const windowTitle = (session: string, project: string): string =>
  [session, project].filter(Boolean).join(' — ') || 'Atelier';
