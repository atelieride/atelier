import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, toOut } from '../cpath';
import { beforeEach, describe, expect, test } from 'vitest';
import { candidateTries, insideProject, listDir, MAX_LARGE_FILE_BYTES, readLargeProjectFile, readProjectFile, resolveCandidate, terminalCwd } from './files';
import { useMachinePlatform, posixTest } from '../../../tests/support/platform';

// Real files with native paths: the app's platform switch reads the machine's (win32 on Windows).
useMachinePlatform();

let root: string;
let outside: string;
beforeEach(() => {
  root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-fs-'))));
  outside = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-'))));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link-outside.txt'));
  symlinkSync(join(root, 'src', 'a.ts'), join(root, 'link-inside.ts'));
});

describe('insideProject', () => {
  test('inside, outside, symlink that escapes, ../', () => {
    expect(insideProject(root, join(root, 'src', 'a.ts'))).toBe(join(root, 'src', 'a.ts'));
    expect(insideProject(root, join(outside, 'secret.txt'))).toBeNull();
    expect(insideProject(root, join(root, 'link-outside.txt'))).toBeNull();
    expect(insideProject(root, join(root, 'src', '..', '..', 'x'))).toBeNull();
    expect(insideProject(root, join(root, 'link-inside.ts'))).toBe(join(root, 'src', 'a.ts'));
  });
  test('a folder that starts with the same prefix is not inside', () => {
    const sibling = root + '-twin';
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'x.ts'), '');
    expect(insideProject(root, join(sibling, 'x.ts'))).toBeNull();
  });
});

describe('terminalCwd', () => {
  test('the root and its folders are accepted, as spelled (normalized)', () => {
    expect(terminalCwd(root, root)).toBe(root);
    expect(terminalCwd(root, join(root, 'src'))).toBe(join(root, 'src'));
    expect(terminalCwd(root, join(root, 'src', '..', 'node_modules'))).toBe(join(root, 'node_modules'));
  });
  test('a project reached through a symlink keeps the spelling the window uses', () => {
    const link = join(outside, 'proj-link');
    symlinkSync(root, link);
    expect(terminalCwd(link, join(link, 'src'))).toBe(join(link, 'src'));
    expect(terminalCwd(link, join(root, 'src'))).toBe(join(root, 'src'));
  });
  test('outside the project, a symlink that escapes, a file, a missing folder, .git: refused', () => {
    expect(terminalCwd(root, outside)).toBeNull();
    expect(terminalCwd(root, join(root, '..'))).toBeNull();
    expect(terminalCwd(root, root + '-twin')).toBeNull();
    symlinkSync(outside, join(root, 'escape'));
    expect(terminalCwd(root, join(root, 'escape'))).toBeNull();
    expect(terminalCwd(root, join(root, 'src', 'a.ts'))).toBeNull();
    expect(terminalCwd(root, join(root, 'nope'))).toBeNull();
    expect(terminalCwd(root, join(root, '.git'))).toBeNull();
    // APFS is case-insensitive: ".GIT" is the same folder, in any spelling.
    expect(terminalCwd(root, join(root, '.GIT'))).toBeNull();
    mkdirSync(join(root, '.git', 'hooks'));
    expect(terminalCwd(root, join(root, '.Git', 'hooks'))).toBeNull();
    mkdirSync(join(root, '.GIT-like'));
    expect(terminalCwd(root, join(root, '.GIT-like'))).toBe(join(root, '.GIT-like'));
  });
});

describe('readProjectFile', () => {
  test('a file inside .git (even of a nested repo, with any capitalization) opens read-only', () => {
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(readProjectFile(root, join(root, '.git', 'HEAD'))).toMatchObject({ kind: 'text', readOnly: 'git-internal' });
    mkdirSync(join(root, 'api', '.GIT'), { recursive: true });
    writeFileSync(join(root, 'api', '.GIT', 'config'), '[core]\n');
    expect(readProjectFile(root, join(root, 'api', '.GIT', 'config'))).toMatchObject({ readOnly: 'git-internal' });
    expect(readProjectFile(root, join(root, 'src', 'a.ts'))).not.toHaveProperty('readOnly');
  });
  test('text', () => {
    expect(readProjectFile(root, join(root, 'src', 'a.ts'))).toMatchObject({ kind: 'text', rel: 'src/a.ts', text: 'export const a = 1;\n' });
  });
  test('binary, missing, outside the project', () => {
    expect(readProjectFile(root, join(root, 'bin.dat')).kind).toBe('binary');
    expect(readProjectFile(root, join(root, 'missing.ts')).kind).toBe('missing');
    expect(readProjectFile(root, join(root, 'link-outside.txt')).kind).toBe('outside');
  });
  test('too large', () => {
    writeFileSync(join(root, 'big.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    expect(readProjectFile(root, join(root, 'big.log')).kind).toBe('too-large');
  });
    test('a binary file over 5 MB is binary, not too large (a reel said "larger than 5 MB")', () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 97);
    big[100] = 0;
    writeFileSync(join(root, 'reel.mp4'), big);
    expect(readProjectFile(root, join(root, 'reel.mp4'))).toMatchObject({ kind: 'binary', size: big.length });
  });
  test('text over 5 MB: read says too large with its size; readLarge reads it, read-only "large"', () => {
    const size = 6 * 1024 * 1024;
    writeFileSync(join(root, 'big.log'), Buffer.alloc(size, 97));
    expect(readProjectFile(root, join(root, 'big.log'))).toMatchObject({ kind: 'too-large', size });
    const r = readLargeProjectFile(root, join(root, 'big.log'));
    expect(r).toMatchObject({ kind: 'text', rel: 'big.log', size, readOnly: 'large' });
    expect(r.kind === 'text' && r.text.length).toBe(size);
    // A small file through readLarge: plain text, editable as usual (no "large").
    expect(readLargeProjectFile(root, join(root, 'src', 'a.ts'))).toMatchObject({ kind: 'text', text: 'export const a = 1;\n' });
    expect(readLargeProjectFile(root, join(root, 'src', 'a.ts'))).not.toHaveProperty('readOnly');
  });
  test('readLarge: over 50 MB too large; binary, missing and outside as read says', () => {
    writeFileSync(join(root, 'huge.log'), Buffer.alloc(MAX_LARGE_FILE_BYTES + 1, 97));
    expect(readLargeProjectFile(root, join(root, 'huge.log'))).toMatchObject({ kind: 'too-large', size: MAX_LARGE_FILE_BYTES + 1 });
    expect(readLargeProjectFile(root, join(root, 'bin.dat')).kind).toBe('binary');
    expect(readLargeProjectFile(root, join(root, 'missing.ts')).kind).toBe('missing');
    expect(readLargeProjectFile(root, join(root, 'link-outside.txt')).kind).toBe('outside');
  });
  // POSIX: chmod-based unreadable files and a POSIX home fixture.
  posixTest('file without read permission → unreadable, no exception', () => {
    const f = join(root, 'locked.ts');
    writeFileSync(f, 'secret');
    chmodSync(f, 0o000);
    try {
      expect(readProjectFile(root, f)).toMatchObject({ kind: 'unreadable', rel: 'locked.ts' });
    } finally {
      chmodSync(f, 0o644);
    }
  });
  test('a folder is not a file', () => {
    expect(readProjectFile(root, join(root, 'src')).kind).toBe('missing');
  });
});

describe('listDir', () => {
  test('folders first, then files, in alphabetical order; hidden ones flagged and filtered', () => {
    const names = listDir(root, root, false).map((e) => e.name);
    expect(names).toEqual(['src', 'bin.dat', 'link-inside.ts', 'link-outside.txt']);
    const all = listDir(root, root, true);
    expect(all.find((e) => e.name === 'node_modules')).toMatchObject({ dir: true, hidden: true });
  });
  test('outside the project → empty', () => {
    expect(listDir(root, outside, true)).toEqual([]);
  });
});

describe('resolveCandidate', () => {
  test('relative to the session folder, then to the root; absolute', () => {
    expect(resolveCandidate(root, join(root, 'src'), 'a.ts')).toEqual({ path: join(root, 'src', 'a.ts'), rel: 'src/a.ts' });
    expect(resolveCandidate(root, '/elsewhere', 'src/a.ts')).toEqual({ path: join(root, 'src', 'a.ts'), rel: 'src/a.ts' });
    expect(resolveCandidate(root, root, join(root, 'src', 'a.ts'))?.rel).toBe('src/a.ts');
    expect(resolveCandidate(root, root, './src/a.ts')?.rel).toBe('src/a.ts');
  });
  test('nonexistent, folder or outside → null', () => {
    expect(resolveCandidate(root, root, 'src/nope.ts')).toBeNull();
    expect(resolveCandidate(root, root, 'src')).toBeNull();
    expect(resolveCandidate(root, root, join(outside, 'secret.txt'))).toBeNull();
  });
  test('Windows: a Git Bash path (/c/Users/…) is tried as its drive path first, then as Windows reads it', () => {
    expect(candidateTries('/c/Users/x/a.ts', 'C:/r', 'C:/r', 'win32')).toEqual(['C:/Users/x/a.ts', '/c/Users/x/a.ts']);
    expect(candidateTries('/D/src/a.ts', 'C:/r', 'C:/r', 'win32')).toEqual(['D:/src/a.ts', '/D/src/a.ts']);
    // Not a drive letter: as before.
    expect(candidateTries('/usr/lib/a.ts', 'C:/r', 'C:/r', 'win32')).toEqual(['/usr/lib/a.ts']);
    expect(candidateTries('/cc/a.ts', 'C:/r', 'C:/r', 'win32')).toEqual(['/cc/a.ts']);
    // macOS: a folder named c is just a folder.
    expect(candidateTries('/c/Users/x/a.ts', '/r', '/r', 'darwin')).toEqual(['/c/Users/x/a.ts']);
  });
  test('~/ expands to the home folder, still only inside the project', () => {
    expect(resolveCandidate(root, '/elsewhere', `~/${basename(root)}/src/a.ts`, dirname(root))).toEqual({ path: join(root, 'src', 'a.ts'), rel: 'src/a.ts' });
    expect(resolveCandidate(root, root, '~/secret.txt', outside)).toBeNull();
  });
});

test('readProjectFile: the text carries the stamp (mtime and sha256) to detect conflicts on save', async () => {
  const { mkdtempSync, writeFileSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-st-'))));
  writeFileSync(join(root, 'a.ts'), 'hello\n');
  const c = readProjectFile(root, join(root, 'a.ts'));
  expect(c).toMatchObject({ kind: 'text', text: 'hello\n', hash: createHash('sha256').update('hello\n').digest('hex') });
  expect(c.kind === 'text' && c.mtimeMs > 0).toBe(true);
});

test('readProjectFile: a non-UTF-8 file opens read-only (saving it would corrupt it)', async () => {
  const { mkdtempSync, writeFileSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-enc-'))));
  writeFileSync(join(root, 'l1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  writeFileSync(join(root, 'u.txt'), 'café\n');
  expect(readProjectFile(root, join(root, 'l1.txt'))).toMatchObject({ kind: 'text', readOnly: 'not-utf8' });
  expect(readProjectFile(root, join(root, 'u.txt'))).not.toHaveProperty('readOnly');
});

test('readProjectFile: UTF-16 with its BOM (PowerShell 5.1 output) opens as text, read-only like any non-UTF-8 file', async () => {
  const { mkdtempSync, writeFileSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-enc-'))));
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name  Value\r\ncafé  1\r\n', 'utf16le')]);
  const be = Buffer.from(le.subarray(2)).swap16();
  writeFileSync(join(root, 'le.txt'), le);
  writeFileSync(join(root, 'be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  for (const name of ['le.txt', 'be.txt']) {
    expect(readProjectFile(root, join(root, name)), name).toMatchObject({ kind: 'text', text: 'Name  Value\r\ncafé  1\r\n', readOnly: 'not-utf8', size: le.length });
  }
  // A NUL without a UTF-16 BOM is still binary.
  writeFileSync(join(root, 'nul.dat'), Buffer.from([0x61, 0x00, 0x62, 0x00]));
  expect(readProjectFile(root, join(root, 'nul.dat')).kind).toBe('binary');
});

describe('readProjectImage', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  test('an image inside the project: its bytes as base64 with its type, size and time', async () => {
    const { readProjectImage } = await import('./files');
    writeFileSync(join(root, 'shot.PNG'), PNG);
    const r = readProjectImage(root, join(root, 'shot.PNG'));
    expect(r).toMatchObject({ kind: 'image', rel: 'shot.PNG', mime: 'image/png', size: PNG.length });
    expect(r.kind === 'image' && Buffer.from(r.data, 'base64').equals(PNG)).toBe(true);
    expect(r.kind === 'image' && r.mtimeMs > 0).toBe(true);
  });
  test('outside the project (a link that escapes too), missing, not an image, too large: never read', async () => {
    const { readProjectImage, MAX_IMAGE_FILE_BYTES } = await import('./files');
    writeFileSync(join(outside, 'x.png'), PNG);
    symlinkSync(join(outside, 'x.png'), join(root, 'escape.png'));
    expect(readProjectImage(root, join(outside, 'x.png')).kind).toBe('outside');
    expect(readProjectImage(root, join(root, 'escape.png')).kind).toBe('outside');
    expect(readProjectImage(root, join(root, 'gone.png')).kind).toBe('missing');
    expect(readProjectImage(root, join(root, 'src', 'a.ts')).kind).toBe('unreadable');
    writeFileSync(join(root, 'huge.jpg'), Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1));
    expect(readProjectImage(root, join(root, 'huge.jpg'))).toMatchObject({ kind: 'too-large', size: MAX_IMAGE_FILE_BYTES + 1 });
  });
});

describe('granted files outside the project', () => {
  const grants = (...ok: string[]) => (p: string) => { try { const r = toOut(realpathSync.native(p)); return ok.includes(r) ? r : null; } catch { return null; } };

  // POSIX: chmod-based unreadable files and a POSIX home fixture.
  posixTest('a granted file reads as text, its rel the path with ~ for the home folder', () => {
    const f = join(outside, 'secret.txt');
    const c = readProjectFile(root, f, grants(f), dirname(outside));
    expect(c).toMatchObject({ kind: 'text', path: f, rel: `~/${basename(outside)}/secret.txt`, text: 'secret', external: true });
  });

  test('without a grant it stays outside; a grant of another file does not open its neighbors', () => {
    const f = join(outside, 'secret.txt');
    writeFileSync(join(outside, 'other.txt'), 'x');
    expect(readProjectFile(root, f).kind).toBe('outside');
    expect(readProjectFile(root, join(outside, 'other.txt'), grants(f)).kind).toBe('outside');
  });

  test('a project file is never marked external, even if granted', () => {
    const f = join(root, 'src', 'a.ts');
    const c = readProjectFile(root, f, grants(f));
    expect(c).toMatchObject({ kind: 'text', rel: 'src/a.ts' });
    expect('external' in c).toBe(false);
  });

  test('a granted file inside some .git folder is read-only', () => {
    mkdirSync(join(outside, 'repo', '.git'), { recursive: true });
    const f = join(outside, 'repo', '.git', 'config');
    writeFileSync(f, '[core]\n');
    expect(readProjectFile(root, f, grants(f))).toMatchObject({ kind: 'text', readOnly: 'git-internal', external: true });
  });

  test('outside the home folder the rel is the absolute path', () => {
    const f = join(outside, 'secret.txt');
    expect(readProjectFile(root, f, grants(f), '/nowhere')).toMatchObject({ rel: f });
  });

  // POSIX: chmod-based unreadable files and a POSIX home fixture.
  posixTest('a granted image reads like a project one', async () => {
    const { readProjectImage } = await import('./files');
    const f = join(outside, 'p.png');
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readProjectImage(root, f).kind).toBe('outside');
    expect(readProjectImage(root, f, grants(f), dirname(outside))).toMatchObject({ kind: 'image', mime: 'image/png', external: true, rel: `~/${basename(outside)}/p.png` });
  });

  // POSIX: chmod-based unreadable files and a POSIX home fixture.
  posixTest('a granted file deleted on disk reads missing, with its label', () => {
    const f = join(outside, 'gone.txt');
    expect(readProjectFile(root, f, (p) => (p === f ? f : null), dirname(outside))).toEqual({ kind: 'missing', path: f, rel: `~/${basename(outside)}/gone.txt`, external: true });
  });

  test('missing and binary granted files keep their states, marked external', () => {
    const f = join(outside, 'bin.dat');
    writeFileSync(f, Buffer.from([1, 0, 2]));
    expect(readProjectFile(root, f, grants(f))).toMatchObject({ kind: 'binary', external: true });
  });
});
