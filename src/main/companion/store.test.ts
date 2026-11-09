import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { newThread } from '@shared/companion/thread';
import { posixTest } from '../../../tests/support/platform';
import { CompanionStore } from './store';

const ID = (n: number) => `0000000${n}-1111-4222-8333-944455556666`;
const UUID = '11111111-2222-4333-8444-555555555555';
const root = () => join(mkdtempSync(join(tmpdir(), 'atl-cs-')), 'companion');

test('a thread round-trips through save and load', () => {
  const s = new CompanionStore(root());
  const t = { ...newThread(ID(1), UUID, 1000), unseen: true };
  s.save(t);
  expect(s.load(ID(1))).toEqual(t);
  expect(s.load(ID(2))).toBeNull();
});

posixTest('the folder is 0700 and every file 0600', () => {
  const r = root();
  const s = new CompanionStore(r);
  s.save(newThread(ID(1), UUID, 1));
  s.writeInputs(ID(1), { rules: 'r', chat: 'c', facts: 'f' });
  expect(statSync(s.dirOf(ID(1))).mode & 0o777).toBe(0o700);
  for (const f of ['thread.json', 'rules.md', 'chat.md', 'facts.md']) expect(statSync(join(s.dirOf(ID(1)), f)).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(s.dirOf(ID(1)), 'chat.md'), 'utf8')).toBe('c');
});

test('dirOf refuses anything but a session id', () => {
  const s = new CompanionStore(root());
  for (const bad of ['../x', '', 'abc', `${ID(1)}/..`]) expect(() => s.dirOf(bad)).toThrow();
});

test('corrupt or foreign JSON loads as null', () => {
  const s = new CompanionStore(root());
  s.save(newThread(ID(1), UUID, 1));
  writeFileSync(join(s.dirOf(ID(1)), 'thread.json'), '{not json');
  expect(s.load(ID(1))).toBeNull();
  writeFileSync(join(s.dirOf(ID(1)), 'thread.json'), JSON.stringify(newThread(ID(2), UUID, 1)));
  expect(s.load(ID(1))).toBeNull();
});

test('remove deletes only that session folder', () => {
  const s = new CompanionStore(root());
  s.save(newThread(ID(1), UUID, 1));
  s.save(newThread(ID(2), UUID, 1));
  s.remove(ID(1));
  expect(existsSync(s.dirOf(ID(1)))).toBe(false);
  expect(s.load(ID(2))).not.toBeNull();
  s.remove(ID(3));
});

posixTest('remove of a symlinked folder unlinks the link and leaves its target', () => {
  const r = root();
  const s = new CompanionStore(r);
  const target = mkdtempSync(join(tmpdir(), 'atl-cst-'));
  writeFileSync(join(target, 'keep.txt'), 'x');
  mkdirSync(r, { recursive: true });
  symlinkSync(target, s.dirOf(ID(1)));
  s.remove(ID(1));
  expect(existsSync(s.dirOf(ID(1)))).toBe(false);
  expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('x');
});

posixTest('save and writeInputs refuse a symlinked session folder: nothing is written or chmodded through it', () => {
  const r = root();
  const s = new CompanionStore(r);
  const target = mkdtempSync(join(tmpdir(), 'atl-cst-'));
  chmodSync(target, 0o755);
  mkdirSync(r, { recursive: true });
  symlinkSync(target, s.dirOf(ID(1)));
  expect(() => s.save(newThread(ID(1), UUID, 1))).toThrow(/not a folder/);
  expect(() => s.writeInputs(ID(1), { rules: 'r', chat: 'c', facts: 'f' })).toThrow(/not a folder/);
  expect(readdirSync(target)).toEqual([]);
  expect(statSync(target).mode & 0o777).toBe(0o755);
  // A file in its place: refused the same way.
  writeFileSync(s.dirOf(ID(2)), 'x');
  expect(() => s.save(newThread(ID(2), UUID, 1))).toThrow(/not a folder/);
});

posixTest('a symlinked thread.json or rules.md is replaced by the file, never written through', () => {
  const s = new CompanionStore(root());
  s.save(newThread(ID(1), UUID, 1));
  const outside = join(mkdtempSync(join(tmpdir(), 'atl-cso-')), 'victim.txt');
  writeFileSync(outside, 'untouched');
  for (const f of ['thread.json', 'rules.md']) {
    const at = join(s.dirOf(ID(1)), f);
    rmSync(at, { force: true });
    symlinkSync(outside, at);
  }
  s.save(newThread(ID(1), UUID, 2));
  s.writeInputs(ID(1), { rules: 'r', chat: 'c', facts: 'f' });
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
  for (const f of ['thread.json', 'rules.md']) expect(lstatSync(join(s.dirOf(ID(1)), f)).isFile()).toBe(true);
  expect(s.load(ID(1))?.lastUsedAt).toBe(2);
  expect(readFileSync(join(s.dirOf(ID(1)), 'rules.md'), 'utf8')).toBe('r');
});

test('list returns session ids with a folder, ignoring anything else', () => {
  const r = root();
  const s = new CompanionStore(r);
  expect(s.list()).toEqual([]);
  s.save(newThread(ID(1), UUID, 1));
  s.save(newThread(ID(2), UUID, 1));
  mkdirSync(join(r, 'not-a-uuid'));
  writeFileSync(join(r, ID(3)), 'a file, not a folder');
  expect(s.list().sort()).toEqual([ID(1), ID(2)]);
  expect(readdirSync(r)).toContain('not-a-uuid');
});

test("changedAt is the session folder's last change; null without a folder or for a bad id", () => {
  const s = new CompanionStore(root());
  expect(s.changedAt(ID(1))).toBeNull();
  expect(s.changedAt('../x')).toBeNull();
  s.save(newThread(ID(1), UUID, 1));
  utimesSync(s.dirOf(ID(1)), 1000, 1000);
  expect(s.changedAt(ID(1))).toBe(1_000_000);
  s.writeInputs(ID(1), { rules: 'r', chat: 'c', facts: 'f' });
  expect(s.changedAt(ID(1))!).toBeGreaterThan(1_000_000);
});
