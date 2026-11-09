import { afterEach, expect, test, vi } from 'vitest';
import { useApp } from '../store';
import { installRedis } from './install';

// Settings › Redis › Never: the project window's activity bar closes the Redis
// tabs; a pop-out has none, so its own Redis tab goes from here and the window, left with nothing, gives it back.

/** A fake window.atelier: every Redis call answers nothing, every listener does nothing. */
function fakeBridge() {
  const noop = () => () => {};
  const redis = new Proxy({}, { get: () => () => new Promise(() => {}) });
  const on = new Proxy({}, { get: () => noop });
  vi.stubGlobal('window', { atelier: { redis, on } });
}
afterEach(() => { vi.unstubAllGlobals(); });

test('Never in a pop-out holding a Redis tab: its tab goes, so the window gives it back', () => {
  fakeBridge();
  const settings = useApp.getState().settings;
  useApp.setState({ popout: { key: 'rd:keys' }, redisTabs: ['keys'], tabOrder: ['rd:keys'], activeTab: 'rd:keys', settings: { ...settings, showRedis: 'auto' } });
  const dispose = installRedis();
  try {
    useApp.getState().setSettings({ ...settings, showRedis: 'always' });
    expect(useApp.getState().redisTabs).toEqual(['keys']);
    useApp.getState().setSettings({ ...settings, showRedis: 'never' });
    expect(useApp.getState().redisTabs).toEqual([]);
    expect(useApp.getState().tabOrder).toEqual([]);
  } finally {
    dispose();
    useApp.setState({ popout: null, redisTabs: [], tabOrder: [], activeTab: 'term', settings });
  }
});
