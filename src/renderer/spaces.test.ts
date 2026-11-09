import { describe, expect, test } from 'vitest';
import type { TabKey } from './tabs-model';
import { emptyViews, forgetInViews, renameInViews, spaceOf, spaceOfActivity, SPACE_ACTIVITY, type SpaceViews } from './spaces';

// Spaces: every tab belongs to one space; the activity bar picks the space.

const k = (...keys: string[]) => keys as TabKey[];

describe('spaceOf', () => {
  test('terminals, files, revisions and the Sessions views belong to Sessions', () => {
    for (const key of k('t:a', 'f:/p/x.ts', 'rev:abc:src/x.ts', 'services', 'review', 'history', 'background')) expect(spaceOf(key)).toBe('sessions');
  });
  test('each view key belongs to its own space', () => {
    expect(spaceOf('dk:overview')).toBe('docker');
    expect(spaceOf('rd:live')).toBe('redis');
    expect(spaceOf('db:c0123456789ab')).toBe('databases');
    expect(spaceOf('au:all')).toBe('automations');
  });
});

describe('spaceOfActivity', () => {
  test('Sessions, Files, Services and Source Control show the Sessions space', () => {
    for (const a of ['sessions', 'files', 'services', 'scm'] as const) expect(spaceOfActivity(a)).toBe('sessions');
  });
  test('the other four show their own', () => {
    for (const a of ['docker', 'redis', 'databases', 'automations'] as const) expect(spaceOfActivity(a)).toBe(a);
  });
  test('each other space is shown by its own activity', () => {
    expect(SPACE_ACTIVITY).toEqual({ docker: 'docker', redis: 'redis', databases: 'databases', automations: 'automations' });
  });
});

describe('saved views', () => {
  const views = (): SpaceViews => ({ ...emptyViews(), sessions: { order: k('t:a', 'f:/p/x.ts', 't:b'), front: 'f:/p/x.ts', layout: { v: 2, panes: [{ tabs: ['t:a', 'f:/p/x.ts'], front: 'f:/p/x.ts' }, { tabs: ['t:b'], front: 't:b' }], fractions: [0.5, 0.5], focus: 0 } }, databases: { order: k('db:c0123456789ab'), front: 'db:c0123456789ab', layout: null } });

  test('every space starts with no tab', () => {
    const v = emptyViews();
    expect(Object.keys(v).sort()).toEqual(['automations', 'databases', 'docker', 'redis', 'sessions']);
    for (const x of Object.values(v)) expect(x).toEqual({ order: [], front: null, layout: null });
  });

  test('keys closed for good leave every order; a front that goes passes to the one used before it — a saved pane’s too', () => {
    const v = forgetInViews(views(), (x) => x === 'f:/p/x.ts' || x === 'db:c0123456789ab', (id) => (id === 'sessions' ? k('t:a', 'f:/p/x.ts') : []));
    expect(v.sessions.order).toEqual(k('t:a', 't:b'));
    // The one used before it, not its neighbour (t:b).
    expect(v.sessions.front).toBe('t:a');
    // A saved pane keeps its keys (a restore places only open ones); its front moves the same way.
    expect(v.sessions.layout).toMatchObject({ panes: [{ tabs: ['t:a', 'f:/p/x.ts'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }] });
    expect(v.databases).toEqual({ order: [], front: null, layout: null });
  });

  test('no history: a front that goes passes to its neighbour', () => {
    expect(forgetInViews(views(), (x) => x === 'f:/p/x.ts').sessions.front).toBe('t:b');
  });

  test('forgetting nothing keeps the same views', () => {
    const v = views();
    expect(forgetInViews(v, () => false)).toBe(v);
  });

  test('a renamed key changes in the order, the front and the saved panes', () => {
    const v = renameInViews(views(), (x) => (x === 'f:/p/x.ts' ? 'f:/p/y.ts' : x));
    expect(v.sessions.order).toEqual(k('t:a', 'f:/p/y.ts', 't:b'));
    expect(v.sessions.front).toBe('f:/p/y.ts');
    expect(v.sessions.layout).toMatchObject({ panes: [{ tabs: ['t:a', 'f:/p/y.ts'], front: 'f:/p/y.ts' }, { tabs: ['t:b'], front: 't:b' }] });
  });

  test('renaming nothing keeps the same views', () => {
    const v = views();
    expect(renameInViews(v, (x) => x)).toBe(v);
  });
});
