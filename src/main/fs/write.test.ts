import { chmodSync, unlinkSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toOut } from '../cpath';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createEntry, createFileWithContent, createOnly, createOutsideFile, duplicateEntry, entryInfo, renameEntry, saveFile, saveGrantedFile, stampOf, trashEntry } from './write';
import { expectMode, posixTest } from '../../../tests/support/platform';
import { useMachinePlatform } from '../../../tests/support/platform';
import { normalizeEol } from '../../renderer/editor/conflict';
import { detectEol } from '../../renderer/editor/indent';

// Real files with native paths: the app's platform switch reads the machine's (win32 on Windows).
useMachinePlatform();

// A write that lands right after a save's rename (Claude writing again): set for one test.
const afterRename = vi.hoisted(() => ({ write: null as null | ((to: string) => void) }));
vi.mock('../../daemon/fsutil', async (orig) => {
  const real = await orig<typeof import('../../daemon/fsutil')>();
  return { ...real, renameWithRetry: (from: string, to: string) => { real.renameWithRetry(from, to); afterRename.write?.(to); } };
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { chmodSync(d, 0o755); } catch { /* already writable */ } });

function project() {
  const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-w-'))));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'src', 'a.ts'), 'one\n');
  writeFileSync(join(root, '.git', 'config'), '[core]\n');
  const out = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-'))));
  writeFileSync(join(out, 'secret.txt'), 'outside\n');
  return { root, out, a: join(root, 'src', 'a.ts') };
}

describe('saveFile', () => {
  test('saves atomically and returns the new stamp', () => {
    const { root, a } = project();
    const r = saveFile(root, a, 'two\n', stampOf(a), 'lf');
    expect(r.kind).toBe('saved');
    expect(readFileSync(a, 'utf8')).toBe('two\n');
    if (r.kind === 'saved') expect(r.stamp).toEqual(stampOf(a));
    expect(readdirSync(join(root, 'src')).filter((n) => n.includes('.atelier-'))).toEqual([]);
  });
  test('the new stamp is of the bytes written: a write landing right after the rename is not adopted as the base', () => {
    const { root, a } = project();
    afterRename.write = (to) => writeFileSync(to, 'claude\n');
    try {
      const r = saveFile(root, a, 'mine\n', stampOf(a), 'lf');
      expect(r.kind).toBe('saved');
      if (r.kind === 'saved') expect(r.stamp).toMatchObject({ size: 5, hash: createHash('sha256').update('mine\n').digest('hex') });
      // Saving again against that stamp finds Claude's version: a conflict, not an overwrite.
      if (r.kind === 'saved') expect(saveFile(root, a, 'mine again\n', r.stamp, 'lf')).toMatchObject({ kind: 'conflict', disk: 'claude\n' });
    } finally {
      afterRename.write = null;
    }
  });
  test('LF and CRLF files go through the editor and back byte-identical (an unedited save changes nothing)', () => {
    const { root } = project();
    const f = join(root, 'eol.txt');
    for (const raw of ['a\nb\n', 'a\nb', 'a\r\nb\r\n', 'a\r\nb', '\r\n\r\nx\r\n', '', 'one line', 'tab\tx\n\n']) {
      writeFileSync(f, raw);
      expect(saveFile(root, f, normalizeEol(raw), stampOf(f), detectEol(raw)).kind, JSON.stringify(raw)).toBe('saved');
      expect(readFileSync(f, 'utf8'), JSON.stringify(raw)).toBe(raw);
    }
  });
  test('keeps the mode and the CRLF line endings', () => {
    const { root, a } = project();
    chmodSync(a, 0o755);
    expect(saveFile(root, a, 'x\ny\n', stampOf(a), 'crlf').kind).toBe('saved');
    expect(readFileSync(a, 'utf8')).toBe('x\r\ny\r\n');
    expectMode(a, 0o755);
  });
  test('the file changed on disk: conflict with the disk text; Keep Mine saves against the conflict\'s stamp', () => {
    const { root, a } = project();
    const base = stampOf(a);
    writeFileSync(a, 'claude\n');
    const r = saveFile(root, a, 'mine\n', base, 'lf');
    expect(r).toMatchObject({ kind: 'conflict', disk: 'claude\n' });
    expect(readFileSync(a, 'utf8')).toBe('claude\n');
    if (r.kind !== 'conflict') return;
    expect(saveFile(root, a, 'mine\n', r.stamp, 'lf').kind).toBe('saved');
    expect(readFileSync(a, 'utf8')).toBe('mine\n');
  });
  test('Keep Mine never overwrites a version newer than the one the band showed: a fresh conflict with it', () => {
    const { root, a } = project();
    writeFileSync(a, 'claude 1\n');
    const shown = stampOf(a);
    // Claude writes again after the band appeared.
    writeFileSync(a, 'claude 2\n');
    const r = saveFile(root, a, 'mine\n', shown, 'lf');
    expect(r).toMatchObject({ kind: 'conflict', disk: 'claude 2\n' });
    expect(readFileSync(a, 'utf8')).toBe('claude 2\n');
  });
  test('Keep Mine as the page sends it (the band\'s stamp, create): a file deleted meanwhile comes back with mine; a newer one is a conflict', () => {
    const { root, a } = project();
    writeFileSync(a, 'claude 1\n');
    const shown = stampOf(a);
    unlinkSync(a);
    expect(saveFile(root, a, 'mine\n', shown, 'lf', true)).toMatchObject({ kind: 'saved' });
    expect(readFileSync(a, 'utf8')).toBe('mine\n');
    writeFileSync(a, 'claude 2\n');
    expect(saveFile(root, a, 'mine again\n', shown, 'lf', true)).toMatchObject({ kind: 'conflict', disk: 'claude 2\n' });
    expect(readFileSync(a, 'utf8')).toBe('claude 2\n');
  });
  test('recreate: a file that reappeared since it was deleted is never overwritten (create only if missing)', () => {
    const { root, a } = project();
    const base = stampOf(a);
    unlinkSync(a);
    writeFileSync(a, 'back from git\n');
    expect(saveFile(root, a, 'mine\n', base, 'lf', true)).toMatchObject({ kind: 'conflict', disk: 'back from git\n' });
    expect(saveFile(root, a, 'mine\n', null, 'lf', true)).toMatchObject({ kind: 'conflict', disk: 'back from git\n' });
    expect(readFileSync(a, 'utf8')).toBe('back from git\n');
  });
  test('same content with a different mtime is not a conflict', () => {
    const { root, a } = project();
    const base = stampOf(a);
    writeFileSync(a, 'one\n');
    expect(saveFile(root, a, 'three\n', { ...base, mtimeMs: base.mtimeMs - 5000 }, 'lf').kind).toBe('saved');
  });
  test('rejections: outside the project, .git, symlink pointing outside, too large, nonexistent file', () => {
    const { root, out } = project();
    symlinkSync(join(out, 'secret.txt'), join(root, 'link.txt'));
    expect(saveFile(root, join(out, 'secret.txt'), 'x', null, 'lf').kind).toBe('error');
    expect(saveFile(root, join(root, '.git', 'config'), 'x', null, 'lf').kind).toBe('error');
    expect(saveFile(root, join(root, 'link.txt'), 'x', null, 'lf').kind).toBe('error');
    expect(readFileSync(join(out, 'secret.txt'), 'utf8')).toBe('outside\n');
    expect(saveFile(root, join(root, 'src', 'a.ts'), 'x'.repeat(5 * 1024 * 1024 + 1), null, 'lf').kind).toBe('error');
    expect(saveFile(root, join(root, 'src', 'new.ts'), 'x', null, 'lf').kind).toBe('error');
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(false);
  });
  test('symlink inside the project to a project file: the real file is written', () => {
    const { root, a } = project();
    symlinkSync(a, join(root, 'alias.ts'));
    expect(saveFile(root, join(root, 'alias.ts'), 'via link\n', null, 'lf').kind).toBe('saved');
    expect(readFileSync(a, 'utf8')).toBe('via link\n');
    expect(lstatSync(join(root, 'alias.ts')).isSymbolicLink()).toBe(true);
  });
  // POSIX: chmod-based unwritable and unreadable files.
  posixTest('write error: original intact, no temp file', () => {
    const { root, a } = project();
    const src = join(root, 'src');
    chmodSync(src, 0o555);
    dirs.push(src);
    expect(saveFile(root, a, 'new\n', stampOf(a), 'lf').kind).toBe('error');
    chmodSync(src, 0o755);
    expect(readFileSync(a, 'utf8')).toBe('one\n');
    expect(readdirSync(src).filter((n) => n.includes('.atelier-'))).toEqual([]);
  });
});

describe('createOutsideFile (Save As outside the project, at the path chosen in the save panel)', () => {
  const noTrash = vi.fn(async () => { throw new Error('nothing should be trashed'); });

  test('a new file with the text, written in place: nothing else appears in its folder', async () => {
    const { out } = project();
    const f = join(out, 'notes.md');
    expect(await createOutsideFile(f, '# Notes\n', noTrash)).toEqual({ path: f });
    expect(readFileSync(f, 'utf8')).toBe('# Notes\n');
    expect(readdirSync(out).sort()).toEqual(['notes.md', 'secret.txt']);
    expectMode(f, 0o644);
  });

  test('a file already there (the panel asked "Replace?"): to the Trash first, never deleted, then the new one', async () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    const trashed: string[] = [];
    const bin = join(out, '..', `${Date.now()}-bin`);
    mkdirSync(bin);
    const trash = vi.fn(async (p: string) => { trashed.push(readFileSync(p, 'utf8')); renameSync(p, join(bin, 'secret.txt')); });
    expect(await createOutsideFile(f, 'new\n', trash)).toEqual({ path: f });
    expect(trash).toHaveBeenCalledWith(f);
    expect(trashed).toEqual(['outside\n']);
    expect(readFileSync(f, 'utf8')).toBe('new\n');
  });

  test('the Trash refusing: nothing written, the old file as it was', async () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    expect(await createOutsideFile(f, 'new\n', async () => { throw new Error('no trash on this volume'); })).toEqual({ error: 'trash-failed' });
    expect(readFileSync(f, 'utf8')).toBe('outside\n');
  });

  test('a link or a folder at that name is refused, never followed nor trashed', async () => {
    const { out, a } = project();
    symlinkSync(a, join(out, 'link.ts'));
    expect(await createOutsideFile(join(out, 'link.ts'), 'evil', noTrash)).toEqual({ error: 'not-a-file' });
    expect(readFileSync(a, 'utf8')).toBe('one\n');
    mkdirSync(join(out, 'dir'));
    expect(await createOutsideFile(join(out, 'dir'), 'x', noTrash)).toEqual({ error: 'not-a-file' });
    expect(noTrash).not.toHaveBeenCalled();
  });

  test('never inside a .git folder, wherever it is; never a relative or unnormalized path; the folder must exist', async () => {
    const { out } = project();
    mkdirSync(join(out, 'repo', '.Git'), { recursive: true });
    expect(await createOutsideFile(join(out, 'repo', '.Git', 'hooks.sh'), 'x', noTrash)).toEqual({ error: 'in-git' });
    expect(await createOutsideFile('notes.md', 'x', noTrash)).toEqual({ error: 'outside' });
    expect(await createOutsideFile(`${out}/repo/../notes.md`, 'x', noTrash)).toEqual({ error: 'outside' });
    expect(await createOutsideFile(join(out, 'nope', 'notes.md'), 'x', noTrash)).toEqual({ error: 'missing-folder' });
    expect(await createOutsideFile(join(out, 'secret.txt', 'notes.md'), 'x', noTrash)).toEqual({ error: 'not-a-folder' });
    expect(await createOutsideFile(join(out, 'big.txt'), 'x'.repeat(5 * 1024 * 1024 + 1), noTrash)).toEqual({ error: 'too-large' });
    expect(existsSync(join(out, 'big.txt'))).toBe(false);
  });

  test('its folder reached through a link: created at the real place, and the real path returned', async () => {
    const { out } = project();
    mkdirSync(join(out, 'real'));
    symlinkSync(join(out, 'real'), join(out, 'alias'));
    expect(await createOutsideFile(join(out, 'alias', 'n.md'), 'x', noTrash)).toEqual({ path: join(out, 'real', 'n.md') });
    expect(readFileSync(join(out, 'real', 'n.md'), 'utf8')).toBe('x');
  });
});

describe('saveGrantedFile (a file outside the project the user opened)', () => {
  test('saves atomically, keeps the mode, returns the new stamp', () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    chmodSync(f, 0o600);
    const r = saveGrantedFile(f, 'changed\n', stampOf(f), 'lf');
    expect(r.kind).toBe('saved');
    expect(readFileSync(f, 'utf8')).toBe('changed\n');
    expectMode(f, 0o600);
    expect(readdirSync(out).filter((n) => n.includes('.atelier-'))).toEqual([]);
  });
  test('writes in place: the same file, nothing new in its folder (a new file there needs access to all of it)', () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    writeFileSync(f, 'a much longer first version\n');
    const ino = statSync(f).ino;
    const before = readdirSync(out);
    expect(saveGrantedFile(f, 'short\n', stampOf(f), 'lf').kind).toBe('saved');
    expect(statSync(f).ino).toBe(ino);
    expect(readFileSync(f, 'utf8')).toBe('short\n');
    expect(readdirSync(out)).toEqual(before);
  });
  test('read-only and non-UTF-8 files are left as they are', () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    chmodSync(f, 0o444);
    expect(saveGrantedFile(f, 'x\n', stampOf(f), 'lf')).toEqual({ kind: 'error', reason: 'read-only' });
    expect(readFileSync(f, 'utf8')).toBe('outside\n');
    const bin = join(out, 'latin1.txt');
    writeFileSync(bin, Buffer.from([0x63, 0xe0, 0x0a]));
    expect(saveGrantedFile(bin, 'x\n', stampOf(bin), 'lf')).toEqual({ kind: 'error', reason: 'not-utf8' });
    expect(readFileSync(bin)).toEqual(Buffer.from([0x63, 0xe0, 0x0a]));
  });
  test('a conflict when the disk changed since the read', () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    const base = stampOf(f);
    writeFileSync(f, 'by someone else\n');
    expect(saveGrantedFile(f, 'mine\n', base, 'lf')).toMatchObject({ kind: 'conflict', disk: 'by someone else\n' });
  });
  test('never inside a .git folder, wherever it is', () => {
    const { out } = project();
    mkdirSync(join(out, 'repo', '.Git'), { recursive: true });
    const f = join(out, 'repo', '.Git', 'config');
    writeFileSync(f, 'x');
    expect(saveGrantedFile(f, 'y', stampOf(f), 'lf')).toEqual({ kind: 'error', reason: 'git-internal' });
    expect(readFileSync(f, 'utf8')).toBe('x');
  });
  test('a symlink swapped in after the grant is not followed', () => {
    const { out, a } = project();
    const f = join(out, 'secret.txt');
    unlinkSync(f);
    symlinkSync(a, f);
    expect(saveGrantedFile(f, 'evil', null, 'lf', true)).toEqual({ kind: 'error', reason: 'outside' });
    expect(readFileSync(a, 'utf8')).toBe('one\n');
  });
  test('a parent folder swapped for a link is refused', () => {
    const { out, root } = project();
    mkdirSync(join(out, 'd'));
    const f = join(out, 'd', 'x.txt');
    writeFileSync(f, 'x');
    const elsewhere = join(out, 'moved');
    renameSync(join(out, 'd'), elsewhere);
    symlinkSync(join(root, 'src'), join(out, 'd'));
    expect(saveGrantedFile(f, 'evil', null, 'lf', true)).toEqual({ kind: 'error', reason: 'outside' });
    expect(existsSync(join(root, 'src', 'x.txt'))).toBe(false);
  });
  test('deleted on disk: missing, unless forced (the tab had edits)', () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    unlinkSync(f);
    expect(saveGrantedFile(f, 'back\n', null, 'lf')).toEqual({ kind: 'error', reason: 'missing' });
    expect(saveGrantedFile(f, 'back\n', null, 'lf', true).kind).toBe('saved');
    expect(readFileSync(f, 'utf8')).toBe('back\n');
  });
  test('a changed file conflicts even when created or kept: only the stamp of what is on disk writes over it', () => {
    const { out } = project();
    const f = join(out, 'secret.txt');
    const base = stampOf(f);
    writeFileSync(f, 'claude\n');
    const r = saveGrantedFile(f, 'mine\n', base, 'lf', true);
    expect(r).toMatchObject({ kind: 'conflict', disk: 'claude\n' });
    expect(saveGrantedFile(f, 'mine\n', null, 'lf', true)).toMatchObject({ kind: 'conflict', disk: 'claude\n' });
    expect(readFileSync(f, 'utf8')).toBe('claude\n');
    if (r.kind === 'conflict') expect(saveGrantedFile(f, 'mine\n', r.stamp, 'lf').kind).toBe('saved');
    expect(readFileSync(f, 'utf8')).toBe('mine\n');
  });
  test('relative paths are refused', () => {
    expect(saveGrantedFile('secret.txt', 'x', null, 'lf')).toEqual({ kind: 'error', reason: 'outside' });
  });
});

describe('createEntry', () => {
  test('creates empty files and folders', () => {
    const { root } = project();
    expect(createEntry(root, join(root, 'src'), 'b.ts', 'file')).toEqual({ path: join(root, 'src', 'b.ts') });
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('');
    expect(createEntry(root, root, 'docs', 'folder')).toEqual({ path: join(root, 'docs') });
    expect(statSync(join(root, 'docs')).isDirectory()).toBe(true);
  });
  test('forbidden names and places', () => {
    const { root, out } = project();
    symlinkSync(out, join(root, 'escapes'));
    for (const name of ['a.ts', 'x/y', '..', '.', '', '.git', 'a\0b', 'n'.repeat(256)]) {
      expect(createEntry(root, join(root, 'src'), name, 'file'), JSON.stringify(name)).toHaveProperty('error');
    }
    expect(createEntry(root, join(root, '.git'), 'hook', 'file')).toHaveProperty('error');
    expect(createEntry(root, out, 'x.ts', 'file')).toHaveProperty('error');
    expect(createEntry(root, join(root, 'escapes'), 'x.ts', 'file')).toHaveProperty('error');
    expect(existsSync(join(out, 'x.ts'))).toBe(false);
  });
});

describe('renameEntry', () => {
  test('renames within the same folder', () => {
    const { root, a } = project();
    expect(renameEntry(root, a, 'b.ts')).toEqual({ path: join(root, 'src', 'b.ts') });
    expect(existsSync(a)).toBe(false);
  });
  test('case-only difference (a.ts → A.ts): on APFS it is the same file, the rename must still happen', () => {
    const { root, a } = project();
    expect(renameEntry(root, a, 'A.ts')).toEqual({ path: join(root, 'src', 'A.ts') });
    expect(readdirSync(join(root, 'src'))).toEqual(['A.ts']);
    expect(readFileSync(join(root, 'src', 'A.ts'), 'utf8')).toBe('one\n');
  });
  test('rejects existing destination, root, .git and outside paths', () => {
    const { root, a, out } = project();
    writeFileSync(join(root, 'src', 'c.ts'), '');
    expect(renameEntry(root, a, 'c.ts')).toHaveProperty('error');
    expect(renameEntry(root, root, 'x')).toHaveProperty('error');
    expect(renameEntry(root, join(root, '.git'), 'git2')).toHaveProperty('error');
    expect(renameEntry(root, join(out, 'secret.txt'), 'y.txt')).toHaveProperty('error');
  });
  test('a symlink is renamed as a link (the target stays)', () => {
    const { root, out } = project();
    symlinkSync(join(out, 'secret.txt'), join(root, 'link.txt'));
    expect(renameEntry(root, join(root, 'link.txt'), 'link2.txt')).toEqual({ path: join(root, 'link2.txt') });
    expect(lstatSync(join(root, 'link2.txt')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(out, 'secret.txt'))).toBe(true);
  });
});

test('duplicateEntry: "a copy.ts", poi "a copy 2.ts"', () => {
  const { root, a } = project();
  expect(duplicateEntry(root, a)).toEqual({ path: join(root, 'src', 'a copy.ts') });
  expect(duplicateEntry(root, a)).toEqual({ path: join(root, 'src', 'a copy 2.ts') });
  expect(readFileSync(join(root, 'src', 'a copy.ts'), 'utf8')).toBe('one\n');
  expect(duplicateEntry(root, join(root, 'src'))).toHaveProperty('error');
});

describe('trashEntry', () => {
  test('only project paths go to the trash; a symlink as a link', async () => {
    const { root, a, out } = project();
    symlinkSync(join(out, 'secret.txt'), join(root, 'link.txt'));
    const trashed: string[] = [];
    const trash = async (p: string) => { trashed.push(p); };
    expect(await trashEntry(root, a, trash)).toEqual({ ok: true });
    expect(await trashEntry(root, join(root, 'link.txt'), trash)).toEqual({ ok: true });
    expect(trashed).toEqual([a, join(root, 'link.txt')]);
    for (const p of [root, join(root, '.git'), join(root, '.git', 'config'), join(out, 'secret.txt')]) {
      expect(await trashEntry(root, p, trash), p).toHaveProperty('error');
    }
    expect(trashed).toHaveLength(2);
  });
});

test('entryInfo counts the files in a folder', () => {
  const { root } = project();
  writeFileSync(join(root, 'src', 'b.ts'), '');
  expect(entryInfo(root, join(root, 'src'))).toEqual({ kind: 'folder', files: 2 });
  expect(entryInfo(root, join(root, 'src', 'b.ts'))).toEqual({ kind: 'file', files: 1 });
});

describe('edge cases: other casings of .git, encodings, deleted and read-only files', () => {
  test('.git with other casing (APFS does not distinguish) stays untouchable', async () => {
    const { root } = project();
    for (const g of ['.GIT', '.Git']) {
      expect(saveFile(root, join(root, g, 'config'), 'x', null, 'lf').kind, g).toBe('error');
      expect(createEntry(root, join(root, g), 'hook', 'file'), g).toHaveProperty('error');
      expect(renameEntry(root, join(root, g), 'via'), g).toHaveProperty('error');
      expect(await trashEntry(root, join(root, g), async () => {}), g).toHaveProperty('error');
    }
    for (const n of ['.GIT', '.Git', '.git']) expect(createEntry(root, root, n, 'folder'), n).toHaveProperty('error');
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });
  test('a non-UTF-8 file on disk is not overwritten (it would be corrupted)', () => {
    const { root } = project();
    const p = join(root, 'latin1.txt');
    writeFileSync(p, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(saveFile(root, p, 'caf�\n', stampOf(p), 'lf')).toMatchObject({ kind: 'error', reason: 'not-utf8' });
    expect([...readFileSync(p)]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  });
  test('deleted file: error without force; with force it is recreated', () => {
    const { root, a } = project();
    const base = stampOf(a);
    unlinkSync(a);
    expect(saveFile(root, a, 'mine\n', base, 'lf')).toMatchObject({ kind: 'error', reason: 'missing' });
    expect(saveFile(root, a, 'mine\n', base, 'lf', true).kind).toBe('saved');
    expect(readFileSync(a, 'utf8')).toBe('mine\n');
  });
  test('recreate puts its file in place only while the name is free, with or without hard links', () => {
    const { root } = project();
    const noLinks = () => { throw Object.assign(new Error('no links'), { code: 'ENOTSUP' }); };
    for (const link of [undefined, noLinks]) {
      const tmp = join(root, '.t.atelier-x');
      const target = join(root, 'back.txt');
      writeFileSync(tmp, 'mine\n');
      writeFileSync(target, 'theirs\n');
      expect(createOnly(tmp, target, Buffer.from('mine\n'), link)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('theirs\n');
      unlinkSync(target);
      expect(createOnly(tmp, target, Buffer.from('mine\n'), link)).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('mine\n');
      expect(existsSync(tmp)).toBe(false);
      unlinkSync(target);
    }
  });
  test('read-only file: error, not overwritten', () => {
    const { root, a } = project();
    chmodSync(a, 0o444);
    expect(saveFile(root, a, 'x\n', stampOf(a), 'lf')).toMatchObject({ kind: 'error', reason: 'read-only' });
    expect(readFileSync(a, 'utf8')).toBe('one\n');
  });
  // POSIX: chmod-based unwritable and unreadable files.
  posixTest('an unreadable file gives an error, not an exception', () => {
    const { root, a } = project();
    chmodSync(a, 0o222);
    let r: ReturnType<typeof saveFile> | null = null;
    expect(() => { r = saveFile(root, a, 'x\n', { mtimeMs: 0, size: 0, hash: 'a'.repeat(64) }, 'lf'); }).not.toThrow();
    expect(r).toMatchObject({ kind: 'error' });
    chmodSync(a, 0o644);
  });
});

describe('createFileWithContent (Save as of an untitled tab)', () => {
  test('creates the file with its text in an existing folder and returns the real path, no temp left behind', () => {
    const { root } = project();
    const r = createFileWithContent(root, 'src/todo.md', '# Todo\n- one\n');
    expect(r).toEqual({ path: join(root, 'src', 'todo.md') });
    expect(readFileSync(join(root, 'src', 'todo.md'), 'utf8')).toBe('# Todo\n- one\n');
    expect(statSync(join(root, 'src', 'todo.md')).mode & 0o200).toBe(0o200);
    expect(readdirSync(join(root, 'src')).filter((n) => n.includes('.atelier-'))).toEqual([]);
    expect(createFileWithContent(root, 'top.txt', '')).toEqual({ path: join(root, 'top.txt') });
  });
  test('never replaces an existing file (nor a folder)', () => {
    const { root, a } = project();
    expect(createFileWithContent(root, 'src/a.ts', 'mine')).toEqual({ error: 'exists' });
    expect(readFileSync(a, 'utf8')).toBe('one\n');
    expect(createFileWithContent(root, 'src', 'mine')).toEqual({ error: 'exists' });
  });
  test('the folder must exist and be a folder', () => {
    const { root } = project();
    expect(createFileWithContent(root, 'nope/x.md', 'x')).toEqual({ error: 'missing-folder' });
    expect(createFileWithContent(root, 'src/a.ts/x.md', 'x')).toEqual({ error: 'not-a-folder' });
    expect(existsSync(join(root, 'nope'))).toBe(false);
  });
  test('refuses paths outside the root: absolute, "..", a folder link that leads out', () => {
    const { root, out } = project();
    symlinkSync(out, join(root, 'away'));
    expect(createFileWithContent(root, `${out}/x.md`, 'x')).toEqual({ error: 'absolute' });
    expect(createFileWithContent(root, '../x.md', 'x')).toEqual({ error: 'outside' });
    expect(createFileWithContent(root, 'src/../../x.md', 'x')).toEqual({ error: 'outside' });
    expect(createFileWithContent(root, 'away/x.md', 'x')).toEqual({ error: 'outside' });
    expect(readdirSync(out)).toEqual(['secret.txt']);
  });
  test('refuses .git in any spelling, also behind a link', () => {
    const { root } = project();
    symlinkSync(join(root, '.git'), join(root, 'g'));
    expect(createFileWithContent(root, '.git/hooks.sh', 'x')).toEqual({ error: 'in-git' });
    expect(createFileWithContent(root, '.GIT/x', 'x')).toEqual({ error: 'in-git' });
    expect(createFileWithContent(root, 'src/.Git', 'x')).toEqual({ error: 'in-git' });
    expect(createFileWithContent(root, 'g/x', 'x')).toEqual({ error: 'in-git' });
    expect(readdirSync(join(root, '.git'))).toEqual(['config']);
  });
  test('refuses invalid names: empty, trailing slash, ".", NUL, too long; and files over 5 MB', () => {
    const { root } = project();
    for (const rel of ['', 'src/', './x', 'src//x', 'a\0b', 'x'.repeat(256)]) expect(createFileWithContent(root, rel, 'x')).toEqual({ error: 'invalid-name' });
    expect(createFileWithContent(root, 'big.txt', 'x'.repeat(5 * 1024 * 1024 + 1))).toEqual({ error: 'too-large' });
    expect(existsSync(join(root, 'big.txt'))).toBe(false);
  });
  test('on a volume without hard links (exFAT, FAT, some network shares) it still saves, by exclusive create, and still never overwrites', () => {
    const { root, a } = project();
    for (const code of ['ENOTSUP', 'EPERM', 'ENOSYS', 'EXDEV']) {
      const noLinks = () => { throw Object.assign(new Error(code), { code }); };
      const name = `src/${code}.md`;
      expect(createFileWithContent(root, name, 'saved\n', noLinks)).toEqual({ path: join(root, name) });
      expect(readFileSync(join(root, name), 'utf8')).toBe('saved\n');
    }
    // A file appearing between the check and the write: still "exists", never replaced.
    const raced = () => { writeFileSync(join(root, 'src', 'race.md'), 'theirs'); throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }); };
    expect(createFileWithContent(root, 'src/race.md', 'mine', raced)).toEqual({ error: 'exists' });
    expect(readFileSync(join(root, 'src', 'race.md'), 'utf8')).toBe('theirs');
    expect(readFileSync(a, 'utf8')).toBe('one\n');
    expect(readdirSync(join(root, 'src')).filter((n) => n.includes('.atelier-'))).toEqual([]);
  });
  test('errors come back as known codes, never a raw errno', () => {
    const { root } = project();
    const odd = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
    expect(createFileWithContent(root, 'src/x.md', 'x', odd)).toEqual({ error: 'failed' });
    expect(existsSync(join(root, 'src', 'x.md'))).toBe(false);
  });
});
