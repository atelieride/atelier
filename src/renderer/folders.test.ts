import { describe, expect, test } from 'vitest';
import { folderChoices, relativeCwd, truncateLeft } from './folders';

describe('relativeCwd', () => {
  test('a subfolder of the root, with a trailing slash', () => {
    expect(relativeCwd('/p/api', '/p', '/p')).toBe('api/');
    expect(relativeCwd('/p/apps/web/', '/p', '/p')).toBe('apps/web/');
  });
  test('the root itself and folders outside it have no label', () => {
    expect(relativeCwd('/p', '/p', '/p')).toBeNull();
    expect(relativeCwd('/p/', '/p', '/p')).toBeNull();
    expect(relativeCwd('/other', '/p', '/p')).toBeNull();
    expect(relativeCwd('/p-twin/api', '/p', '/p')).toBeNull();
    expect(relativeCwd(null, '/p', '/p')).toBeNull();
    expect(relativeCwd('/p/api', null, null)).toBeNull();
  });
  test('Claude reports the real path: relative to the real root too', () => {
    expect(relativeCwd('/private/var/p/api', '/var/p', '/private/var/p')).toBe('api/');
    expect(relativeCwd('/private/var/p', '/var/p', '/private/var/p')).toBeNull();
  });
});

describe('truncateLeft', () => {
  test('short labels stay whole', () => {
    expect(truncateLeft('api/', 18)).toBe('api/');
    expect(truncateLeft('apps/web/', 9)).toBe('apps/web/');
  });
  test('long labels keep their end, cut at a folder boundary when possible', () => {
    expect(truncateLeft('packages/frontend/apps/web/', 18)).toBe('…/apps/web/');
    expect(truncateLeft('a/very-long-folder-name-here/', 18)).toBe('…folder-name-here/');
    expect(truncateLeft('a/very-long-folder-name-here/', 18)).toHaveLength(18);
  });
});

describe('folderChoices', () => {
  const files = [
    { path: '/r/README.md', rel: 'README.md' },
    { path: '/r/docs/guide/intro.md', rel: 'docs/guide/intro.md' },
    { path: '/r/api/src/main.ts', rel: 'api/src/main.ts' },
    { path: '/r/api/.github/ci.yml', rel: 'api/.github/ci.yml' },
    { path: '/r/web/app/page.tsx', rel: 'web/app/page.tsx' },
    { path: '/r/web/node_modules/x/i.js', rel: 'web/node_modules/x/i.js' },
    { path: '/r/web/.git/HEAD', rel: 'web/.git/HEAD' }
  ];
  const repos = [{ root: '/r/web', branch: 'main' }, { root: '/r/api', branch: null }, { root: '/elsewhere', branch: 'x' }];

  test('root first, then repos, then the other folders; ignored ones are left out', () => {
    const out = folderChoices({ files, repos, root: '/u/r', realRoot: '/r', name: 'r' });
    expect(out.map((c) => c.label)).toEqual(['r', 'api/', 'web/', 'api/.github/', 'api/src/', 'docs/', 'docs/guide/', 'web/app/']);
    expect(out[0]).toEqual({ path: '/u/r', rel: '', label: 'r', hint: './', repo: false });
    // Paths use the window's spelling of the root (a link stays a link).
    expect(out.find((c) => c.rel === 'web')).toEqual({ path: '/u/r/web', rel: 'web', label: 'web/', hint: 'main', repo: true });
    expect(out.find((c) => c.rel === 'api')?.hint).toBe('repo');
    expect(out.find((c) => c.rel === 'docs')?.hint).toBe('');
  });
  test('a project that is a repo: only the root, marked as a repo', () => {
    const out = folderChoices({ files: [], repos: [{ root: '/r', branch: 'dev' }], root: '/r', realRoot: '/r', name: 'r' });
    expect(out).toEqual([{ path: '/r', rel: '', label: 'r', hint: './', repo: true }]);
  });
});
