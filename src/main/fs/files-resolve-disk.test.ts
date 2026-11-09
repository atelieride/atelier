import { mkdirSync, mkdtempSync, realpathSync as realReal, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, vi } from 'vitest';

// A hover asks the project resolver about every path in the output; one
// written outside the project must not touch the disk (realpath or stat of ~/Desktop/x raises a privacy prompt).
// POSIX paths, and the prompt is macOS's: the Windows forms are links.win32.test.ts' and cpath.test.ts'.

const seen = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const note = (p: unknown) => { seen.paths.push(String(p)); };
  const realpathSync = Object.assign((p: string, o?: never) => { note(p); return fs.realpathSync(p, o); }, { native: (p: string, o?: never) => { note(p); return fs.realpathSync.native(p, o); } });
  const statSync = ((p: string, o?: never) => { note(p); return fs.statSync(p, o); }) as typeof fs.statSync;
  return { ...fs, realpathSync, statSync };
});
const { resolveCandidate } = await import('./files');
const { posixTest } = await import('../../../tests/support/platform');

let root: string;
beforeEach(() => {
  root = realReal(mkdtempSync(join(tmpdir(), 'atl-rdisk-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'a');
  seen.paths = [];
});

posixTest('a path written outside the project, absolute, ~/ or relative to a folder outside it, is never resolved on disk', () => {
  expect(resolveCandidate(root, root, '/Users/nobody/Desktop/notes.md')).toBeNull();
  expect(resolveCandidate(root, root, '~/Downloads/report.pdf', '/Users/nobody')).toBeNull();
  expect(resolveCandidate(root, '/Users/nobody/Documents', 'notes.md')).toBeNull();
  expect(resolveCandidate(root, root, '../../../Users/nobody/Desktop/x.md')).toBeNull();
  expect(seen.paths.filter((p) => p.startsWith('/Users/nobody'))).toEqual([]);
});

posixTest('a project file still resolves, as spelled or by the root\'s real path', () => {
  expect(resolveCandidate(root, root, join(root, 'src', 'a.ts'))).toEqual({ path: join(root, 'src', 'a.ts'), rel: 'src/a.ts' });
  expect(resolveCandidate(root, '/Users/nobody', 'src/a.ts')).toEqual({ path: join(root, 'src', 'a.ts'), rel: 'src/a.ts' });
});
