import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toOut } from './cpath';
import { beforeEach, expect, test } from 'vitest';
import { GrantStore } from './fs/grants';
import { MAX_TAB_PROJECTS, TabsStore, keepAllowed, restoreTabs, shelfKeep } from './tabs-store';
import { expectMode, isWin, posixTest } from '../../tests/support/platform';
import { useMachinePlatform } from '../../tests/support/platform';

// Real files with native paths: the app's platform switch reads the machine's (win32 on Windows).
useMachinePlatform();

let base: string;
let p: string;
let out: string;
beforeEach(() => {
  base = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-tabs-'))));
  p = join(base, 'p'); out = join(base, 'out');
  mkdirSync(join(p, 'src'), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(p, 'src', 'a.ts'), '');
  writeFileSync(join(out, 'x.json'), '');
  writeFileSync(join(out, 'y.json'), '');
});

test('only project files and granted ones are kept; the order and the active key follow', () => {
  const g = new GrantStore();
  g.grant(p, join(out, 'x.json'));
  const kept = keepAllowed(p, {
    files: [join(p, 'src', 'a.ts'), join(out, 'x.json'), join(out, 'y.json')],
    order: ['t:t1', `f:${join(p, 'src', 'a.ts')}`, `f:${join(out, 'y.json')}`, `f:${join(out, 'x.json')}`],
    active: `f:${join(out, 'y.json')}`
  }, (f) => g.has(p, f));
  expect(kept).toEqual({ files: [join(p, 'src', 'a.ts'), join(out, 'x.json')], order: ['t:t1', `f:${join(p, 'src', 'a.ts')}`, `f:${join(out, 'x.json')}`], active: null });
});

test('restore: files still there come back (outside ones granted again), gone ones are dropped', () => {
  const g = new GrantStore();
  const saved = { files: [join(p, 'src', 'a.ts'), join(out, 'x.json'), join(p, 'gone.ts')], order: [`f:${join(out, 'x.json')}`, 't:t1', `f:${join(p, 'gone.ts')}`, `f:${join(p, 'src', 'a.ts')}`], active: 't:t1' };
  const r = restoreTabs(p, saved, (f) => g.grant(p, f), '/nowhere');
  expect(r.files).toEqual([{ path: join(p, 'src', 'a.ts'), rel: 'src/a.ts', external: false }, { path: join(out, 'x.json'), rel: join(out, 'x.json'), external: true }]);
  expect(r.order).toEqual([`f:${join(out, 'x.json')}`, 't:t1', `f:${join(p, 'src', 'a.ts')}`]);
  expect(r.active).toBe('t:t1');
  expect(g.has(p, join(out, 'x.json'))).toBe(true);
});

test('restore: the Databases space\'s tab in front comes back with the tables; none saved, none back', () => {
  const orders = 'db:c0123456789ab/public/orders';
  expect(restoreTabs(p, { files: [], order: ['t:t1', orders], active: 't:t1', dbActive: orders }, () => null, '/nowhere')).toEqual({ files: [], order: ['t:t1', orders], active: 't:t1', dbActive: orders });
  expect(restoreTabs(p, { files: [], order: ['t:t1'], active: 't:t1' }, () => null, '/nowhere')).toEqual({ files: [], order: ['t:t1'], active: 't:t1' });
});

test('the Shelf\'s outside files: kept only when granted; restored granted again, gone or swapped ones dropped', () => {
  const g = new GrantStore();
  g.grant(p, join(out, 'x.json'));
  const kept = keepAllowed(p, { files: [], order: [], active: null, shelf: [join(out, 'x.json'), join(out, 'y.json')] }, (f) => g.has(p, f));
  expect(kept).toEqual({ files: [], order: [], active: null, shelf: [join(out, 'x.json')] });

  const fresh = new GrantStore();
  const gone = join(out, 'gone.sql');
  const swapped = join(out, 'swapped.json');
  symlinkSync(join(out, 'y.json'), swapped);
  const r = restoreTabs(p, { files: [], order: [], active: null, shelf: [join(out, 'x.json'), gone, swapped] }, (f) => fresh.grant(p, f), '/nowhere');
  expect(r.shelf).toEqual([{ path: join(out, 'x.json'), rel: join(out, 'x.json'), external: true }]);
  expect(fresh.has(p, join(out, 'x.json'))).toBe(true);
  expect(fresh.has(p, join(out, 'y.json'))).toBe(false);
  // Nothing saved for the shelf: nothing restored for it.
  expect(restoreTabs(p, { files: [], order: [], active: null }, (f) => fresh.grant(p, f), '/nowhere').shelf).toBeUndefined();
  // A project file in it (spelled outside the real root by the page) comes back as it is: no grant needed.
  expect(restoreTabs(p, { files: [], order: [], active: null, shelf: [join(p, 'src', 'a.ts')] }, () => null, '/nowhere').shelf)
    .toEqual([{ path: join(p, 'src', 'a.ts'), rel: 'src/a.ts', external: false }]);
});

test('the shelf\'s outside files saved: granted for editing, or already kept by main (a volume away for one launch); never a read-only grant', () => {
  const g = new GrantStore();
  const x = join(out, 'x.json');
  const y = join(out, 'y.json');
  g.grant(p, x);
  g.grant(p, y, 'read');
  // Native paths: on Windows a saved path must start with a drive.
  const away = isWin ? 'E:/usb/dump.sql' : '/Volumes/usb/dump.sql';
  const other = isWin ? 'C:/Windows/win.ini' : '/etc/passwd';
  const keep = shelfKeep(g, p, [away]);
  expect(keep(x)).toBe(true);
  expect(keep(y)).toBe(false);
  expect(keep(away)).toBe(true);
  expect(keep(other)).toBe(false);
  expect(keepAllowed(p, { files: [], order: [], active: null, shelf: [x, y, away, other] }, (f) => g.has(p, f), keep).shelf)
    .toEqual([x, away]);
});

test('restore: a project file opened through a link inside the project comes back as it was spelled', () => {
  symlinkSync(join(p, 'src', 'a.ts'), join(p, 'link.ts'));
  const f = join(p, 'link.ts');
  const r = restoreTabs(p, { files: [f], order: [`f:${f}`], active: `f:${f}` }, () => null, '/nowhere');
  expect(r).toEqual({ files: [{ path: f, rel: 'link.ts', external: false }], order: [`f:${f}`], active: `f:${f}` });
});

test('restore: an outside file swapped for a symlink since is not granted again', () => {
  const g = new GrantStore();
  const f = join(out, 'x.json');
  unlinkSync(f);
  symlinkSync(join(out, 'y.json'), f);
  const r = restoreTabs(p, { files: [f], order: [`f:${f}`], active: `f:${f}` }, (x) => g.grant(p, x), '/nowhere');
  expect(r).toEqual({ files: [], order: [], active: null });
  expect(g.list(p)).toEqual([]);
});

test('restore: an outside file takes the label given for it (a Claude temp image), else its ~ label', () => {
  const g = new GrantStore();
  const x = join(out, 'x.json');
  const y = join(out, 'y.json');
  const label = (f: string) => (f === x ? 'scratchpad/x.json' : null);
  const r = restoreTabs(p, { files: [x, y], order: [], active: null }, (f) => g.grant(p, f), '/nowhere', label);
  expect(r.files).toEqual([{ path: x, rel: 'scratchpad/x.json', external: true }, { path: y, rel: y, external: true }]);
});

test('the store: per project, saved 0600 atomically, read back by a new instance', () => {
  const file = join(base, 'home', 'tabs.json');
  mkdirSync(join(base, 'home'));
  const s = new TabsStore(file);
  s.set(p, { files: [join(p, 'src', 'a.ts')], order: [`f:${join(p, 'src', 'a.ts')}`], active: null });
  expectMode(file, 0o600);
  expect(new TabsStore(file).get(p)).toEqual({ files: [join(p, 'src', 'a.ts')], order: [`f:${join(p, 'src', 'a.ts')}`], active: null });
  expect(new TabsStore(file).get('/other')).toBeNull();
});

test("the store keeps main's read-only list with a project's tabs; an entry saved before it has none", () => {
  const file = join(base, 'home', 'tabs.json');
  mkdirSync(join(base, 'home'));
  const out = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-tsr-'))));
  const plan = join(out, 'plan.md');
  const tabs = { files: [join(p, 'src', 'a.ts'), plan], order: [`f:${plan}`], active: null };
  const s = new TabsStore(file);
  s.set(p, tabs, [plan]);
  expect(new TabsStore(file).readOnly(p)).toEqual([plan]);
  // The same tabs, the file made editable since (Open File…): written again.
  s.set(p, tabs, []);
  expect(new TabsStore(file).readOnly(p)).toEqual([]);
  // Only the project's own tab files, only absolute paths.
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, { readOnly?: unknown }> };
  raw.projects[p]!.readOnly = [plan, '/elsewhere/x.md', 'rel.md', 7];
  writeFileSync(file, JSON.stringify(raw));
  expect(new TabsStore(file).readOnly(p)).toEqual([plan]);
  // Made editable by a gesture: dropped from the list and written at once, the tabs as they were.
  s.set(p, tabs, [plan]);
  s.dropReadOnly(p, plan);
  expect(new TabsStore(file).readOnly(p)).toEqual([]);
  expect(new TabsStore(file).get(p)).toEqual(tabs);
  s.dropReadOnly('/other', plan);
  expect(new TabsStore(file).readOnly('/other')).toBeNull();
  // Saved by an earlier version: no list.
  const old = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, { readOnly?: unknown }> };
  delete old.projects[p]!.readOnly;
  writeFileSync(file, JSON.stringify(old));
  expect(new TabsStore(file).readOnly(p)).toBeNull();
  expect(new TabsStore(file).readOnly('/other')).toBeNull();
});

// POSIX: POSIX project-root fixtures.
posixTest('the store forgets the projects used longest ago, and survives a corrupt file', () => {
  const file = join(base, 'tabs.json');
  let now = 0;
  const s = new TabsStore(file, () => ++now);
  for (let i = 0; i <= MAX_TAB_PROJECTS; i++) s.set(`/p${i}`, { files: [], order: [], active: null });
  const again = new TabsStore(file);
  expect(again.get('/p0')).toBeNull();
  expect(again.get(`/p${MAX_TAB_PROJECTS}`)).not.toBeNull();
  writeFileSync(file, '{nope');
  const fresh = new TabsStore(file);
  expect(fresh.get('/p1')).toBeNull();
  fresh.set('/q', { files: [], order: [], active: null });
  expect(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { projects: object }).projects)).toEqual(['/q']);
});
