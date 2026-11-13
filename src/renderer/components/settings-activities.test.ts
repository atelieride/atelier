import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { useApp } from '../store';
import { Appearance } from './Settings';

// Settings › Appearance › Activities inside workspaces: one switch for every project, usable only where workspaces are on.

const html = (s = DEFAULT_SETTINGS) => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(createElement(Appearance, { s }));
};
/** The row whose label is `label`: [its markup, its switch's markup]. */
const row = (h: string, label: string) => {
  const i = h.indexOf(`<span class="set-label">${label}</span>`);
  expect(i).toBeGreaterThan(-1);
  const start = h.lastIndexOf('<div class="set-row', i);
  return h.slice(start, h.indexOf('</button>', i) + 9);
};
const LABEL = 'Activities inside workspaces';

beforeEach(() => {
  useApp.setState({ project: { root: '/p', name: 'acme-store', realRoot: '/p' }, popout: null, ws: null });
});

test('after "⌘J follows", off by default, with its hint', () => {
  useApp.setState({ ws: { on: true, active: 'A', list: [{ id: 'A', name: 'A', color: 1, folder: null, order: [], active: null, layout: null }], members: {} } });
  const h = html();
  expect(h.indexOf(LABEL)).toBeGreaterThan(h.indexOf('follows sessions into other workspaces'));
  const r = row(h, LABEL);
  expect(r).not.toContain('is-disabled');
  expect(r).toContain('aria-checked="false"');
  expect(r).toContain('Group a workspace’s sessions, terminals and files into activities, each with its own tabs');
  expect(row(html({ ...DEFAULT_SETTINGS, wsActivities: true }), LABEL)).toContain('aria-checked="true"');
});

test('a project window whose workspaces are off: disabled, saying why', () => {
  const r = row(html({ ...DEFAULT_SETTINGS, wsActivities: true }), LABEL);
  expect(r).toContain('set-row is-disabled');
  expect(r).toContain('Turn on workspaces, in this project or in every project, to use activities.');
  expect(r).toMatch(/aria-checked="false"[^>]*disabled=""/);
});

test('workspaces on in every project count as on; the welcome window offers it too', () => {
  expect(row(html({ ...DEFAULT_SETTINGS, workspacesEverywhere: true }), LABEL)).not.toContain('is-disabled');
  useApp.setState({ project: null });
  expect(row(html(), LABEL)).not.toContain('is-disabled');
});
