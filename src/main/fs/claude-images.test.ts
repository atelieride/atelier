import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { checkClaudeFolder, checkClaudeFile, claudeTempLabel, claudeTempRoot, writtenUnder } from './claude-images';
import { MAX_IMAGE_FILE_BYTES } from './files';

const uid = process.getuid!();
let base: string;
let tmp: string;
let shots: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cimg-')));
  tmp = join(base, 'claude-tmp');
  shots = join(tmp, '-Users-me-proj', '974cacb3-ed53', 'scratchpad', 'shots');
  mkdirSync(shots, { recursive: true });
  chmodSync(tmp, 0o700);
  writeFileSync(join(shots, 'a.png'), 'png');
  outside = join(base, 'elsewhere');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.png'), 'png');
});

describe('claudeTempRoot', () => {
  test('a root owned by the app user and private to it', () => {
    expect(claudeTempRoot(tmp, uid)).toBe(tmp);
  });

  test('a link in the parent is followed (macOS /tmp is /private/tmp); the root itself a link is refused', () => {
    symlinkSync(base, join(base, 'parent-link'));
    expect(claudeTempRoot(join(base, 'parent-link', 'claude-tmp'), uid)).toBe(tmp);
    // Anyone can write /tmp: claude-<uid> planted as a link to a folder of ours must not be trusted.
    symlinkSync(tmp, join(base, 'tmp-link'));
    expect(claudeTempRoot(join(base, 'tmp-link'), uid)).toBeNull();
  });

  test('owned by someone else, writable by others, missing or a file: refused', () => {
    expect(claudeTempRoot(tmp, uid + 1)).toBeNull();
    chmodSync(tmp, 0o777);
    expect(claudeTempRoot(tmp, uid)).toBeNull();
    chmodSync(tmp, 0o770);
    expect(claudeTempRoot(tmp, uid)).toBeNull();
    chmodSync(tmp, 0o700);
    expect(claudeTempRoot(join(base, 'nope'), uid)).toBeNull();
    expect(claudeTempRoot(join(shots, 'a.png'), uid)).toBeNull();
  });
});

describe('checkClaudeFile', () => {
  test('an image under the root: its real path and a short label', () => {
    expect(checkClaudeFile(tmp, join(shots, 'a.png'), uid)).toEqual({ path: join(shots, 'a.png'), rel: 'scratchpad/shots/a.png' });
  });

  test('reached through a link in the parent, the real path comes back; through a root that is a link, nothing', () => {
    symlinkSync(base, join(base, 'parent-link'));
    const via = join(base, 'parent-link', 'claude-tmp', '-Users-me-proj', '974cacb3-ed53', 'scratchpad', 'shots', 'a.png');
    expect(checkClaudeFile(join(base, 'parent-link', 'claude-tmp'), via, uid)?.path).toBe(join(shots, 'a.png'));
    symlinkSync(tmp, join(base, 'tmp-link'));
    expect(checkClaudeFile(join(base, 'tmp-link'), join(base, 'tmp-link', '-Users-me-proj', '974cacb3-ed53', 'scratchpad', 'shots', 'a.png'), uid)).toBeNull();
  });

  test('outside the root, climbing out with .., or a link inside pointing out: refused', () => {
    expect(checkClaudeFile(tmp, join(outside, 'secret.png'), uid)).toBeNull();
    writeFileSync(join(outside, 'secret.md'), 'x');
    expect(checkClaudeFile(tmp, join(outside, 'secret.md'), uid)).toBeNull();
    symlinkSync(join(outside, 'secret.md'), join(shots, 'evil.md'));
    expect(checkClaudeFile(tmp, join(shots, 'evil.md'), uid)).toBeNull();
    expect(checkClaudeFile(tmp, join(shots, '..', '..', '..', '..', '..', 'elsewhere', 'secret.png'), uid)).toBeNull();
    symlinkSync(join(outside, 'secret.png'), join(shots, 'evil.png'));
    expect(checkClaudeFile(tmp, join(shots, 'evil.png'), uid)).toBeNull();
    symlinkSync(outside, join(shots, 'evil-dir'));
    expect(checkClaudeFile(tmp, join(shots, 'evil-dir', 'secret.png'), uid)).toBeNull();
  });

  test('a root that fails its own check refuses everything under it', () => {
    expect(checkClaudeFile(tmp, join(shots, 'a.png'), uid + 1)).toBeNull();
    chmodSync(tmp, 0o777);
    expect(checkClaudeFile(tmp, join(shots, 'a.png'), uid)).toBeNull();
  });

  test('any regular file, not only images: a draft, a log, a name without extension, a large file', () => {
    const scratch = join(shots, '..');
    writeFileSync(join(scratch, 'message-for-sam.md'), '# Ciao');
    expect(checkClaudeFile(tmp, join(scratch, 'message-for-sam.md'), uid)).toEqual({ path: join(scratch, 'message-for-sam.md'), rel: 'scratchpad/message-for-sam.md' });
    writeFileSync(join(scratch, 'run.log'), 'x');
    expect(checkClaudeFile(tmp, join(scratch, 'run.log'), uid)?.rel).toBe('scratchpad/run.log');
    writeFileSync(join(scratch, 'Makefile'), 'x');
    expect(checkClaudeFile(tmp, join(scratch, 'Makefile'), uid)?.path).toBe(join(scratch, 'Makefile'));
    // Its tab says how large it is: the link still opens it.
    writeFileSync(join(shots, 'big.png'), '');
    truncateSync(join(shots, 'big.png'), MAX_IMAGE_FILE_BYTES + 1);
    expect(checkClaudeFile(tmp, join(shots, 'big.png'), uid)?.path).toBe(join(shots, 'big.png'));
    // A link inside the root answers its real file, whose own name decides the tab.
    symlinkSync(join(scratch, 'message-for-sam.md'), join(shots, 'notes.png'));
    expect(checkClaudeFile(tmp, join(shots, 'notes.png'), uid)?.path).toBe(join(scratch, 'message-for-sam.md'));
  });

  test('a socket (or FIFO, whose read would block) is not a file: refused', async () => {
    // Right under the root: a Unix socket's path must stay under 104 bytes.
    const sock = join(tmp, 's');
    const server = createServer();
    await new Promise<void>((done) => server.listen(sock, done));
    try {
      expect(checkClaudeFile(tmp, sock, uid)).toBeNull();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test('a folder, a .git folder, relative, over-long or missing: refused', () => {
    mkdirSync(join(shots, 'dir.png'));
    expect(checkClaudeFile(tmp, join(shots, 'dir.png'), uid)).toBeNull();
    mkdirSync(join(shots, 'notes'));
    expect(checkClaudeFile(tmp, join(shots, 'notes'), uid)).toBeNull();
    mkdirSync(join(shots, '.git'));
    writeFileSync(join(shots, '.git', 'x.png'), 'png');
    expect(checkClaudeFile(tmp, join(shots, '.git', 'x.png'), uid)).toBeNull();
    expect(checkClaudeFile(tmp, 'shots/a.png', uid)).toBeNull();
    expect(checkClaudeFile(tmp, join(shots, 'x'.repeat(5000) + '.png'), uid)).toBeNull();
    expect(checkClaudeFile(tmp, join(shots, 'gone.png'), uid)).toBeNull();
  });
});

describe('paths are matched by their text before any disk access', () => {
  test('a path elsewhere that leads into the root through a link is refused: only paths written under the root count', () => {
    symlinkSync(shots, join(outside, 'into'));
    expect(checkClaudeFile(tmp, join(outside, 'into', 'a.png'), uid)).toBeNull();
    expect(checkClaudeFolder(tmp, join(outside, 'into') + '/', uid)).toBeNull();
  });

  test('a path with a . or .. part is not written under the root, whatever it starts with: refused before any disk access', () => {
    expect(writtenUnder(tmp, join(shots, 'a.png'))).toBe(true);
    expect(writtenUnder(tmp, `${shots}/../../../../../elsewhere/secret.md`)).toBe(false);
    expect(writtenUnder(tmp, `${tmp}/-Users-me-proj/./974cacb3-ed53/scratchpad/shots/a.png`)).toBe(false);
    expect(writtenUnder(tmp, `${tmp}/..`)).toBe(false);
    // A name merely starting with dots is a name.
    expect(writtenUnder(tmp, `${shots}/..notes.md`)).toBe(true);
    expect(writtenUnder(tmp, join(outside, 'secret.md'))).toBe(false);
  });

  test('climbing out with .. from inside the root is refused, for images and folders', () => {
    const up = `${shots}/../../../../../elsewhere`;
    expect(checkClaudeFile(tmp, `${up}/secret.png`, uid)).toBeNull();
    expect(checkClaudeFolder(tmp, `${up}/`, uid)).toBeNull();
  });

  test('the root reached through a link in its parent still counts (macOS /tmp is /private/tmp)', () => {
    symlinkSync(base, join(base, 'parent-link'));
    const viaTmp = join(base, 'parent-link', 'claude-tmp');
    expect(checkClaudeFile(viaTmp, join(viaTmp, '-Users-me-proj', '974cacb3-ed53', 'scratchpad', 'shots', 'a.png'), uid)?.path).toBe(join(shots, 'a.png'));
    // The real spelling of the same root, asked with the link-spelled setting, counts too.
    expect(checkClaudeFile(viaTmp, join(shots, 'a.png'), uid)?.path).toBe(join(shots, 'a.png'));
  });
});

describe('checkClaudeFolder', () => {
  test('a folder under the trusted root, with or without its trailing slash', () => {
    expect(checkClaudeFolder(tmp, shots + '/', uid)).toEqual({ path: shots, rel: 'scratchpad/shots' });
    expect(checkClaudeFolder(tmp, shots, uid)?.path).toBe(shots);
  });

  test('the root itself, a file, a folder outside, a link out, a .git folder, an untrusted root: refused', () => {
    expect(checkClaudeFolder(tmp, tmp + '/', uid)).toBeNull();
    expect(checkClaudeFolder(tmp, join(shots, 'a.png'), uid)).toBeNull();
    expect(checkClaudeFolder(tmp, outside + '/', uid)).toBeNull();
    symlinkSync(outside, join(shots, 'out'));
    expect(checkClaudeFolder(tmp, join(shots, 'out') + '/', uid)).toBeNull();
    mkdirSync(join(shots, '.git'));
    expect(checkClaudeFolder(tmp, join(shots, '.git') + '/', uid)).toBeNull();
    expect(checkClaudeFolder(tmp, 'scratchpad/shots/', uid)).toBeNull();
    chmodSync(tmp, 0o777);
    expect(checkClaudeFolder(tmp, shots + '/', uid)).toBeNull();
  });
});

describe('claudeTempLabel', () => {
  test('from scratchpad/ when there is one, else from inside the session folder', () => {
    expect(claudeTempLabel('/t/-p/sess/scratchpad/shots/a.png', '/t')).toBe('scratchpad/shots/a.png');
    expect(claudeTempLabel('/t/-p/sess/out/b.png', '/t')).toBe('out/b.png');
    expect(claudeTempLabel('/t/-p/c.png', '/t')).toBe('c.png');
  });
});
