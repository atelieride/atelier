import { chmodSync, mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixTest } from '../../tests/support/platform';
import { GrantStore } from './fs/grants';
import { claudeFolderReveal, claudeTempOpen, claudeTempResolve, grantedOf, heldReadOnly, markClaudeTemp, markTempRead, outsideOpen, outsideResolve, saveRoute, type ClaudeTempDeps } from './files-ipc';
import { readProjectFile } from './fs/files';

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-fi-')));
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), '');
  writeFileSync(join(out, 'x.json'), '{}');
  return { root, out, x: join(out, 'x.json') };
}

test('a save inside the project goes to the project writer; a granted one to the granted writer; others nowhere', () => {
  const { root, out, x } = setup();
  const g = new GrantStore();
  expect(saveRoute(root, join(root, 'src', 'a.ts'), grantedOf(g, root))).toEqual({ kind: 'project' });
  expect(saveRoute(root, x, grantedOf(g, root))).toEqual({ kind: 'project' });
  g.grant(root, x);
  expect(saveRoute(root, x, grantedOf(g, root))).toEqual({ kind: 'granted', real: x });
  writeFileSync(join(out, 'y.json'), '');
  expect(saveRoute(root, join(out, 'y.json'), grantedOf(g, root))).toEqual({ kind: 'project' });
});

test('a granted file deleted on disk still saves to its granted path (forced save of a tab with edits)', () => {
  const { root, x } = setup();
  const g = new GrantStore();
  g.grant(root, x);
  unlinkSync(x);
  expect(saveRoute(root, x, grantedOf(g, root))).toEqual({ kind: 'granted', real: x });
});

test("one project's grants never open files for another", () => {
  const { root, x } = setup();
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'atl-fi2-')));
  const g = new GrantStore();
  g.grant(root, x);
  expect(grantedOf(g, root)(x)).toBe(x);
  expect(grantedOf(g, other)(x)).toBeNull();
});

function claudeSetup() {
  const { root } = setup();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ctmp-')));
  chmodSync(tmp, 0o700);
  const dir = join(tmp, '-p', 'sess', 'scratchpad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.png'), 'png');
  const g = new GrantStore();
  const deps: ClaudeTempDeps = { tmp: () => tmp, uid: process.getuid!(), grants: g };
  return { root, g, deps, png: join(dir, 'a.png') };
}

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('resolving a Claude temp image (hover) answers without granting anything', () => {
  const { root, g, deps, png } = claudeSetup();
  expect(claudeTempResolve(png, deps)).toEqual({ path: png, rel: 'scratchpad/a.png' });
  expect(g.list(root)).toEqual([]);
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('opening it (click) grants it read-only to the project asking', () => {
  const { root, g, deps, png } = claudeSetup();
  expect(claudeTempOpen(root, png, deps)).toEqual({ path: png, rel: 'scratchpad/a.png' });
  expect(g.mode(root, png)).toBe('read');
  expect(grantedOf(g, root)(png)).toBe(png);
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('any file there, not only images, resolves (hover) and opens read-only (click)', () => {
  const { root, g, deps, png } = claudeSetup();
  const md = join(png, '..', 'message-for-sam.md');
  writeFileSync(md, '# Ciao Simona');
  expect(claudeTempResolve(md, deps)).toEqual({ path: md, rel: 'scratchpad/message-for-sam.md' });
  expect(g.list(root)).toEqual([]);
  expect(claudeTempOpen(root, md, deps)).toEqual({ path: md, rel: 'scratchpad/message-for-sam.md' });
  expect(g.mode(root, md)).toBe('read');
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('a read of a file granted read-only says so, whatever it reads as, and that it is in Claude\'s temp folder', () => {
  const { root, g, deps, png } = claudeSetup();
  const md = join(png, '..', 'message-for-sam.md');
  writeFileSync(md, '# Ciao Simona');
  claudeTempOpen(root, md, deps);
  const read = () => markTempRead(root, readProjectFile(root, md, grantedOf(g, root)), deps);
  expect(read()).toMatchObject({ kind: 'text', path: md, text: '# Ciao Simona', external: true, claudeTemp: true, readGrant: true });
  // Read-only for another reason too (past 5 MB, Open Anyway): both said.
  const large = { ...readProjectFile(root, md, grantedOf(g, root)), readOnly: 'large' as const };
  expect(markTempRead(root, large, deps)).toMatchObject({ readOnly: 'large', claudeTemp: true, readGrant: true });
  // Binary, or deleted since (its tab must not offer to recreate it): still held read-only.
  writeFileSync(md, Buffer.from([0, 1, 2, 0]));
  expect(read()).toMatchObject({ kind: 'binary', readGrant: true });
  unlinkSync(md);
  expect(read()).toMatchObject({ kind: 'missing', readGrant: true });
  writeFileSync(md, '# Ciao Simona');
  // Picked again with Open File… (a gesture): editable, still in the temp folder.
  g.grant(root, md);
  expect(read()).toMatchObject({ kind: 'text', claudeTemp: true });
  expect(read()).not.toHaveProperty('readGrant');
  // Elsewhere outside, in the project, or without the temp folder's deps: no mark.
  const { x } = setup();
  g.grant(root, x);
  expect(markTempRead(root, readProjectFile(root, x, grantedOf(g, root)), deps)).not.toHaveProperty('claudeTemp');
  const inside = markTempRead(root, readProjectFile(root, join(root, 'src', 'a.ts')), deps);
  expect(inside).toMatchObject({ kind: 'text' });
  expect(inside).not.toHaveProperty('readGrant');
  expect(inside).not.toHaveProperty('claudeTemp');
  expect(markTempRead(root, readProjectFile(root, md, grantedOf(g, root)), null)).not.toHaveProperty('claudeTemp');
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('a path the temp-root check refuses is neither resolved nor granted', () => {
  const { root, g, deps } = claudeSetup();
  const { x } = setup();
  expect(claudeTempResolve(x, deps)).toBeNull();
  expect(claudeTempOpen(root, x, deps)).toBeNull();
  expect(g.list(root)).toEqual([]);
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('an image read from Claude\'s temp folder says so, checked at every read (the folder may appear after boot)', () => {
  const { root, deps, png } = claudeSetup();
  const late = realpathSync(mkdtempSync(join(tmpdir(), 'atl-late-')));
  let tmp = join(late, 'claude-tmp');
  const d: ClaudeTempDeps = { ...deps, tmp: () => tmp };
  const img = { kind: 'image' as const, path: png, rel: 'scratchpad/a.png', mime: 'image/png', data: '', size: 3, mtimeMs: 0, external: true as const };
  // Not there yet: no mark.
  expect(markClaudeTemp(img, d)).toEqual(img);
  tmp = deps.tmp();
  expect(markClaudeTemp(img, d)).toEqual({ ...img, claudeTemp: true });
  // A project image, or one elsewhere outside, is never marked.
  expect(markClaudeTemp({ ...img, external: undefined }, d)).toEqual({ ...img, external: undefined });
  expect(markClaudeTemp({ ...img, path: join(root, 'x.png') }, d)).toEqual({ ...img, path: join(root, 'x.png') });
  expect(markClaudeTemp(img, null)).toEqual(img);
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('a temp folder that exists but fails its check is reported (once per folder), a missing one is not', () => {
  const { deps, png } = claudeSetup();
  const seen: string[] = [];
  const d: ClaudeTempDeps = { ...deps, onUntrusted: (root) => seen.push(root) };
  chmodSync(deps.tmp(), 0o777);
  expect(claudeTempResolve(png, d)).toBeNull();
  expect(claudeTempResolve(png, d)).toBeNull();
  expect(seen).toEqual([deps.tmp()]);
  const gone: ClaudeTempDeps = { ...d, tmp: () => join(deps.tmp(), 'nope') };
  expect(claudeTempResolve(png, gone)).toBeNull();
  expect(seen).toEqual([deps.tmp()]);
  chmodSync(deps.tmp(), 0o700);
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('a folder in Claude\'s temp folder resolves as a folder (hover) and opens in Finder on click, checked again', async () => {
  const { root, g, deps, png } = claudeSetup();
  const dir = join(png, '..');
  expect(claudeTempResolve(dir + '/', deps)).toEqual({ path: dir, rel: 'scratchpad', folder: true });
  const opened: string[] = [];
  expect(await claudeFolderReveal(dir + '/', deps, async (p) => { opened.push(p); })).toBe(true);
  expect(opened).toEqual([dir]);
  // Nothing granted: Finder opens it, Atelier reads nothing; the image call never grants a folder.
  expect(claudeTempOpen(root, dir + '/', deps)).toBeNull();
  expect(claudeTempOpen(root, dir, deps)).toBeNull();
  expect(g.list(root)).toEqual([]);
  const { out } = setup();
  expect(claudeTempResolve(out + '/', deps)).toBeNull();
  expect(await claudeFolderReveal(out + '/', deps, async (p) => { opened.push(p); })).toBe(false);
  expect(opened).toEqual([dir]);
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('a read-only grant is never saved over', () => {
  const { root, g, deps, png } = claudeSetup();
  claudeTempOpen(root, png, deps);
  const ro = (real: string) => g.mode(root, real) === 'read';
  expect(saveRoute(root, png, grantedOf(g, root), ro)).toEqual({ kind: 'read-only' });
  // The same file later picked with Open File… (a gesture) can be saved.
  g.grant(root, png);
  expect(saveRoute(root, png, grantedOf(g, root), ro)).toEqual({ kind: 'granted', real: png });
});

// POSIX: the temp-folder deps (uid) as above.
posixTest('a file outside Claude\'s temp folder granted read-only (Context usage\'s Claude files) reads as read-only too', () => {
  const { root, g, deps } = claudeSetup();
  const { x } = setup();
  expect(g.grant(root, x, 'read')).toBe(x);
  const c = markTempRead(root, readProjectFile(root, x, grantedOf(g, root)), deps);
  expect(c).toMatchObject({ kind: 'text', external: true, readGrant: true });
  expect(c).not.toHaveProperty('claudeTemp');
});

test('any file outside the project: resolving it (⌘-hover) grants nothing, opening it (⌘-click) grants it read-only', async () => {
  const { root, x } = setup();
  const g = new GrantStore();
  const deps = { grants: g, home: '/nowhere' };
  expect(await outsideResolve(root, x, deps)).toEqual({ path: x, rel: x });
  expect(g.list(root)).toEqual([]);
  expect(await outsideOpen(root, x, deps)).toEqual({ path: x, rel: x });
  expect(g.mode(root, x)).toBe('read');
  const ro = (real: string) => g.mode(root, real) === 'read';
  expect(saveRoute(root, x, grantedOf(g, root), ro)).toEqual({ kind: 'read-only' });
  // A project file opens as the project's, granted nothing; a folder never opens.
  expect(await outsideOpen(root, join(root, 'src', 'a.ts'), deps)).toEqual({ path: join(root, 'src', 'a.ts'), rel: 'src/a.ts' });
  expect(await outsideOpen(root, join(x, '..'), deps)).toBeNull();
  expect(g.list(root)).toEqual([x]);
});

test('a save refuses a read grant whichever deps carry the grants: without the temp folder\'s too', async () => {
  const { root, x } = setup();
  const g = new GrantStore();
  await outsideOpen(root, x, { grants: g, home: '/nowhere' });
  const ro = heldReadOnly(root, null, { grants: g, home: '/nowhere' });
  expect(ro(x)).toBe(true);
  expect(saveRoute(root, x, grantedOf(g, root), ro)).toEqual({ kind: 'read-only' });
  // Its editor is told so too: it takes no edits it could not save.
  expect(markTempRead(root, readProjectFile(root, x, grantedOf(g, root)), null, ro)).toMatchObject({ external: true, readGrant: true });
  g.grant(root, x);
  expect(ro(x)).toBe(false);
  expect(heldReadOnly(root, null, null)(x)).toBe(false);
});

test('a file the project may already edit (Open File…) stays editable when a link opens it', async () => {
  const { root, x } = setup();
  const g = new GrantStore();
  g.grant(root, x);
  expect(await outsideOpen(root, x, { grants: g, home: '/nowhere' })).toEqual({ path: x, rel: x });
  expect(g.mode(root, x)).toBe('edit');
});
