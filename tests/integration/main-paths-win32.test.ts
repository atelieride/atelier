import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { toCanonical } from '../../src/shared/paths';
import { insideProject, listDir, readProjectFile, resolveCandidate, terminalCwd } from '../../src/main/fs/files';
import { buildFileIndex } from '../../src/main/git/service';
import { isWin, useMachinePlatform } from '../support/platform';

// Main hands the renderer canonical paths on Windows, on real files: the file tree, the file
// index (⌘K), a file read, a path quoted in a terminal. Found on the PC (2026-10-18): the index and the tree gave
// C:\… paths, which the renderer sent back and IPC refused ("This file can't be read").

useMachinePlatform();
let root = '';
beforeAll(() => {
  if (!isWin) return;
  // The project as the renderer knows it: canonical.
  root = toCanonical(realpathSync.native(mkdtempSync(join(tmpdir(), 'atl-paths-'))));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'notes.txt'), 'first\nsecond\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n');
});

const canonical = (p: string) => expect(p, p).toMatch(/^[A-Z]:\/(?!.*\\)/);

test.runIf(isWin)('the tree, the index, a read and a quoted path: canonical paths, rel with /', async () => {
  const tree = listDir(root, root, false);
  expect(tree.map((e) => [e.name, e.path, e.rel])).toEqual([['src', `${root}/src`, 'src'], ['notes.txt', `${root}/notes.txt`, 'notes.txt']]);
  const index = await buildFileIndex(root, []);
  expect(index.map((f) => [f.path, f.rel]).sort()).toEqual([[`${root}/notes.txt`, 'notes.txt'], [`${root}/src/a.ts`, 'src/a.ts']]);
  const read = readProjectFile(root, `${root}/src/a.ts`);
  expect(read.kind).toBe('text');
  canonical(read.path);
  expect(read.rel).toBe('src/a.ts');
  const quoted = resolveCandidate(root, `${root}/src`, 'a.ts');
  expect(quoted).toEqual({ path: `${root}/src/a.ts`, rel: 'src/a.ts' });
  canonical(insideProject(root, `${root}/notes.txt`)!);
  expect(terminalCwd(root, `${root}/src`)).toBe(`${root}/src`);
});
