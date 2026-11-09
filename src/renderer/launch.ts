import type { TerminalInfo } from '@shared/protocol';
import type { ProfileKey } from '@shared/profiles';
import { t } from './i18n/en';
import { useApp } from './store';

// Starting sessions and terminals, at the project root or in one of its folders (the main process refuses any other).

const dims = () => { const { size } = useApp.getState(); return { cols: size.cols || 120, rows: size.rows || 36 }; };

/**
 * A folder the main process refused (outside the project, gone, inside .git) becomes a notice, not an error (null).
 * `show`: how a session appears (launched, or launched to the side); a terminal is opened.
 */
async function start(create: () => Promise<TerminalInfo>, inFolder: boolean, show?: (info: TerminalInfo) => void, atRoot?: () => Promise<TerminalInfo>): Promise<TerminalInfo | null> {
  // Asked for (⌘N, ⌘T, Ask in a New Session…): Sessions comes forward now. Gone to another space
  // before it is there, it lands in Sessions without pulling them back (opened, launched).
  const st = useApp.getState();
  if (!st.popout && st.space !== 'sessions') st.switchSpace('sessions');
  try {
    // Shown from the reply: atelierd's list follows ~100 ms later and only confirms it. A session is shown as one
    // (starting) until Claude's SessionStart arrives.
    const info = await create();
    if (show) show(info);
    else useApp.getState().opened(info);
    return info;
  } catch (e) {
    // The workspace's own folder refused by main (gone, moved): it starts at the project root anyway, with a notice. Any
    // other failure (atelierd not connected, an account) is not about the folder: as for any start.
    if (atRoot && /folder outside the project/.test(e instanceof Error ? e.message : String(e))) {
      useApp.getState().showToast(t.ws.folderGone, undefined, 'info');
      return start(atRoot, false, show);
    }
    if (!inFolder) throw e;
    useApp.getState().showToast(t.folderNotInProject);
    return null;
  }
}

/** The active workspace's folder, when workspaces are on and it has one. */
function workspaceFolder(): string | undefined {
  const s = useApp.getState();
  if (!s.ws?.on || s.popout) return undefined;
  const active = s.ws.active;
  return s.ws.list.find((w) => w.id === active)?.folder ?? undefined;
}

/**
 * profile: one asked for (menu, palette); without it main uses the default from Settings. Its terminal (null: the folder was refused).
 * No folder asked for: the active workspace's, if it has one.
 */
export function newTerminalIn(cwd?: string, profile?: ProfileKey): Promise<TerminalInfo | null> {
  const folder = cwd ? undefined : workspaceFolder();
  const make = (dir?: string) => () => window.atelier.terminals.create({ ...dims(), ...(dir ? { cwd: dir } : {}), ...(profile ? { profile } : {}) });
  return start(make(cwd ?? folder), !!cwd, undefined, folder ? make() : undefined);
}

/** Palette and File menu: captures the user's shell environment again (can take seconds), with a toast for the outcome. */
export async function reloadShellEnv(): Promise<void> {
  const st = useApp.getState();
  if (!st.daemon.profilesAvailable) { st.showToast(t.set.profilesNeedRestart); return; }
  st.showToast(t.shellEnvReloading, undefined, 'info');
  const r = await window.atelier.reloadShellEnv().catch((e: Error) => ({ error: e.message }));
  if ('ok' in r) useApp.getState().showToast(t.shellEnvReloaded, undefined, 'info');
  else useApp.getState().showToast(t.shellEnvFailed(r.error));
}

/**
 * A Claude session with the same command as New Session; the name is optional. Its terminal (null: the folder was
 * refused); `side`: shown to the side of the focused pane instead of in it (a task's ⌥Enter); `account`: the Claude
 * account picked in New Session (absent: the one set for new sessions); `noFlags`: without launch flags (⌥↵).
 */
export function newSessionIn(name: string, cwd?: string, opts: { side?: boolean; account?: string; noFlags?: boolean } = {}): Promise<TerminalInfo | null> {
  const show = (info: TerminalInfo) => { const st = useApp.getState(); if (opts.side) st.launchedToSide(info); else st.launched(info); };
  const folder = cwd ? undefined : workspaceFolder();
  const make = (dir?: string) => () => window.atelier.terminals.createSession({ ...dims(), name: name.trim() || undefined, ...(dir ? { cwd: dir } : {}), ...(opts.account ? { account: opts.account } : {}), ...(opts.noFlags ? { noFlags: true as const } : {}) });
  return start(make(cwd ?? folder), !!cwd, show, folder ? make() : undefined);
}
