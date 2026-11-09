import { afterEach, expect, test, vi } from 'vitest';
import { useApp, type DockerTabRef } from '../store';
import { installDocker } from './install';

// Settings › Docker › Never: the project window's activity bar closes the
// Docker tabs; a pop-out has none, so its own Docker tab goes from here and the window, left with nothing, gives it back.

/** A fake window.atelier: every Docker call answers nothing, every listener does nothing. */
function fakeBridge() {
  const noop = () => () => {};
  const docker = new Proxy({}, { get: () => () => new Promise(() => {}) });
  const on = new Proxy({}, { get: () => noop });
  vi.stubGlobal('window', { atelier: { docker, on } });
}
afterEach(() => { vi.unstubAllGlobals(); });

const OVERVIEW: DockerTabRef = { key: 'dk:overview', target: { kind: 'overview' }, view: 'logs', nonce: 0 };

test('Never in a pop-out holding a Docker tab: its tab goes, so the window gives it back', () => {
  fakeBridge();
  const settings = useApp.getState().settings;
  useApp.setState({ popout: { key: OVERVIEW.key }, dockerTabs: [OVERVIEW], dockerPreview: null, tabOrder: [OVERVIEW.key], activeTab: OVERVIEW.key, settings: { ...settings, showDocker: 'auto' } });
  const dispose = installDocker();
  try {
    useApp.getState().setSettings({ ...settings, showDocker: 'always' });
    expect(useApp.getState().dockerTabs).toEqual([OVERVIEW]);
    useApp.getState().setSettings({ ...settings, showDocker: 'never' });
    expect(useApp.getState().dockerTabs).toEqual([]);
    expect(useApp.getState().tabOrder).toEqual([]);
  } finally {
    dispose();
    useApp.setState({ popout: null, dockerTabs: [], tabOrder: [], activeTab: 'term', settings });
  }
});
