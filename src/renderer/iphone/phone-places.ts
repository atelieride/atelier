// A paired phone's changes to this project's workspaces and activities, applied by its main window as its own menus
// and drags would: New Workspace (turning workspaces on first, as the switch does), New Activity (turning activities
// on first, as View › Activities Inside Workspaces does: one setting for every project), a rename, a row dragged onto
// a place. Quietly, like a session the phone starts in a place: nothing comes to the front, no name opens for editing,
// no toast. Main sends a change once the window is ready (as for its first session list); each answer carries the
// sidebar's arrangement right after it, so the phone's next layout shows the change.
import type { RemoteLayout, RemotePlaceOp, RemotePlaceRequest, RemotePlaceResult } from '@shared/remote';
import { useApp } from '../store';
import { resumablesFor } from '../selectors';
import { t } from '../i18n/en';
import {
  MAX_ACTIVITIES, MAX_NAME, MAX_WORKSPACES, activitiesOf, create as wsCreate, createWsActivity, memberOf, newWorkspaceId, workspacesOf,
  type WorkspacesState
} from '../workspaces';
import { layoutOf } from './layout-sync';

/** Settings' answer reaches this window's store as main's event: waited for this long at most. */
const SETTINGS_WAIT_MS = 3000;

const notFound = (message: string): RemotePlaceResult => ({ ok: false, code: 'not-found', message });
const invalid = (message: string): RemotePlaceResult => ({ ok: false, code: 'invalid', message });
const failed = (message: string): RemotePlaceResult => ({ ok: false, code: 'failed', message });
const GONE = 'This workspace or activity is not in the project any more.';

/** New Workspace's default name: "Workspace N", N the count it makes, past the names already taken. */
export function nextWorkspaceName(ws: Pick<WorkspacesState, 'list'> | null): string {
  const wss = ws ? workspacesOf(ws) : [];
  const taken = new Set(wss.map((w) => w.name.toLowerCase()));
  let n = wss.length + 1;
  while (taken.has(`workspace ${n}`)) n++;
  return `Workspace ${n}`;
}

/** A name trimmed and cut to the sidebar's limit (UTF-16 units) without splitting a character. */
function fitName(name: string): string {
  let out = '';
  for (const ch of name.trim()) {
    if (out.length + ch.length > MAX_NAME) break;
    out += ch;
  }
  return out;
}

/** Waits until the store's settings say so (main's event after a change), for a few seconds at most. */
function settingsReach(ok: () => boolean): Promise<boolean> {
  if (ok()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(ok()); }, SETTINGS_WAIT_MS);
    const off = useApp.subscribe(() => { if (ok()) { clearTimeout(timer); off(); resolve(true); } });
  });
}

/** Activities inside workspaces, turned on as the menu's switch does; whether they are on now. */
async function activitiesOn(): Promise<boolean> {
  if (useApp.getState().settings.wsActivities) return true;
  const saved = await window.atelier.settings.set({ wsActivities: true }).catch(() => null);
  if (!saved?.wsActivities) return false;
  if (!(await settingsReach(() => useApp.getState().settings.wsActivities))) return false;
  // What the window does once the setting changes: the activities kept aside come back.
  useApp.getState().applyWsActivities();
  return true;
}

/** Applies one change in this window: how it went. */
export async function applyPlaceOp(op: RemotePlaceOp): Promise<RemotePlaceResult> {
  const s = useApp.getState();
  if (s.popout || !s.project) return failed('This window is not the project\'s.');
  switch (op.kind) {
    case 'workspace': {
      if (!s.ws?.on) s.setWorkspacesOn(true);
      const cur = useApp.getState();
      if (!cur.ws?.on) return failed('Workspaces could not be turned on.');
      if (workspacesOf(cur.ws).length >= MAX_WORKSPACES) return invalid(`This project has ${MAX_WORKSPACES} workspaces already.`);
      const id = newWorkspaceId();
      const ws = wsCreate(cur.ws, { name: op.name !== undefined ? fitName(op.name) : nextWorkspaceName(cur.ws) }, id);
      if (!ws) return invalid('A workspace can\'t have this name.');
      useApp.setState({ ws });
      return { ok: true, place: id };
    }
    case 'activity': {
      const target = s.ws?.on ? s.ws.list.find((w) => w.id === op.workspace) : undefined;
      if (!target) return notFound('This workspace is not in the project any more.');
      if (target.parent !== undefined) return invalid('An activity goes inside a workspace.');
      if (!(await activitiesOn())) return failed('Activities could not be turned on.');
      const cur = useApp.getState();
      if (!cur.ws?.on || !cur.ws.list.some((w) => w.id === op.workspace)) return notFound('This workspace is not in the project any more.');
      if (activitiesOf(cur.ws, op.workspace).length >= MAX_ACTIVITIES) return invalid(`This workspace has ${MAX_ACTIVITIES} activities already.`);
      const id = newWorkspaceId();
      // No name: New Activity's own default ("New activity").
      const ws = createWsActivity(cur.ws, op.workspace, op.name !== undefined ? fitName(op.name) : t.wsAct.defaultName, id);
      if (!ws) return failed('The activity could not be made.');
      useApp.setState({ ws });
      return { ok: true, place: id };
    }
    case 'rename': {
      if (!s.ws?.on || !s.ws.list.some((w) => w.id === op.place)) return notFound(GONE);
      const name = fitName(op.name);
      if (!name) return invalid('A workspace can\'t have this name.');
      s.renameWorkspace(op.place, name);
      return { ok: true };
    }
    case 'move': {
      if (!s.ws?.on || !s.ws.list.some((w) => w.id === op.place)) return notFound(GONE);
      if (s.terminals.some((x) => x.id === op.id)) {
        // As its row dropped on that place's head does.
        s.moveToWorkspace(`t:${op.id}`, op.place, { quiet: true });
        const now = useApp.getState().ws;
        return now && memberOf(now, op.id) === op.place ? { ok: true } : failed('It could not be moved there.');
      }
      if (resumablesFor(s.resumables, s.project.root).some((r) => r.id === op.id)) {
        // A session to resume has no tab: only its place changes (that place's Resume lists it).
        if (memberOf(s.ws, op.id) !== op.place) useApp.setState({ ws: { ...s.ws, members: { ...s.ws.members, [op.id]: op.place } } });
        return { ok: true };
      }
      return notFound('This session is not in the project any more.');
    }
  }
}

/** The sidebar's arrangement as the phones get it, now. */
function layoutNow(): RemoteLayout {
  const st = useApp.getState();
  return layoutOf({ groupByState: st.groupByState, pins: st.pins, rowOrder: st.rowOrder, ws: st.ws, activities: st.settings.wsActivities });
}

/**
 * In the project's main window with iPhone access on: once the window is ready (its settings, its saved tabs and
 * atelierd's first list, as Workspaces in every project waits for), asks main for the changes that waited for it, then
 * takes the later ones as they come; one at a time, in order.
 */
export function installPhonePlaces(): () => void {
  let chain: Promise<void> = Promise.resolve();
  let asked = false;
  let live = true;
  const run = (req: RemotePlaceRequest) => {
    chain = chain.then(async () => {
      if (!live) return;
      const result = await applyPlaceOp(req.op).catch((): RemotePlaceResult => failed('The change could not be made.'));
      await window.atelier.remote.placeDone({ id: req.id, result, layout: layoutNow() }).catch(() => {});
    });
  };
  const ready = () => {
    const s = useApp.getState();
    return s.settings.remoteAccess && s.settingsLoaded && s.tabsRestored && s.daemon.listed && !!s.project && !s.popout;
  };
  const ask = () => {
    if (asked || !ready()) return;
    asked = true;
    window.atelier.remote.placesReady().then((list) => { for (const r of list) run(r); }, () => { asked = false; });
  };
  const offEvents = window.atelier.on.remotePlaces(run);
  const offStore = useApp.subscribe(ask);
  ask();
  return () => { live = false; offEvents(); offStore(); };
}
