import { describe, expect, test } from 'vitest';
import { folderChoices } from '../folders';
import { folderLabel, folderRows } from './folder-pick';

const choices = folderChoices({
  files: [{ rel: 'src/renderer/App.tsx' }, { rel: 'src/main/index.ts' }, { rel: 'site/package.json' }, { rel: 'README.md' }],
  repos: [], root: '/p/acme', realRoot: '/p/acme', name: 'acme'
});

describe('the folder picker', () => {
  test('every folder for no query, root first; a query matches the relative path, the root as ./', () => {
    expect(folderRows(choices, '').rows.map((c) => c.rel)).toEqual(['', 'site', 'src', 'src/main', 'src/renderer']);
    expect(folderRows(choices, '').typed).toBeNull();
    expect(folderRows(choices, 'rend').rows.map((c) => c.rel)).toEqual(['src/renderer']);
    expect(folderRows(choices, './').rows[0]!.rel).toBe('');
  });

  test('a typed path not in the list can be used as it is, once clean', () => {
    expect(folderRows(choices, 'packages/api/').typed).toBe('packages/api');
    expect(folderRows(choices, '/packages/api').typed).toBe('packages/api');
    expect(folderRows(choices, './packages').typed).toBe('packages');
    // Already listed, or not a folder inside the project.
    expect(folderRows(choices, 'src/main').typed).toBeNull();
    for (const bad of ['../x', 'a/../b', '.git', 'a//b', 'a\\b', '.']) expect(folderRows(choices, bad).typed, bad).toBeNull();
  });

  test('the button\'s label: the project, then the folder', () => {
    expect(folderLabel('acme', '')).toBe('acme/');
    expect(folderLabel('acme', 'src/renderer')).toBe('acme/src/renderer');
  });
});
