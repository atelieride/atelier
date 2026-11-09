import path from 'node:path';
import { isAbsPath, toNative } from '@shared/paths';

// Atelier in Windows' shell, the twins of macOS's Dock: an overlay badge on the taskbar button
// while sessions wait, the Jump List (sessions waiting, recent projects, New Window), and the files and folders File
// Explorer hands over on the command line. Pure: index.ts applies them.

/** The overlay badge: a 16 px amber dot (Aurora's waiting #FBBF24) on transparency, BGRA as Windows wants it. */
export function badgeBitmap(size = 16): Buffer {
  const b = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // A soft edge: one pixel of anti-aliasing.
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      if (a === 0) continue;
      const i = (y * size + x) * 4;
      // Premultiplied, as Skia reads a bitmap: no bright fringe at the edge.
      b[i] = Math.round(0x24 * a); b[i + 1] = Math.round(0xBF * a); b[i + 2] = Math.round(0xFB * a); b[i + 3] = Math.round(a * 255);
    }
  }
  return b;
}

interface Task { type: 'task'; title: string; description?: string; program: string; args: string; iconPath: string; iconIndex: number }
export type JumpCategory = { type: 'custom'; name: string; items: Task[] } | { type: 'tasks'; items: Task[] };

/**
 * What the Jump List shows, set only when it changes: atelierd lists its terminals up to every 100 ms while sessions
 * work, and the recents stat their folders on the main thread (an offline drive can block), so they are read only when
 * asked (a project opened, a window focused).
 */
export class JumpListFeed {
  private waiting: { id: string; label: string }[] = [];
  private recents: string[] | null = null;
  private key = '';

  constructor(private readonly o: { exe: string; newWindow: string; recents: () => string[]; set: (list: JumpCategory[]) => void }) {}

  setWaiting(entries: readonly { id: string; label: string }[]): void {
    this.waiting = entries.map((e) => ({ id: e.id, label: e.label }));
    this.apply();
  }

  /** The recents changed, or their folders may have come or gone: read again. */
  refreshRecents(): void {
    this.recents = null;
    this.apply();
  }

  private apply(): void {
    this.recents ??= this.o.recents();
    const list = jumpList({ exe: this.o.exe, waiting: this.waiting, recents: this.recents, newWindow: this.o.newWindow });
    const key = JSON.stringify(list);
    if (key === this.key) return;
    this.key = key;
    this.o.set(list);
  }
}

/**
 * Why a folder can't be a project on Windows, or null when it can: a network share or a WSL folder (\\server\share,
 * \\wsl.localhost\…) and device paths (\\?\, \\.\) have no drive letter, and every path Atelier hands its pages has
 * one. A mapped drive is the way in.
 */
export function networkRoot(p: string): { message: string; detail: string } | null {
  if (!/^[\\/]{2}/.test(p)) return null;
  return {
    message: 'Atelier can’t open a network folder as a project',
    detail: `${toNative(p, 'win32')} has no drive letter. Map it to one in File Explorer (This PC › Map network drive; for a WSL folder, its \\\\wsl.localhost\\<distro> share), then open the folder from that drive.`
  };
}

/** The Jump List: sessions waiting first (as the Dock menu lists them), then the recent projects, then New Window. */
export function jumpList(o: { exe: string; waiting: { id: string; label: string }[]; recents: string[]; newWindow: string }): JumpCategory[] {
  const task = (title: string, args: string, description?: string): Task => ({ type: 'task', title, ...(description && { description }), program: o.exe, args, iconPath: o.exe, iconIndex: 0 });
  const out: JumpCategory[] = [];
  if (o.waiting.length) out.push({ type: 'custom', name: 'Waiting for you', items: o.waiting.map((w) => task(w.label, `--reveal=${w.id}`)) });
  if (o.recents.length) {
    // The canonical path on the command line: a native one can end in `\` (C:\), which escapes the closing quote.
    out.push({ type: 'custom', name: 'Recent projects', items: o.recents.map((r) => { const n = toNative(r, 'win32'); return task(path.win32.basename(n) || n, `--project="${r}"`, n); }) });
  }
  out.push({ type: 'tasks', items: [task(o.newWindow, '--new-window')] });
  return out;
}

const TERMINAL_ID = /^[0-9a-f-]{1,64}$/i;

/** The terminal a Jump List entry asks to show (`--reveal=<id>`). */
export function revealArg(argv: readonly string[]): string | null {
  const id = argv.find((a) => a.startsWith('--reveal='))?.slice('--reveal='.length);
  return id && TERMINAL_ID.test(id) ? id : null;
}

/**
 * The paths on the command line (Open with Atelier, a drop on its shortcut): absolute, no switches. A dev run's own
 * app folder (electron.exe <app> …) is not one of them.
 */
export function argvPaths(argv: readonly string[], packaged: boolean): string[] {
  return argv.slice(packaged ? 1 : 2).filter((a) => !a.startsWith('-') && isAbsPath(a, 'win32'));
}
