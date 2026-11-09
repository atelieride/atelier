import type { TerminalInfo } from '@shared/protocol';
import { noteText } from '@shared/notifications';
import { waitKind } from '@shared/session-view';
import { KIND_TEXT } from './attention';
import { attentionLabel, clean, dockEntries, dockOverflow, pickAttention, short, type AttentionKind, type DockEntry } from './dock-menu';

// What the tray shows: on macOS one menu bar icon per session that needs you, on Windows
// one aggregate icon. The sessions are the Dock menu's (pickAttention). Pure: tray.ts applies it.

/** Menu bar items at most: the menu bar is shared and a notch hides what doesn't fit, without notice. */
export const TRAY_MAX = 5;

export interface TrayIcon { id: string; projectRoot: string; kind: AttentionKind; tooltip: string }
/** The "+N" item: the sessions that got no icon, coloured by the most urgent of them. */
export interface TrayOverflow { kind: AttentionKind; count: number; entries: DockEntry[] }
export interface TrayModel { icons: TrayIcon[]; overflow: TrayOverflow | null }

export interface TrayAggregate { kind: AttentionKind | 'none'; tooltip: string; entries: DockEntry[]; more: number }

/**
 * The session and its project, then what it is, as the banners say it ("Needs permission · Bash npm test"): cleaned and
 * cut like the title, since what it asks names repo files.
 */
function tooltipOf(t: TerminalInfo, kind: AttentionKind): string {
  const w = waitKind(t.session);
  const what = noteText(kind, t.session?.activity ?? null, KIND_TEXT, w === 'permission' || w === 'question' ? w : undefined);
  return `${attentionLabel(t)}\n${short(clean(what), 80)}`;
}

export function trayModel(list: TerminalInfo[], max = TRAY_MAX): TrayModel {
  const all = pickAttention(list);
  const shown = all.length > max ? all.slice(0, max - 1) : all;
  const hidden = all.slice(shown.length);
  return {
    icons: shown.map(({ term, kind }) => ({ id: term.id, projectRoot: term.projectRoot, kind, tooltip: tooltipOf(term, kind) })),
    overflow: hidden.length === 0 ? null : {
      kind: hidden[0]!.kind,
      count: hidden.length,
      entries: hidden.map(({ term, kind }) => ({ id: term.id, projectRoot: term.projectRoot, kind, label: attentionLabel(term) }))
    }
  };
}

const COUNTED: [AttentionKind, string][] = [['waiting', 'waiting for you'], ['error', 'stopped'], ['done', 'finished']];
// Windows shows at most 127 characters of a notification-area tooltip.
const TOOLTIP_MAX = 127;

/** Windows' one icon: the most urgent kind present, how many of each, and the Jump List's entries for its menu. */
export function trayAggregate(list: TerminalInfo[]): TrayAggregate {
  const all = pickAttention(list);
  if (all.length === 0) return { kind: 'none', tooltip: 'Atelier', entries: [], more: 0 };
  const counts = COUNTED.flatMap(([kind, words]) => { const n = all.filter((x) => x.kind === kind).length; return n ? [`${n} ${words}`] : []; });
  const tooltip = `Atelier — ${counts.join(', ')}`;
  return { kind: all[0]!.kind, tooltip: tooltip.length > TOOLTIP_MAX ? `${tooltip.slice(0, TOOLTIP_MAX - 1)}…` : tooltip, entries: dockEntries(list), more: dockOverflow(list) };
}
