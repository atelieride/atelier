import { afterEach, expect, test } from 'vitest';
import { useApp } from '../store';
import { renderLive } from '../databases/test-render';
import { HiddenRepos } from './Settings';

// Settings › Source Control › Hidden repositories in <project>.

const before = useApp.getState();
afterEach(() => useApp.setState(before, true));
const project = { root: '/p', name: 'shop' } as never;

test('while the hidden list is read, the row says nothing yet: never "None" before the answer', () => {
  useApp.setState({ project, popout: null, scmSearch: null });
  const h = renderLive(HiddenRepos);
  expect(h).toContain('Hidden repositories in shop');
  expect(h).not.toContain('None.');
  expect(h).not.toContain('<ul');
});

test('none hidden: it says how to hide one; some hidden: one row each with Show', () => {
  useApp.setState({ project, popout: null, scmSearch: { capped: false, searching: false, maxFolders: 20_000, hidden: [] } });
  expect(renderLive(HiddenRepos)).toContain('None. To hide one, right-click it in Source Control and choose Hide This Repository.');
  useApp.setState({ scmSearch: { capped: false, searching: false, maxFolders: 20_000, hidden: ['agent/repo'] } });
  const h = renderLive(HiddenRepos);
  expect(h).toContain('aria-label="Show agent/repo in Source Control again"');
  expect(h).not.toContain('None.');
});
