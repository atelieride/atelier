import type { TerminalInfo } from '@shared/protocol';
import type { Platform } from '@shared/platform';
import { folderName, type AttentionKind, type DockEntry } from './dock-menu';
import { trayAggregate, trayModel, type TrayAggregate, type TrayModel } from './tray-model';

// The session icons: on macOS one menu bar item per session that needs you, on
// Windows one notification-area icon. The host stands for Electron's Tray (tray-electron.ts); with none (tests,
// ATELIER_TEST_TRAY_LOG) nothing is shown and each change of what would be is logged instead.

/**
 * What an icon shows: on macOS Atelier's Λ in the state's colour (a coloured dot would read as the mic or camera
 * indicator), on Windows the mark with a dot unless nobody needs you.
 */
export type IconSpec = { tinted: AttentionKind } | { mark: AttentionKind | 'none' };
export type MenuSpec = ({ label: string; click?: () => void; enabled?: boolean } | { type: 'separator' })[];

export interface TrayHandle { setImage(icon: IconSpec): void; setToolTip(text: string): void; setTitle(text: string): void; destroy(): void }
export interface TrayHost {
  create(icon: IconSpec, events: { click: () => void; rightClick: () => void }): TrayHandle;
  popUp(tray: TrayHandle, menu: MenuSpec): void;
}

export interface TrayActions {
  reveal(id: string, projectRoot: string): void;
  openProject(projectRoot: string): void;
  /** Windows' "Open Atelier": the last window in front, or a new one. */
  openApp(): void;
  newWindow(): void;
  quit(): void;
  /** Sets the setting off (the hub then calls setEnabled(false)). */
  turnOff(): void;
}

/**
 * Whether the app stays open once its last window closes: always on macOS (the Dock keeps it); on Windows only
 * with the notification-area icon on, which then is the way back.
 */
export const keepsRunning = (platform: Platform, trayIcons: boolean): boolean => platform !== 'win32' || trayIcons;

/** Windows, the icon turned off with no window open: nothing would be left to reach the app, so it quits. */
export const quitsWhenTurnedOff = (platform: Platform, windows: number): boolean => platform === 'win32' && windows === 0;

/** The last window closed: quit, stay saying so (Windows, the first time), or just stay. */
export function afterAllClosed(platform: Platform, trayIcons: boolean, noticeShown: boolean): 'quit' | 'notice' | 'stay' {
  if (!keepsRunning(platform, trayIcons)) return 'quit';
  return platform === 'win32' && !noticeShown ? 'notice' : 'stay';
}

/** Windows, a quit called off with no window open: a window comes back, unless the icon is there to reach the app. */
export const reopensAfterCancelledQuit = (platform: Platform, trayIcons: boolean, windows: number): boolean =>
  platform === 'win32' && windows === 0 && !trayIcons;

const GLYPH: Record<AttentionKind, string> = { waiting: '●', error: '!', done: '✓' };
const SECTION: Record<AttentionKind, string> = { waiting: 'Waiting for you', error: 'Stopped', done: 'Finished' };

interface Item { handle: TrayHandle | null; kind: AttentionKind | 'none'; tooltip: string; title: string }

export class SessionTray {
  private enabled = true;
  private last: TerminalInfo[] = [];
  private mac: TrayModel = { icons: [], overflow: null };
  private win: TrayAggregate = trayAggregate([]);
  private icons = new Map<string, Item>();
  private more: Item | null = null;
  private aggregate: Item | null = null;
  private logged: string | null = null;

  constructor(private readonly o: { platform: Platform; host: TrayHost | null; actions: TrayActions; log?: (line: unknown) => void; onError?: (e: unknown) => void }) {}

  private get windows(): boolean { return this.o.platform === 'win32'; }

  update(list: TerminalInfo[]): void {
    this.last = list;
    if (this.enabled) this.apply();
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) { this.apply(); return; }
    for (const item of [...this.icons.values(), this.more, this.aggregate]) item?.handle?.destroy();
    this.icons.clear();
    this.more = null;
    this.aggregate = null;
    this.write(this.windows ? null : { icons: [], more: null });
  }

  /** A click on a session's icon (macOS), on "+N" (`'+'`) or on Windows' icon (`'atelier'`). */
  click(id: string): void {
    if (this.windows || id === '+') { this.popUp(id); return; }
    const icon = this.mac.icons.find((i) => i.id === id);
    if (icon) this.o.actions.reveal(icon.id, icon.projectRoot);
  }

  menuLabels(id: string): string[] {
    return this.menuOf(id).map((i) => ('type' in i ? '---' : i.label));
  }

  choose(id: string, label: string): void {
    const item = this.menuOf(id).find((i) => !('type' in i) && i.label === label);
    if (item && !('type' in item) && item.enabled !== false) item.click?.();
  }

  /** A tray that fails is logged: the notifications and badge that run after it must not stop. */
  private apply(): void {
    try { if (this.windows) this.applyWindows(); else this.applyMac(); } catch (e) { this.o.onError?.(e); }
  }

  private applyMac(): void {
    const m = trayModel(this.last);
    this.mac = m;
    const wanted = new Set(m.icons.map((i) => i.id));
    for (const [id, item] of this.icons) if (!wanted.has(id)) { item.handle?.destroy(); this.icons.delete(id); }
    for (const icon of m.icons) {
      const have = this.icons.get(icon.id);
      if (have) { this.refresh(have, icon.kind, icon.tooltip, ''); continue; }
      this.icons.set(icon.id, this.make({ tinted: icon.kind }, icon.kind, icon.tooltip, '', () => this.click(icon.id), () => this.popUp(icon.id)));
    }
    const o = m.overflow;
    if (!o && this.more) { this.more.handle?.destroy(); this.more = null; }
    if (o) {
      const tooltip = `${o.count} more sessions need you`;
      if (this.more) this.refresh(this.more, o.kind, tooltip, `+${o.count}`);
      else this.more = this.make({ tinted: o.kind }, o.kind, tooltip, `+${o.count}`, () => this.popUp('+'), () => this.popUp('+'));
    }
    this.write({ icons: m.icons.map(({ id, kind, tooltip }) => ({ id, kind, tooltip })), more: o ? { count: o.count, kind: o.kind } : null });
  }

  private applyWindows(): void {
    const a = trayAggregate(this.last);
    this.win = a;
    if (this.aggregate) this.refresh(this.aggregate, a.kind, a.tooltip, '');
    else this.aggregate = this.make({ mark: a.kind }, a.kind, a.tooltip, '', () => this.popUp('atelier'), () => this.popUp('atelier'));
    this.write({ kind: a.kind, tooltip: a.tooltip, entries: a.entries.map((e) => e.id), more: a.more });
  }

  /**
   * Windows' icon has no GUID: a GUID binds to the executable's path, which every MSIX update changes, and
   * Windows then refuses the icon without a word.
   */
  private make(icon: IconSpec, kind: Item['kind'], tooltip: string, title: string, click: () => void, rightClick: () => void): Item {
    const item: Item = { handle: null, kind, tooltip, title };
    const host = this.o.host;
    if (!host) return item;
    item.handle = host.create(icon, { click, rightClick });
    item.handle.setToolTip(tooltip);
    if (title) item.handle.setTitle(title);
    return item;
  }

  /** Only what changed: an icon is never recreated, macOS would move it. */
  private refresh(item: Item, kind: Item['kind'], tooltip: string, title: string): void {
    if (item.kind !== kind) { item.kind = kind; item.handle?.setImage(this.windows ? { mark: kind } : { tinted: kind as AttentionKind }); }
    if (item.tooltip !== tooltip) { item.tooltip = tooltip; item.handle?.setToolTip(tooltip); }
    if (item.title !== title) { item.title = title; item.handle?.setTitle(title); }
  }

  private popUp(id: string): void {
    const item = this.windows ? this.aggregate : id === '+' ? this.more : this.icons.get(id);
    if (item?.handle) this.o.host?.popUp(item.handle, this.menuOf(id));
  }

  private menuOf(id: string): MenuSpec {
    const a = this.o.actions;
    if (this.windows) {
      return [
        ...this.sessions(this.win.entries, true),
        ...(this.win.more ? [{ label: `+${this.win.more} more`, enabled: false }] : []),
        ...(this.win.entries.length ? [{ type: 'separator' as const }] : []),
        { label: 'Open Atelier', click: () => a.openApp() },
        { label: 'New Window', click: () => a.newWindow() },
        { type: 'separator' as const },
        { label: 'Quit Atelier', click: () => a.quit() }
      ];
    }
    if (id === '+') return this.sessions(this.mac.overflow?.entries ?? [], false);
    const icon = this.mac.icons.find((i) => i.id === id);
    if (!icon) return [];
    return [
      { label: 'Open Session', click: () => a.reveal(icon.id, icon.projectRoot) },
      { label: `Open “${folderName(icon.projectRoot)}”`, click: () => a.openProject(icon.projectRoot) },
      { type: 'separator' },
      // After the menu has returned: turning off destroys the very icon this menu hangs from.
      { label: 'Turn Off Menu Bar Icons', click: () => { setTimeout(() => a.turnOff(), 0); } }
    ];
  }

  /** Sessions grouped by kind: under a section title (Windows) or between separators (macOS, as the Dock menu). */
  private sessions(entries: DockEntry[], titled: boolean): MenuSpec {
    return entries.flatMap((e, i, all) => {
      const starts = i === 0 || all[i - 1]!.kind !== e.kind;
      const head: MenuSpec = !starts ? [] : titled ? [{ label: SECTION[e.kind], enabled: false }] : i > 0 ? [{ type: 'separator' }] : [];
      return [...head, { label: `${GLYPH[e.kind]} ${e.label}`, click: () => this.o.actions.reveal(e.id, e.projectRoot) }];
    });
  }

  private write(line: unknown): void {
    if (!this.o.log) return;
    const key = JSON.stringify(line);
    if (key === this.logged) return;
    this.logged = key;
    this.o.log(line);
  }
}
