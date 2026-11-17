// Workspaces in the live demo.
// Off, as in the app; when the visitor turns them on (View › Toggle Workspaces for This Project, the palette, "Things
// to try"), the fictional project's five sessions are already split into four fronts. Plain data written into the
// demo's in-memory storage before the renderer reads it; ids are the world's own (stable, built from each scenario).
import type { WorkspacesState } from '../../renderer/workspaces';
import { WS_KEY } from '../../renderer/workspaces-save';
import type { ScenarioName } from './scenarios';

/** The fronts and the sessions in each, in the sidebar's order (colors: the first four tokens). */
const FRONTS: readonly { id: string; name: string; sessions: readonly ScenarioName[] }[] = [
  { id: 'w-auth', name: 'Auth & sessions', sessions: ['auth-refactor'] },
  { id: 'w-billing', name: 'Billing', sessions: ['billing-tests'] },
  { id: 'w-db', name: 'DB migration', sessions: ['db-migration'] },
  { id: 'w-docs', name: 'Docs & copy', sessions: ['onboarding-copy', 'docs'] }
];

/** The demo's workspaces for its sessions, off, the auth front in front; saved as this version saves them (ownColors). */
export function demoWorkspaces(sessions: readonly { scenario: ScenarioName; terminal: { id: string } }[]): WorkspacesState {
  const idOf = (n: ScenarioName) => sessions.find((s) => s.scenario === n)?.terminal.id;
  const list = FRONTS.map((f, i) => {
    const order = f.sessions.map(idOf).filter((x): x is string => !!x).map((x) => `t:${x}` as const);
    return { id: f.id, name: f.name, color: i + 1, folder: null, layout: null, order, active: order[0] ?? null };
  });
  const members = Object.fromEntries(FRONTS.flatMap((f) => f.sessions.map((n) => [idOf(n), f.id] as const)).filter(([id]) => !!id)) as Record<string, string>;
  return { on: false, active: FRONTS[0]!.id, list, members, ownColors: true };
}

/** Writes them where the app reads them (`atelier.workspaces`, by project root), before the renderer starts. */
export function seedWorkspaces(storage: Storage, world: { project: { root: string }; sessions: readonly { scenario: ScenarioName; terminal: { id: string } }[] }): void {
  storage.setItem(WS_KEY, JSON.stringify({ [world.project.root]: demoWorkspaces(world.sessions) }));
}
