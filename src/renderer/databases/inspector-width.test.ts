import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_TAB } from './store';

// The row inspector's width: one app-wide preference, kept as the side panels' widths are (panels.ts) —
// every table tab draws it, a new one included, and it comes back after a restart.

const KEY = 'atelier.dbInspectorWidth';

/** A localStorage of its own (the test runs in Node), holding `saved` under the key. */
function storage(saved: string | null) {
  const m = new Map<string, string>(saved === null ? [] : [[KEY, saved]]);
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: vi.fn((k: string, v: string) => { m.set(k, v); }) };
  vi.stubGlobal('localStorage', s);
  return { m, s };
}

/** The module as the sidebar's chunk loads it at startup: read again from (stubbed) storage. */
async function fresh() {
  vi.resetModules();
  return import('./inspector-width');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('one width for every table tab', () => {
  test('a tab\'s state holds no width of its own any more', () => {
    expect('inspectorWidth' in DEFAULT_TAB).toBe(false);
  });

  test('read at startup from what was saved; nothing saved, broken or out of range: the default, clamped', async () => {
    storage('412');
    expect((await fresh()).useInspectorWidth.getState().width).toBe(412);
    for (const [saved, want] of [[null, 340], ['', 340], ['wide', 340], ['9999', 560], ['12', 280], ['300.4', 300]] as const) {
      storage(saved);
      expect((await fresh()).useInspectorWidth.getState().width, String(saved)).toBe(want);
    }
  });

  test('storage that throws (a page without it): the default, and a resize still applies for this run', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    const m = await fresh();
    expect(m.useInspectorWidth.getState().width).toBe(340);
    m.setInspectorWidth(300);
    expect(m.useInspectorWidth.getState().width).toBe(300);
  });

  test('a resize is the app\'s width, clamped, and saved for the next start', async () => {
    const { m, s } = storage(null);
    const mod = await fresh();
    mod.setInspectorWidth(9000);
    expect(mod.useInspectorWidth.getState().width).toBe(560);
    mod.setInspectorWidth(318.6);
    expect(mod.useInspectorWidth.getState().width).toBe(319);
    expect(s.setItem).toHaveBeenLastCalledWith(KEY, '319');
    // The next start reads it.
    expect(m.get(KEY)).toBe('319');
    expect((await fresh()).useInspectorWidth.getState().width).toBe(319);
  });
});
