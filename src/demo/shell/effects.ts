import type { MenuCommand } from '@shared/api';

// What a menu item or an accelerator of the demo does: the menu definition's
// commands go to the renderer exactly as the native menu sends them; what needs the Mac says so; the platform's roles
// become the demo's own ways out, full screen, or the browser's editing.

export type EditOp = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll';

export type MenuEffect =
  | { kind: 'command'; command: MenuCommand }
  | { kind: 'not-in-demo'; what: string }
  | { kind: 'exit' }
  | { kind: 'fullscreen' }
  | { kind: 'edit'; op: EditOp }
  | { kind: 'licenses' }
  | { kind: 'link'; href: string }
  | { kind: 'checklist' };

/** A label as the hint names it: "Open Folder…" → "Open Folder". */
export const plainLabel = (label: string): string => label.replace(/…$/, '').trim();
