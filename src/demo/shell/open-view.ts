import type { MenuCommand } from '@shared/api';
import type { DemoView } from '../protocol';

// What opening a view does (a feature row's "Try it", and the "Things to try" items): the
// steps the shell runs, the commands as the native menu sends them. Every view shows something; opening it again (a
// second Try it, Back then Forward) never changes what is shown. Pure: the shell reads the screen and runs the steps.

/** What the shell sees: two panes or more, the sessions as main last sent them, the selected session's title. */
export interface OpenScreen {
  split: boolean;
  terminals: readonly { id: string; title: string; session?: { state: string } | null; work?: { entries: readonly unknown[]; crons: readonly unknown[] } | null }[];
  /** The selected session's title (the sidebar's selected row), null when none shows. */
  selected: string | null;
  /** A sheet over the app (a `.palette-backdrop`): New Session, or another one (⌘K, Settings…); null when none. */
  sheet: 'new-session' | 'other' | null;
}

export type OpenStep =
  | { kind: 'command'; command: MenuCommand }
  /** The renderer's own `select` (a notification click does the same): that session in front. */
  | { kind: 'select'; id: string }
  /** The renderer's own `openPaths` (Open File…, a drop): a normal tab in the focused pane, never a new split. */
  | { kind: 'open-file'; rel: string }
  /** The sheet on screen closes, as a click outside it does: the stage resumes the demo as the visitor left it. */
  | { kind: 'close-sheet' }
  /**
   * Ask open on that session (now in front): the menu's `ask-session`, sent only when its panel isn't on screen once
   * the select has been drawn (⌘I toggles: an open panel would close).
   */
  | { kind: 'ask'; id: string };

/** The editor's file: auth-refactor's edit, change bars in the margin, as the editor row's screenshot shows it. */
export const EDITOR_FILE = 'src/auth/session.ts';
/** The "Things to try" JSON item's file (the fictional project's manifest). */
export const JSON_FILE = 'package.json';

const running = (t: OpenScreen['terminals'][number]) => t.work?.entries.length ?? 0;
const scheduled = (t: OpenScreen['terminals'][number]) => t.work?.crons.length ?? 0;

/**
 * Whose background is worth showing: the selected session when it has any, else the one with the most running items
 * (billing-tests' agents, shell and test watcher), else the one with scheduled ones (docs' cron); null when nobody has
 * any. View › Background shows the selected session's, and the demo starts on sessions with none.
 */
export function backgroundOwner(terminals: OpenScreen['terminals'], selected: string | null): string | null {
  const mine = terminals.find((t) => t.title === selected);
  if (mine && running(mine) + scheduled(mine) > 0) return mine.id;
  const best = (score: (t: OpenScreen['terminals'][number]) => number) =>
    terminals.reduce<OpenScreen['terminals'][number] | null>((b, t) => (score(t) > (b ? score(b) : 0) ? t : b), null);
  return (best(running) ?? best(scheduled))?.id ?? null;
}

/**
 * Whose Ask is worth opening: a session at work — the selected one when it works, else
 * the one with the most background work (billing-tests while it runs), else any — or, nobody at work, the selected
 * session, else the first one; null without any Claude session.
 */
export function askOwner(terminals: OpenScreen['terminals'], selected: string | null): string | null {
  const sessions = terminals.filter((t) => t.session);
  const working = sessions.filter((t) => t.session!.state === 'running');
  const mine = (list: typeof sessions) => list.find((t) => t.title === selected);
  const busiest = working.reduce<(typeof sessions)[number] | null>((b, t) => (!b || running(t) > running(b) ? t : b), null);
  return (mine(working) ?? busiest ?? mine(sessions) ?? sessions[0])?.id ?? null;
}

export function openSteps(view: DemoView, s: OpenScreen): OpenStep[] {
  // A sheet left open when the visitor left (the accounts row's New Session, ⌘K) would cover the view. New Session as
  // an account keeps an open New Session sheet: the renderer switches its account, the name typed stays.
  const keep = s.sheet === null || (s.sheet === 'new-session' && view.startsWith('new-session-account:'));
  return [...(keep ? [] : [{ kind: 'close-sheet' } as const]), ...viewSteps(view, s)];
}

function viewSteps(view: DemoView, s: OpenScreen): OpenStep[] {
  // The editor row: no command opens a file, so the demo shows the explorer and opens one as Open File… does.
  if (view === 'demo:editor') return [{ kind: 'command', command: 'view-files' }, { kind: 'open-file', rel: EDITOR_FILE }];
  // The JSON tree: package.json, then Split Preview — idempotent, unlike ⇧⌘V's toggle.
  if (view === 'demo:json') return [{ kind: 'command', command: 'view-files' }, { kind: 'open-file', rel: JSON_FILE }, { kind: 'command', command: 'md-split' }];
  // Ask: the session at work in front, then its panel opened unless it shows already (never toggled shut).
  if (view === 'demo:ask') {
    const owner = askOwner(s.terminals, s.selected);
    if (!owner) return [{ kind: 'command', command: 'ask-session' }];
    const mine = s.terminals.find((t) => t.title === s.selected);
    return [...(owner !== mine?.id ? [{ kind: 'select', id: owner } as const] : []), { kind: 'ask', id: owner }];
  }
  // split-right adds a pane each time it runs, up to the maximum: it splits only from one pane.
  if (view === 'split-right') return s.split ? [] : [{ kind: 'command', command: view }];
  if (view === 'show-background') {
    const owner = backgroundOwner(s.terminals, s.selected);
    const mine = s.terminals.find((t) => t.title === s.selected);
    return [...(owner && owner !== mine?.id ? [{ kind: 'select', id: owner } as const] : []), { kind: 'command', command: view }];
  }
  return [{ kind: 'command', command: view }];
}
