// Tab pop-out windows: what a tab needs besides its key to be shown in another window. payloadOf reads
// it from the store a tab leaves; applyPayload turns it into the state of the store it lands in. Pure.
import type { PopoutPayload } from '@shared/popout';
import type { ScmScope } from '@shared/scm';
import type { AppState, DockerTabRef, DockerView, OpenFile, RevFile } from './store';
import type { TabKey } from './tabs-model';
import { isBelow } from '@shared/paths';
import { dbRefOfKey } from './databases/tabs';
import { parseDockerKey } from './docker/tabs';
import { parseRedisKey } from './redis/tabs';

/** The part of the store a payload is read from and applied to (table tabs: none when the store has none). */
export type PayloadState = Pick<AppState, 'project' | 'openFiles' | 'review' | 'historyTab' | 'backgroundTab' | 'dockerTabs' | 'redisTabs' | 'revFiles' | 'scmRepo' | 'terminals' | 'askOpen'>
  & Partial<Pick<AppState, 'dbTabs'>>;

/**
 * What the tab shows (nonces stay behind): undefined for Services and a tab that isn't open. A terminal always says
 * whether its Ask goes with it (main falls back to the payload it opened with): only for its live, bound session — an
 * ended session's panel has nothing to bind to over there and stays.
 */
export function payloadOf(st: PayloadState, key: TabKey): PopoutPayload | undefined {
  if (key.startsWith('t:')) {
    const id = key.slice(2);
    const b = st.askOpen[id];
    const live = st.terminals.find((x) => x.id === id)?.session?.sessionId;
    return { kind: 'terminal', ask: !!b && live === b.sessionId };
  }
  if (key.startsWith('f:')) {
    const f = st.openFiles.find((x) => x.path === key.slice(2));
    return f ? { kind: 'file', rel: f.rel, mode: f.mode } : undefined;
  }
  if (key.startsWith('rev:')) {
    const r = st.revFiles.find((x) => x.key === key);
    return r ? { kind: 'rev', root: r.root, oid: r.oid, rel: r.rel } : undefined;
  }
  if (key.startsWith('db:')) {
    const r = st.dbTabs?.find((x) => x.key === key);
    return r ? { kind: 'db', connId: r.connId, schema: r.schema, name: r.name, view: r.view, ...(r.kind !== 'overview' ? { rel: r.kind } : {}) } : undefined;
  }
  if (key.startsWith('dk:')) {
    const r = st.dockerTabs.find((x) => x.key === key);
    return r ? { kind: 'docker', target: r.target, view: r.view } : undefined;
  }
  if (key.startsWith('rd:')) {
    const view = parseRedisKey(key);
    return view && st.redisTabs.includes(view) ? { kind: 'redis', view } : undefined;
  }
  switch (key) {
    case 'review': return st.review ? { kind: 'review', scope: st.review.scope, ...(st.review.againstMain !== undefined ? { againstMain: st.review.againstMain } : {}) } : undefined;
    case 'history': return st.historyTab ? { kind: 'history', repo: st.historyTab.repo, scope: st.historyTab.scope } : undefined;
    case 'background': return st.backgroundTab ? { kind: 'background', terminalId: st.backgroundTab.terminalId, itemId: st.backgroundTab.itemId } : undefined;
    default: return undefined;
  }
}

const nonce = () => Date.now() + Math.random();

/** A file's name in the project (its path when outside it): what a tab without payload shows. */
function relOf(st: PayloadState, path: string): string {
  const p = st.project;
  if (p && isBelow(p.root, path)) return path.slice(p.root.length + 1);
  if (p && isBelow(p.realRoot, path)) return path.slice(p.realRoot.length + 1);
  return path;
}

/**
 * The state that shows `key` with this payload (a payload of another kind counts as none). Only the tab's own state:
 * where it goes in the strip and whether it is active are the caller's.
 */
export function applyPayload(st: PayloadState, key: TabKey, payload: PopoutPayload | undefined): Partial<AppState> {
  const kind = (k: PopoutPayload['kind']) => (payload?.kind === k ? payload : undefined);
  if (key.startsWith('f:')) {
    const path = key.slice(2);
    const p = kind('file') as Extract<PopoutPayload, { kind: 'file' }> | undefined;
    const have = st.openFiles.find((f) => f.path === path);
    const entry: OpenFile = { path, rel: p?.rel ?? have?.rel ?? relOf(st, path), line: null, nonce: nonce(), mode: p?.mode ?? have?.mode ?? 'margin' };
    return { openFiles: have ? st.openFiles.map((f) => (f.path === path ? entry : f)) : [...st.openFiles, entry] };
  }
  if (key.startsWith('rev:')) {
    const p = kind('rev') as Extract<PopoutPayload, { kind: 'rev' }> | undefined;
    if (!p || st.revFiles.some((f) => f.key === key)) return {};
    const rev: RevFile = { key: key as RevFile['key'], root: p.root, oid: p.oid, rel: p.rel };
    return { revFiles: [...st.revFiles, rev] };
  }
  if (key.startsWith('db:')) {
    // The key names the table (the payload's names are not read); the payload says it is shown, its view and its kind.
    // An open asked elsewhere without a view: an open tab keeps its own.
    const p = kind('db') as Extract<PopoutPayload, { kind: 'db' }> | undefined;
    const ref = p ? dbRefOfKey(key, null, p.view) : null;
    if (!p || !ref) return {};
    const tab = ref.kind === 'overview' ? ref : { ...ref, kind: p.rel ?? ref.kind };
    const tabs = st.dbTabs ?? [];
    return { dbTabs: tabs.some((r) => r.key === key) ? tabs.map((r) => (r.key === key ? { ...r, view: p.open?.view === false ? r.view : tab.view } : r)) : [...tabs, tab] };
  }
  if (key.startsWith('dk:')) {
    // The key names the target; the payload carries its view — without one, an open tab keeps its own.
    const target = parseDockerKey(key);
    if (!target) return {};
    const p = kind('docker') as Extract<PopoutPayload, { kind: 'docker' }> | undefined;
    const open = st.dockerTabs.find((r) => r.key === key);
    const tab: DockerTabRef = { key, target, view: (p?.view as DockerView | undefined) ?? open?.view ?? 'logs', nonce: nonce() };
    return { dockerTabs: st.dockerTabs.some((r) => r.key === key) ? st.dockerTabs.map((r) => (r.key === key ? tab : r)) : [...st.dockerTabs, tab] };
  }
  if (key.startsWith('rd:')) {
    // The key names the view.
    const view = parseRedisKey(key);
    if (!view) return {};
    return { redisTabs: st.redisTabs.includes(view) ? st.redisTabs : [...st.redisTabs, view] };
  }
  switch (key) {
    case 'services': return { servicesOpen: true };
    case 'review': {
      const p = kind('review') as Extract<PopoutPayload, { kind: 'review' }> | undefined;
      return { review: { scope: p?.scope ?? 'all', nonce: nonce(), ...(p?.againstMain !== undefined ? { againstMain: p.againstMain } : {}) } };
    }
    case 'history': {
      const p = kind('history') as Extract<PopoutPayload, { kind: 'history' }> | undefined;
      return p ? { historyTab: { repo: p.repo, scope: p.scope as ScmScope, nonce: nonce() }, scmRepo: p.repo } : {};
    }
    case 'background': {
      const p = kind('background') as Extract<PopoutPayload, { kind: 'background' }> | undefined;
      return p ? { backgroundTab: { terminalId: p.terminalId, itemId: p.itemId, nonce: nonce() } } : {};
    }
    default: return {};
  }
}
