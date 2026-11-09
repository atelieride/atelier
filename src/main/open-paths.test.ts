import { describe, expect, test } from 'vitest';
import { MAX_OPEN_FILES, pickTarget, planOpen, type OpenDeps } from './open-paths';

// A fake disk: /p is the project, /h the home folder.
const disk: Record<string, 'file' | 'dir' | 'other'> = {
  '/p': 'dir', '/p/src': 'dir', '/p/src/a.ts': 'file', '/p/b.md': 'file',
  '/h': 'dir', '/h/x.json': 'file', '/h/y.txt': 'file', '/h/proj': 'dir', '/h/proj2': 'dir', '/tmp/sock': 'other'
};
const deps: OpenDeps = {
  kind: (p) => disk[p] ?? 'missing',
  inside: (root, p) => (disk[p] && (p === root || p.startsWith(root + '/')) ? p : null),
  grant: (_root, p) => (disk[p] === 'file' ? p : null),
  home: '/h'
};

describe('planOpen', () => {
  test('project files open as project files, outside ones as external with a ~ label', () => {
    expect(planOpen('/p', ['/p/src/a.ts', '/h/x.json'], deps)).toEqual({
      files: [{ path: '/p/src/a.ts', rel: 'src/a.ts', external: false }, { path: '/h/x.json', rel: '~/x.json', external: true }],
      reveal: null, project: null, skipped: 0, capped: null, needsProject: 0
    });
  });

  test('a folder inside the project is revealed; one outside opens as a project; only the first folder counts', () => {
    expect(planOpen('/p', ['/p/src'], deps)).toMatchObject({ reveal: '/p/src', project: null, skipped: 0 });
    expect(planOpen('/p', ['/h/proj', '/h/proj2', '/p/src'], deps)).toMatchObject({ reveal: null, project: '/h/proj', skipped: 2 });
    expect(planOpen('/p', ['/p'], deps)).toMatchObject({ reveal: '/p' });
  });

  test('missing paths and things that are neither files nor folders are skipped', () => {
    expect(planOpen('/p', ['/nope', '/tmp/sock', '/p/b.md'], deps)).toMatchObject({ files: [{ path: '/p/b.md' }], skipped: 2 });
  });

  test('an outside file that cannot be granted is skipped', () => {
    expect(planOpen('/p', ['/h/x.json'], { ...deps, grant: () => null })).toMatchObject({ files: [], skipped: 1 });
  });

  test(`over ${MAX_OPEN_FILES} files: the first ${MAX_OPEN_FILES} open, the total is reported`, () => {
    const many = Array.from({ length: MAX_OPEN_FILES + 5 }, (_, i) => `/p/f${i}.ts`);
    const d = { ...deps, kind: (p: string) => (p.startsWith('/p/f') ? 'file' as const : deps.kind(p)), inside: (_r: string, p: string) => p };
    const plan = planOpen('/p', many, d);
    expect(plan.files).toHaveLength(MAX_OPEN_FILES);
    expect(plan.files[0]!.path).toBe('/p/f0.ts');
    expect(plan.capped).toBe(MAX_OPEN_FILES + 5);
  });

  test('files past the cap are counted, never granted (they would push out grants of open files)', () => {
    const many = Array.from({ length: MAX_OPEN_FILES + 5 }, (_, i) => `/h/f${i}.txt`);
    const granted: string[] = [];
    const d = { ...deps, kind: (p: string) => (p.startsWith('/h/f') ? 'file' as const : deps.kind(p)), grant: (_r: string, p: string) => { granted.push(p); return p; } };
    expect(planOpen('/p', many, d).capped).toBe(MAX_OPEN_FILES + 5);
    expect(granted).toHaveLength(MAX_OPEN_FILES);
  });

  test('the same file twice opens once', () => {
    expect(planOpen('/p', ['/p/b.md', '/p/b.md'], deps).files).toHaveLength(1);
  });

  test('without a project (Welcome) files need one first; a folder still opens as a project', () => {
    expect(planOpen(null, ['/h/x.json', '/h/proj'], deps)).toEqual({ files: [], reveal: null, project: '/h/proj', skipped: 0, capped: null, needsProject: 1 });
  });
});

describe('pickTarget (Open With, open -a, the atelier command)', () => {
  const w = (id: number, root: string | null, focusedAt: number) => ({ id, root, focusedAt });

  test('the window whose project holds the file; the deepest root wins', () => {
    expect(pickTarget('/p/src/a.ts', [w(1, '/q', 9), w(2, '/p', 1), w(3, '/p/src', 2)], [])).toEqual({ kind: 'window', id: 3 });
  });

  test('two windows of the same root: the most recently focused', () => {
    expect(pickTarget('/p/a', [w(1, '/p', 1), w(2, '/p', 5)], [])).toEqual({ kind: 'window', id: 2 });
  });

  test('no project holds it: the most recently focused project window, never the Welcome', () => {
    expect(pickTarget('/h/x.json', [w(1, '/p', 3), w(2, null, 9), w(3, '/q', 4)], [])).toEqual({ kind: 'window', id: 3 });
  });

  test('a root that is only a prefix of the path does not hold it', () => {
    expect(pickTarget('/p-twin/a', [w(1, '/p', 1), w(2, '/q', 5)], [])).toEqual({ kind: 'window', id: 2 });
  });

  test('no project window: the most recent project opens; none at all: the Welcome', () => {
    expect(pickTarget('/h/x.json', [w(2, null, 9)], ['/r', '/s'])).toEqual({ kind: 'open-project', root: '/r' });
    expect(pickTarget('/h/x.json', [], [])).toEqual({ kind: 'welcome' });
  });

  test('no project window: a recent project that holds the file is preferred', () => {
    expect(pickTarget('/s/src/a.ts', [], ['/r', '/s'])).toEqual({ kind: 'open-project', root: '/s' });
  });
});
