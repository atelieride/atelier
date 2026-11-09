import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toOut } from './cpath';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OpenPathsEvent } from '@shared/files';
import { GrantStore } from './fs/grants';
import { OPEN_FILE_BATCH_MS, Opener, type OpenHost, type OpenWin } from './open-ipc';
import { useMachinePlatform } from '../../tests/support/platform';

// Real files with native paths: the app's platform switch reads the machine's (win32 on Windows).
useMachinePlatform();

interface FakeWin extends OpenWin { sent: OpenPathsEvent[] }
const win = (id: number): FakeWin => {
  const sent: OpenPathsEvent[] = [];
  return { sent, isDestroyed: () => false, webContents: { id, send: (_c: string, ev: unknown) => { sent.push(ev as OpenPathsEvent); } } };
};

let p: string;
let q: string;
let out: string;
let wins: Map<number, FakeWin>;
let roots: Map<number, string | null>;
let focus: Map<number, number>;
let opened: { root: string; replacing: number | null }[];
let revealed: number[];
let recent: string[];
let host: OpenHost<FakeWin>;

beforeEach(() => {
  const base = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-open-'))));
  p = join(base, 'p'); q = join(base, 'q'); out = join(base, 'out');
  for (const d of [p, join(p, 'src'), q, out, join(out, 'proj')]) mkdirSync(d);
  writeFileSync(join(p, 'src', 'a.ts'), '');
  writeFileSync(join(q, 'b.ts'), '');
  writeFileSync(join(out, 'x.json'), '');
  wins = new Map(); roots = new Map(); focus = new Map(); opened = []; revealed = []; recent = [];
  host = {
    grants: new GrantStore(),
    projectOf: (id) => roots.get(id) ?? null,
    isTrusted: () => true,
    openProject: (root, replacing) => {
      opened.push({ root, replacing: replacing?.webContents.id ?? null });
      // Like openWindow: one window per folder.
      const existing = [...roots].find(([, r]) => r === root);
      if (existing) return wins.get(existing[0])!;
      const id = 100 + opened.length;
      const w = win(id);
      wins.set(id, w); roots.set(id, root); focus.set(id, Date.now());
      return w;
    },
    reveal: (w) => { revealed.push(w.webContents.id); },
    windows: () => [...roots].map(([id, root]) => ({ id, root, focusedAt: focus.get(id) ?? 0 })),
    recent: () => recent,
    window: (id) => wins.get(id) ?? null,
    welcome: () => { const w = win(99); wins.set(99, w); roots.set(99, null); return w; },
    home: '/nowhere'
  };
});
afterEach(() => { vi.useRealTimers(); });

const addWin = (id: number, root: string | null, focusedAt = id) => { const w = win(id); wins.set(id, w); roots.set(id, root); focus.set(id, focusedAt); return w; };

describe('Opener.openIn', () => {
  test('events wait until the page listens, then come in order', () => {
    const o = new Opener(host);
    const w = addWin(1, p);
    o.openIn(w, [join(p, 'src', 'a.ts')]);
    expect(w.sent).toEqual([]);
    const held = o.takePending(1);
    expect(held).toHaveLength(1);
    expect(held[0]!.files).toEqual([{ path: join(p, 'src', 'a.ts'), rel: 'src/a.ts', external: false }]);
    o.openIn(w, [join(out, 'x.json')]);
    expect(w.sent[0]!.files).toEqual([{ path: join(out, 'x.json'), rel: join(out, 'x.json'), external: true }]);
    expect(host.grants.has(p, join(out, 'x.json'))).toBe(true);
  });

  test('outside files are watched as soon as they open, not only once the tabs are saved', () => {
    const watched: [string, string[]][] = [];
    const o = new Opener({ ...host, opened: (root, files) => { watched.push([root, files]); } });
    o.openIn(addWin(1, p), [join(p, 'src', 'a.ts'), join(out, 'x.json')]);
    expect(watched).toEqual([[p, [join(out, 'x.json')]]]);
    o.openIn(addWin(2, q), [join(q, 'b.ts')]);
    expect(watched).toHaveLength(1);
  });

  test('an outside folder opens as a project; from the Welcome window it takes its place', () => {
    const o = new Opener(host);
    o.openIn(addWin(1, p), [join(out, 'proj')]);
    o.openIn(addWin(2, null), [join(out, 'proj')]);
    expect(opened).toEqual([{ root: join(out, 'proj'), replacing: null }, { root: join(out, 'proj'), replacing: 2 }]);
  });

  test('what arrives while a page reloads waits for it, not lost', () => {
    const o = new Opener(host);
    const w = addWin(1, p);
    o.takePending(1);
    o.openIn(w, [join(p, 'src', 'a.ts')]);
    expect(w.sent).toHaveLength(1);
    o.pageLoading(1);
    o.openIn(w, [join(out, 'x.json')]);
    o.pageLoading(1);
    expect(w.sent).toHaveLength(1);
    expect(o.takePending(1).map((e) => e.files[0]!.rel)).toEqual([join(out, 'x.json')]);
  });

  test('a reloaded page asks again: nothing held is lost or sent twice', () => {
    const o = new Opener(host);
    const w = addWin(1, p);
    o.takePending(1);
    o.forget(1);
    o.openIn(w, [join(p, 'src', 'a.ts')]);
    expect(w.sent).toEqual([]);
    expect(o.takePending(1)).toHaveLength(1);
    expect(o.takePending(1)).toEqual([]);
  });

  test("paths dropped on a pop-out open in its project's window, brought forward", () => {
    const watched: [string, string[]][] = [];
    // 1: the project window; 2: one of its pop-outs (same project, its page never asks for paths); 3: an orphan pop-out.
    const o = new Opener({ ...host, opened: (root, files) => { watched.push([root, files]); }, targetOf: (w) => (w.webContents.id === 2 ? wins.get(1)! : w.webContents.id === 3 ? null : w) });
    const main = addWin(1, p);
    const pop = addWin(2, p);
    o.takePending(1);
    expect(o.openIn(pop, [join(p, 'src', 'a.ts'), join(out, 'x.json')])).toBe(true);
    expect(pop.sent).toEqual([]);
    expect(o.takePending(2)).toEqual([]);
    expect(main.sent.map((e) => e.files.map((f) => f.path))).toEqual([[join(p, 'src', 'a.ts'), join(out, 'x.json')]]);
    expect(revealed).toEqual([1]);
    expect(host.grants.has(p, join(out, 'x.json'))).toBe(true);
    expect(watched).toEqual([[p, [join(out, 'x.json')]]]);
    // A pop-out whose project window is gone: nothing is granted, watched or sent.
    const orphan = addWin(3, q);
    expect(o.openIn(orphan, [join(out, 'x.json')])).toBe(false);
    expect(host.grants.has(q, join(out, 'x.json'))).toBe(false);
    expect(watched).toHaveLength(1);
    // A project window opens in itself and is not raised (as before).
    o.openIn(main, [join(p, 'src', 'a.ts')]);
    expect(revealed).toEqual([1]);
  });

});

describe('Opener.openLinked (a path a pop-out names: a link, a path in its terminal)', () => {
  const setupLinked = () => {
    const watched: [string, string[]][] = [];
    const o = new Opener({ ...host, opened: (root, files) => { watched.push([root, files]); }, targetOf: (w) => (w.webContents.id === 2 ? wins.get(1)! : w.webContents.id === 3 ? null : w) });
    const main = addWin(1, p);
    const pop = addWin(2, p);
    o.takePending(1);
    return { o, main, pop, watched };
  };

  test('a file in the project opens in the project window at its line, brought forward', () => {
    const { o, main, pop } = setupLinked();
    expect(o.openLinked(pop, join(p, 'src', 'a.ts'), 42)).toBe(true);
    expect(main.sent).toEqual([{ files: [{ path: join(p, 'src', 'a.ts'), rel: 'src/a.ts', external: false, line: 42 }], reveal: null, skipped: 0, capped: null, needsProject: 0 }]);
    expect(pop.sent).toEqual([]);
    expect(revealed).toEqual([1]);
    // Without a line: none on the entry.
    o.openLinked(pop, join(p, 'src', 'a.ts'));
    expect(main.sent[1]!.files[0]!.line).toBeUndefined();
  });

  test('an outside file the page names is never granted: nothing opens, nothing is watched', () => {
    const { o, main, pop, watched } = setupLinked();
    expect(o.openLinked(pop, join(out, 'x.json'), 1)).toBe(false);
    expect(host.grants.has(p, join(out, 'x.json'))).toBe(false);
    expect(main.sent).toEqual([]);
    expect(watched).toEqual([]);
    expect(revealed).toEqual([]);
  });

  test('an outside file already granted to the project opens (with its line) and stays watched', () => {
    const { o, main, pop, watched } = setupLinked();
    host.grants.grant(p, join(out, 'x.json'));
    expect(o.openLinked(pop, join(out, 'x.json'), 7)).toBe(true);
    expect(main.sent[0]!.files).toEqual([{ path: join(out, 'x.json'), rel: join(out, 'x.json'), external: true, line: 7 }]);
    expect(watched).toEqual([[p, [join(out, 'x.json')]]]);
    expect(revealed).toEqual([1]);
  });

  test('a folder never opens a project nor reveals anything; a missing path opens nothing', () => {
    const { o, main, pop } = setupLinked();
    expect(o.openLinked(pop, join(out, 'proj'))).toBe(false);
    expect(o.openLinked(pop, join(p, 'src'))).toBe(false);
    expect(o.openLinked(pop, join(p, 'nope.ts'))).toBe(false);
    expect(opened).toEqual([]);
    expect(main.sent).toEqual([]);
    expect(revealed).toEqual([]);
  });

  test('a pop-out whose project window is gone opens nothing', () => {
    const { o } = setupLinked();
    const orphan = addWin(3, p);
    expect(o.openLinked(orphan, join(p, 'src', 'a.ts'))).toBe(false);
    expect(revealed).toEqual([]);
  });
});

describe('Opener.openFromSystem (macOS open-file)', () => {
  test('held until the app started, then routed to the window holding the file', () => {
    const o = new Opener(host);
    o.openFromSystem(join(q, 'b.ts'));
    const wp = addWin(1, p, 5);
    const wq = addWin(2, q, 1);
    o.takePending(1); o.takePending(2);
    expect(wq.sent).toEqual([]);
    o.appStarted();
    expect(wq.sent[0]!.files[0]).toMatchObject({ rel: 'b.ts', external: false });
    expect(wp.sent).toEqual([]);
    expect(revealed).toEqual([2]);
  });

  test('a burst of files is gathered into one event', () => {
    vi.useFakeTimers();
    const o = new Opener(host);
    const w = addWin(1, p);
    o.takePending(1);
    o.appStarted();
    o.openFromSystem(join(p, 'src', 'a.ts'));
    o.openFromSystem(join(out, 'x.json'));
    expect(w.sent).toEqual([]);
    vi.advanceTimersByTime(OPEN_FILE_BATCH_MS);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.files.map((f) => f.external)).toEqual([false, true]);
  });

  test('no project window: the recent project holding the file opens and gets it once its page listens', () => {
    recent = [q, p];
    const o = new Opener(host);
    o.appStarted();
    vi.useFakeTimers();
    o.openFromSystem(join(p, 'src', 'a.ts'));
    vi.advanceTimersByTime(OPEN_FILE_BATCH_MS);
    expect(opened).toEqual([{ root: p, replacing: null }]);
    expect(o.takePending(101)[0]!.files[0]).toMatchObject({ rel: 'src/a.ts' });
  });

  test('only the Welcome window: the recent project takes its place', () => {
    recent = [p];
    addWin(5, null);
    const o = new Opener(host);
    o.openFromSystem(join(p, 'src', 'a.ts'));
    o.appStarted();
    expect(opened).toEqual([{ root: p, replacing: 5 }]);
  });

  test('a folder reached through a link opens as the real folder (one window per folder)', () => {
    symlinkSync(join(out, 'proj'), join(out, 'proj-link'));
    const o = new Opener(host);
    o.openIn(addWin(1, p), [join(out, 'proj-link')]);
    expect(opened).toEqual([{ root: join(out, 'proj'), replacing: null }]);
  });

  test('nothing at all: the Welcome window says a project is needed', () => {
    const o = new Opener(host);
    o.openFromSystem(join(out, 'x.json'));
    o.appStarted();
    expect(o.takePending(99)).toEqual([{ files: [], reveal: null, skipped: 0, capped: null, needsProject: 1 }]);
  });

  test('a folder: its own window comes forward; inside an open project it is revealed; else it opens as a project', () => {
    const o = new Opener(host);
    addWin(1, p);
    o.takePending(1);
    o.appStarted();
    vi.useFakeTimers();
    o.openFromSystem(p);
    vi.advanceTimersByTime(OPEN_FILE_BATCH_MS);
    expect(opened.map((x) => x.root)).toEqual([p]);
    o.openFromSystem(join(p, 'src'));
    vi.advanceTimersByTime(OPEN_FILE_BATCH_MS);
    expect(wins.get(1)!.sent.at(-1)).toMatchObject({ reveal: join(p, 'src') });
    expect(revealed.at(-1)).toBe(1);
    o.openFromSystem(join(out, 'proj'));
    vi.advanceTimersByTime(OPEN_FILE_BATCH_MS);
    expect(opened.map((x) => x.root)).toEqual([p, join(out, 'proj')]);
  });
});

describe('Opener.saveAsAt (Save As at the path the save panel returned)', () => {
  const trashed: string[] = [];
  const trash = async (x: string) => { trashed.push(x); renameSync(x, `${x}.trashed`); };
  beforeEach(() => { trashed.length = 0; });

  test('outside the project: a new file, granted for editing, watched at once, labelled from the home', async () => {
    const watched: [string, string[]][] = [];
    host.opened = (root, files) => { watched.push([root, files]); };
    host.home = out;
    const o = new Opener(host);
    addWin(1, p);
    const f = join(out, 'notes.md');
    expect(await o.saveAsAt(1, f, '# hi\n', trash)).toEqual({ path: f, rel: '~/notes.md' });
    expect(readFileSync(f, 'utf8')).toBe('# hi\n');
    expect(host.grants.mode(p, f)).toBe('edit');
    expect(watched).toEqual([[p, [f]]]);
    expect(trashed).toEqual([]);
  });

  test('outside, over a file the panel said to replace: that file to the Trash first', async () => {
    const o = new Opener(host);
    addWin(1, p);
    const f = join(out, 'x.json');
    expect(await o.saveAsAt(1, f, '{}\n', trash)).toMatchObject({ path: f });
    expect(trashed).toEqual([f]);
    expect(readFileSync(f, 'utf8')).toBe('{}\n');
  });

  test('inside the project: a project file (nothing granted), its project-relative name; a file there to the Trash first', async () => {
    const o = new Opener(host);
    addWin(1, p);
    expect(await o.saveAsAt(1, join(p, 'src', 'new.ts'), 'n\n', trash)).toEqual({ path: join(p, 'src', 'new.ts'), rel: 'src/new.ts' });
    expect(host.grants.has(p, join(p, 'src', 'new.ts'))).toBe(false);
    expect(await o.saveAsAt(1, join(p, 'src', 'a.ts'), 'a\n', trash)).toEqual({ path: join(p, 'src', 'a.ts'), rel: 'src/a.ts' });
    expect(trashed).toEqual([join(p, 'src', 'a.ts')]);
    expect(readFileSync(join(p, 'src', 'a.ts'), 'utf8')).toBe('a\n');
  });

  test('never inside .git, never over a folder: nothing trashed then', async () => {
    const o = new Opener(host);
    addWin(1, p);
    mkdirSync(join(p, '.git'));
    writeFileSync(join(p, '.git', 'config'), '[core]\n');
    expect(await o.saveAsAt(1, join(p, '.git', 'config'), 'x', trash)).toEqual({ error: 'in-git' });
    expect(await o.saveAsAt(1, join(p, 'src'), 'x', trash)).toEqual({ error: 'not-a-file' });
    expect(await o.saveAsAt(1, join(out, 'proj'), 'x', trash)).toEqual({ error: 'not-a-file' });
    expect(trashed).toEqual([]);
    expect(readFileSync(join(p, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  test('a window with no project saves nothing', async () => {
    const o = new Opener(host);
    addWin(1, null);
    expect(await o.saveAsAt(1, join(out, 'n.md'), 'x', trash)).toEqual({ error: 'failed' });
    expect(existsSync(join(out, 'n.md'))).toBe(false);
  });

  test('inside the project, what it writes and trashes is the app\'s, never a Bash command\'s running meanwhile', async () => {
    const wrote: string[] = [];
    host.wrote = (x) => { wrote.push(x); };
    const o = new Opener(host);
    addWin(1, p);
    await o.saveAsAt(1, join(p, 'src', 'a.ts'), 'a\n', trash);
    await o.saveAsAt(1, join(out, 'outside.md'), 'o\n', trash);
    expect(wrote).toEqual([join(p, 'src', 'a.ts'), join(p, 'src', 'a.ts')]);
  });

  test('refused before anything goes to the Trash: too large once encoded, a file open with unsaved edits', async () => {
    const o = new Opener(host);
    addWin(1, p);
    // 5 MB in characters is more in bytes: "è" takes two.
    expect(await o.saveAsAt(1, join(p, 'src', 'a.ts'), 'è'.repeat(3 * 1024 * 1024), trash)).toEqual({ error: 'too-large' });
    expect(await o.saveAsAt(1, join(out, 'x.json'), 'è'.repeat(3 * 1024 * 1024), trash)).toEqual({ error: 'too-large' });
    expect(await o.saveAsAt(1, join(p, 'src', 'a.ts'), 'mine', trash, [join(p, 'src', 'a.ts')])).toEqual({ error: 'unsaved' });
    expect(await o.saveAsAt(1, join(out, 'x.json'), 'mine', trash, [join(out, 'x.json')])).toEqual({ error: 'unsaved' });
    expect(trashed).toEqual([]);
    expect(readFileSync(join(p, 'src', 'a.ts'), 'utf8')).toBe('');
    // A new name is never someone's unsaved tab.
    expect(await o.saveAsAt(1, join(out, 'new.json'), 'mine', trash, [join(out, 'x.json')])).toMatchObject({ path: join(out, 'new.json') });
  });
});

describe('Opener.saveAsFromPanel (the save panel\'s answer)', () => {
  const trash = async () => { throw new Error('nothing to trash'); };

  test('canceled: nothing; a path Atelier can\'t use (a network share on Windows): says so; the panel opens on the window\'s last folder, the name only a name', async () => {
    const o = new Opener(host);
    addWin(1, p);
    const asked: string[] = [];
    const answer = (x: string | null) => async (d: string) => { asked.push(d); return x; };
    expect(await o.saveAsFromPanel(1, { name: '../../etc/notes.md', text: 'x', unsaved: [] }, answer(null), trash)).toEqual({ canceled: true });
    expect(await o.saveAsFromPanel(1, { name: '', text: 'x', unsaved: [] }, answer('server/share/n.md'), trash)).toEqual({ error: 'unsupported-path' });
    expect(await o.saveAsFromPanel(1, { name: 'n.md', text: 'x', unsaved: [] }, answer(join(out, 'n.md')), trash)).toMatchObject({ path: join(out, 'n.md') });
    await o.saveAsFromPanel(1, { name: 'm.md', text: 'x', unsaved: [] }, answer(null), trash);
    expect(asked).toEqual(['notes.md', 'Untitled', 'n.md', join(out, 'm.md')]);
  });
});
