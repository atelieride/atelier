// A paired phone's changes to this project's workspaces and activities, applied by its main window as its own menus
// and drags would: New Workspace (only where workspaces are on), New Activity (only while activities are on: one
// setting for every project), a rename, a row dragged onto a place, Close Workspace… or Close Activity… answered (the
// phone's user was asked there; unsaved files that close would take are refused, never asked about here). A phone never
// turns a feature on: only this computer does. Quietly, like a session the phone starts in a place: nothing comes to
// the front, no name opens for editing, no toast. Main sends a change once the window is ready (as for its first
// session list); each answer carries the sidebar's arrangement right after it, so the phone's next layout shows the
// change.
import { ACTIVITIES_OFF, WORKSPACES_OFF, type RemoteLayout, type RemotePlaceOp, type RemotePlaceRequest, type RemotePlaceResult } from '@shared/remote';
import { unsavedOnPlaceClose, useApp } from '../store';
import { resumablesFor } from '../selectors';
import { t } from '../i18n/en';
import {
  MAX_ACTIVITIES, MAX_NAME, MAX_WORKSPACES, activitiesOf, create as wsCreate, createWsActivity, memberOf, newWorkspaceId, workspacesOf,
  type WorkspacesState
} from '../workspaces';
import { layoutOf } from './layout-sync';

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

/** Applies one change in this window: how it went. */
export async function applyPlaceOp(op: RemotePlaceOp): Promise<RemotePlaceResult> {
  const s = useApp.getState();
  if (s.popout || !s.project) return failed('This window is not the project\'s.');
  switch (op.kind) {
    case 'workspace': {
      // On in every project, though this window hasn't applied it yet: it just opened, or it shows another space, where
      // the setting waits for Sessions. Sessions comes forward with them on, as turning workspaces on does.
      if (!s.ws?.on && s.settings.workspacesEverywhere) {
        if (s.space !== 'sessions') s.switchSpace('sessions');
        useApp.getState().applyWorkspacesEverywhere();
      }
      const cur = useApp.getState();
      if (!cur.ws?.on) return invalid(WORKSPACES_OFF);
      if (workspacesOf(cur.ws).length >= MAX_WORKSPACES) return invalid(`This project has ${MAX_WORKSPACES} workspaces already.`);
      const id = newWorkspaceId();
      const ws = wsCreate(cur.ws, { name: op.name !== undefined ? fitName(op.name) : nextWorkspaceName(cur.ws) }, id);
      if (!ws) return invalid('A workspace can\'t have this name.');
      useApp.setState({ ws });
      return { ok: true, place: id };
    }
    case 'activity': {
      const cur = s.ws?.on ? s.ws : null;
      const target = cur?.list.find((w) => w.id === op.workspace);
      if (!cur || !target) return notFound('This workspace is not in the project any more.');
      if (target.parent !== undefined) return invalid('An activity goes inside a workspace.');
      if (!s.settings.wsActivities) return invalid(ACTIVITIES_OFF);
      if (activitiesOf(cur, op.workspace).length >= MAX_ACTIVITIES) return invalid(`This workspace has ${MAX_ACTIVITIES} activities already.`);
      const id = newWorkspaceId();
      // No name: New Activity's own default ("New activity").
      const ws = createWsActivity(cur, op.workspace, op.name !== undefined ? fitName(op.name) : t.wsAct.defaultName, id);
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
    case 'close': {
      const place = s.ws?.on ? s.ws.list.find((w) => w.id === op.place) : undefined;
      if (!place || !s.ws?.on) return notFound(GONE);
      if (place.parent === undefined && workspacesOf(s.ws).length <= 1) return invalid('A project\'s last workspace stays.');
      // Here Close… warns that such sessions stop for good; the phone can't, so it may only move them.
      if (op.how === 'stop' && s.daemon.closeStopAvailable === false) return invalid('This computer can\'t keep stopped sessions under Resume: move them instead, or stop them on this computer.');
      // Closing asks about unsaved files in this window: no one may be here to answer, so the phone is told instead.
      if (unsavedOnPlaceClose(op.place, op.how).length) return invalid('It has unsaved files: save or close them on this computer first.');
      await (place.parent === undefined ? s.closeWorkspace(op.place, op.how) : s.closeWsActivity(op.place, op.how));
      return useApp.getState().ws?.list.some((w) => w.id === op.place) ? failed('It could not be closed.') : { ok: true };
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
