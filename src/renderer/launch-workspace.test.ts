import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { newSessionIn, newTerminalIn } from './launch';
import type { WorkspacesState } from './workspaces';

// A workspace with a folder: New Session and New Terminal start there; "in Folder…" still picks.

const g = globalThis as { window?: unknown };
let had: unknown;
const calls: { kind: string; arg: Record<string, unknown> }[] = [];
let refuse: string | null = null;
let down = false;
const info = (id: string): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 1, session: null });
beforeAll(() => {
  had = g.window;
  const reply = (kind: string) => async (arg: Record<string, unknown>) => {
    calls.push({ kind, arg });
    if (down) throw new Error("Error invoking remote method 'term:create': Error: atelierd not connected");
    if (refuse && arg.cwd === refuse) throw new Error("Error invoking remote method 'term:create': Error: folder outside the project");
    return info(`${kind}${calls.length}`);
  };
  g.window = { addEventListener: () => {}, atelier: { terminals: { create: reply('t'), createSession: reply('s') } } };
});
afterAll(() => { g.window = had; });

const ws = (folder: string | null, on = true): WorkspacesState => ({
  on, active: 'A', list: [{ id: 'A', name: 'DB', color: 3, folder, order: [], active: null, layout: null }], members: {}
});

beforeEach(() => {
  calls.length = 0;
  refuse = null;
  down = false;
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], tabOrder: [], toast: null, ws: null });
});

test('a workspace with a folder: New Terminal and New Session start in it', async () => {
  useApp.setState({ ws: ws('/p/wt') });
  await newTerminalIn();
  await newSessionIn('x');
  expect(calls.map((c) => c.arg.cwd)).toEqual(['/p/wt', '/p/wt']);
});

test('a folder asked for ("in Folder…") wins over the workspace\'s', async () => {
  useApp.setState({ ws: ws('/p/wt') });
  await newTerminalIn('/p/other');
  expect(calls[0]!.arg.cwd).toBe('/p/other');
});

test('no folder, or workspaces off: the project root as today', async () => {
  useApp.setState({ ws: ws(null) });
  await newTerminalIn();
  useApp.setState({ ws: ws('/p/wt', false) });
  await newSessionIn('x');
  expect(calls.map((c) => 'cwd' in c.arg)).toEqual([false, false]);
});

test('the workspace\'s folder refused (gone, moved): started at the project root, with a notice', async () => {
  useApp.setState({ ws: ws('/p/gone') });
  refuse = '/p/gone';
  const r = await newSessionIn('x');
  expect(r).not.toBeNull();
  expect(calls.map((c) => c.arg.cwd)).toEqual(['/p/gone', undefined]);
  expect(useApp.getState().toast?.text).toMatch(/folder/i);
});

test('any other failure (atelierd not connected) is not the folder: no second start at the root, no folder notice', async () => {
  useApp.setState({ ws: ws('/p/wt') });
  down = true;
  await expect(newTerminalIn()).rejects.toThrow(/not connected/);
  expect(calls).toHaveLength(1);
  expect(useApp.getState().toast).toBeNull();
});
