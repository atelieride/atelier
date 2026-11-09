import { expect, test } from 'vitest';
import { argvPaths, badgeBitmap, JumpListFeed, jumpList, networkRoot, revealArg } from './win-shell';

// Atelier in Windows' shell: the taskbar's overlay badge, the Jump List (the Dock menu's twin),
// files and folders handed over by File Explorer.

test('the overlay badge: an amber dot, transparent around it (BGRA, as Windows wants the bitmap)', () => {
  const b = badgeBitmap(16);
  expect(b.length).toBe(16 * 16 * 4);
  const px = (x: number, y: number) => [...b.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
  expect(px(8, 8)).toEqual([0x24, 0xBF, 0xFB, 255]);
  expect(px(0, 0)[3]).toBe(0);
  // Premultiplied, as Skia reads it: an edge pixel's colour never exceeds its alpha.
  for (let i = 0; i < b.length; i += 4) if (b[i + 3]! > 0 && b[i + 3]! < 255) expect(Math.max(b[i]!, b[i + 1]!, b[i + 2]!)).toBeLessThanOrEqual(b[i + 3]!);
});

test('the Jump List: sessions waiting first, then recent projects; each opens through a second instance', () => {
  const list = jumpList({
    exe: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe',
    waiting: [{ id: 't1', label: 'Fix login · api' }],
    recents: ['C:/dev/api', 'C:/Users/m/web'],
    newWindow: 'New Window'
  });
  expect(list).toEqual([
    { type: 'custom', name: 'Waiting for you', items: [{ type: 'task', title: 'Fix login · api', program: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', args: '--reveal=t1', iconPath: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', iconIndex: 0 }] },
    { type: 'custom', name: 'Recent projects', items: [
      { type: 'task', title: 'api', description: 'C:\\dev\\api', program: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', args: '--project="C:/dev/api"', iconPath: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', iconIndex: 0 },
      { type: 'task', title: 'web', description: 'C:\\Users\\m\\web', program: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', args: '--project="C:/Users/m/web"', iconPath: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', iconIndex: 0 }
    ] },
    { type: 'tasks', items: [{ type: 'task', title: 'New Window', program: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', args: '--new-window', iconPath: 'C:\\Program Files\\WindowsApps\\A\\Atelier.exe', iconIndex: 0 }] }
  ]);
  // A drive root: named by its path, and no `\"` on the command line (Windows would read the quote as part of the path).
  const root = jumpList({ exe: 'A.exe', waiting: [], recents: ['D:/'], newWindow: 'New Window' })[0]!.items[0]!;
  expect([root.title, root.args]).toEqual(['D:\\', '--project="D:/"']);
  // No waiting session: no empty category.
  expect(jumpList({ exe: 'A.exe', waiting: [], recents: [], newWindow: 'New Window' }).map((c) => c.type)).toEqual(['tasks']);
});

test('a terminal id from the Jump List; anything else is no reveal', () => {
  expect(revealArg(['Atelier.exe', '--reveal=0a1b2c3d-1111-2222-3333-444455556666'])).toBe('0a1b2c3d-1111-2222-3333-444455556666');
  expect(revealArg(['Atelier.exe', '--reveal=../x'])).toBe(null);
  expect(revealArg(['Atelier.exe'])).toBe(null);
});

test('paths File Explorer hands over: the arguments after the executable (and a dev run’s app folder), no switches', () => {
  expect(argvPaths(['C:\\A\\Atelier.exe', 'C:\\dev\\api', 'C:\\dev\\api\\README.md'], true)).toEqual(['C:\\dev\\api', 'C:\\dev\\api\\README.md']);
  expect(argvPaths(['electron.exe', 'C:\\dev\\atelier', 'C:\\dev\\api'], false)).toEqual(['C:\\dev\\api']);
  expect(argvPaths(['C:\\A\\Atelier.exe', '--project=C:\\dev\\api', '--allow-file-access-from-files', 'relative.txt'], true)).toEqual([]);
});

test('a network share, WSL or device path is no project folder (Map network drive is the way); a drive path is', () => {
  for (const p of ['//server/share/proj', '\\\\server\\share', '//wsl.localhost/Ubuntu/home/m', '\\\\wsl$\\Ubuntu', '//?/C:/dev/api', '\\\\.\\C:\\x']) {
    const r = networkRoot(p);
    expect(r, p).not.toBeNull();
    expect(r!.detail).toContain('Map network drive');
    expect(`${r!.message} ${r!.detail}`).not.toMatch(/Finder|macOS|Mac\b/);
  }
  for (const p of ['C:/dev/api', 'Z:/proj', 'c:\\x']) expect(networkRoot(p), p).toBeNull();
});

test('the Jump List is set again only when what it shows changes; the recents (which stat folders) only when asked', () => {
  const sets: unknown[] = [];
  let reads = 0;
  let recents = ['C:/dev/api'];
  const feed = new JumpListFeed({ exe: 'C:\\A\\Atelier.exe', newWindow: 'New Window', recents: () => { reads++; return recents; }, set: (l) => sets.push(l) });
  feed.refreshRecents();
  expect([sets.length, reads]).toEqual([1, 1]);
  // atelierd lists its terminals every 100 ms while sessions work: the same waiting sessions change nothing.
  const waiting = [{ id: 't1', label: 'Fix login · api', kind: 'waiting', projectRoot: 'C:/dev/api' }];
  for (let i = 0; i < 50; i++) feed.setWaiting(waiting.map((w) => ({ ...w })));
  expect([sets.length, reads]).toEqual([2, 1]);
  feed.setWaiting([]);
  expect(sets.length).toBe(3);
  // A project opened (or a window focused): the recents are read again, and set only if they changed.
  feed.refreshRecents();
  expect([sets.length, reads]).toEqual([3, 2]);
  recents = ['C:/dev/web', 'C:/dev/api'];
  feed.refreshRecents();
  expect([sets.length, reads]).toEqual([4, 3]);
  expect(sets.at(-1)).toEqual(jumpList({ exe: 'C:\\A\\Atelier.exe', waiting: [], recents, newWindow: 'New Window' }));
});
