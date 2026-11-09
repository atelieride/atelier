import { describe, expect, test, vi } from 'vitest';
import type { AppIcon, RuntimeIcon } from '@shared/app-icon';
import { createAppIcon, type AppIconDeps, type AppIconMark } from './app-icon';

const BUNDLE = '/Applications/Atelier.app';
const OTHER = '/Users/me/Applications/Atelier.app';
/** What our Docsy icon's resource fork hashes to on the fake Mac; any other print is someone else's icon. */
const OURS = 'print-docsy';
const THEIRS = 'print-theirs';

/** A fake Mac: the Dock's icon, the bundle's custom icon (its print), the marks; bundle writes wait until released. */
function fakeMac(o: {
  packaged?: boolean; bundle?: string | null; uninstalled?: string | null; print?: string | null; marks?: Record<string, AppIconMark>;
  manual?: boolean; fail?: boolean; dockFails?: boolean | RuntimeIcon; markFails?: boolean;
} = {}) {
  const calls: string[] = [];
  let print = o.print ?? null;
  const marks: Record<string, AppIconMark> = { ...o.marks };
  const waiting: (() => void)[] = [];
  const deps: AppIconDeps = {
    packaged: o.packaged ?? true,
    bundle: o.bundle === undefined ? BUNDLE : o.bundle,
    uninstalled: o.uninstalled ?? null,
    setDockIcon: (icon: RuntimeIcon) => { calls.push(`dock:${icon}`); return !(o.dockFails === true || o.dockFails === icon); },
    customIcon: () => print,
    setBundleIcon: (_bundle: string, icon: AppIcon | null) => {
      calls.push(`bundle:${icon ?? 'reset'}`);
      const finish = () => { if (!o.fail) print = icon ? OURS : null; };
      if (!o.manual) { finish(); return o.fail ? Promise.reject(new Error('osascript failed')) : Promise.resolve(); }
      return new Promise<void>((done, fail) => waiting.push(() => { finish(); if (o.fail) fail(new Error('osascript failed')); else done(); }));
    },
    readMarks: () => ({ ...marks }),
    writeMark: (bundle, mark) => {
      if (o.markFails) throw new Error('ENOSPC: no space left on device');
      if (mark) marks[bundle] = mark; else delete marks[bundle];
      calls.push(`mark:${mark ? mark.print : 'clear'}`);
    },
    log: vi.fn(),
    error: vi.fn()
  };
  return { deps, calls, marks: () => marks, print: () => print, release: () => waiting.shift()?.() };
}

describe('start (before ready): the Dock icon from the saved theme', () => {
  test('packaged, Docsy: the Docsy image at once; Aurora: nothing to do (the bundle\'s icon is already there)', () => {
    const docsy = fakeMac();
    createAppIcon(docsy.deps).start('docsy-night');
    expect(docsy.calls).toEqual(['dock:docsy']);
    const aurora = fakeMac();
    createAppIcon(aurora.deps).start('aurora');
    expect(aurora.calls).toEqual([]);
  });
  test('development: the dev icon for other themes (Electron\'s would show), the Docsy image for Docsy', () => {
    const dev = fakeMac({ packaged: false, bundle: null });
    createAppIcon(dev.deps).start('tide');
    expect(dev.calls).toEqual(['dock:dev']);
    const devDocsy = fakeMac({ packaged: false, bundle: null });
    createAppIcon(devDocsy.deps).start('docsy');
    expect(devDocsy.calls).toEqual(['dock:docsy']);
  });
  test('the user\'s own custom icon on the bundle: the Dock keeps it even with Docsy', () => {
    const mac = fakeMac({ print: THEIRS });
    createAppIcon(mac.deps).start('docsy');
    expect(mac.calls).toEqual([]);
  });
  test('a Dock icon that could not be set is not taken as set: the next change tries again', async () => {
    const mac = fakeMac({ dockFails: true, bundle: null });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.themeChanged('docsy-night');
    await icon.themeChanged('aurora');
    await icon.themeChanged('docsy');
    expect(mac.calls).toEqual(['dock:docsy', 'dock:aurora', 'dock:bundle', 'dock:docsy']);
    // Never recorded as on: going to Docsy again asks again.
    const off = fakeMac({ dockFails: true, bundle: null });
    const again = createAppIcon(off.deps);
    again.start('aurora');
    await again.themeChanged('docsy');
    expect(off.calls).toEqual(['dock:docsy']);
  });
});

describe('ready: the Dock icon asked again once the app is up, then the bundle reconciled', () => {
  test('a Docsy or dev icon is set again (AppKit may reload the bundle\'s at launch); the bundle\'s own is not', async () => {
    const docsy = fakeMac({ print: OURS, marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
    const a = createAppIcon(docsy.deps);
    a.start('docsy');
    await a.ready();
    expect(docsy.calls).toEqual(['dock:docsy', 'dock:docsy']);
    const dev = fakeMac({ packaged: false, bundle: null });
    const b = createAppIcon(dev.deps);
    b.start('aurora');
    await b.ready();
    expect(dev.calls).toEqual(['dock:dev', 'dock:dev']);
    const aurora = fakeMac();
    const c = createAppIcon(aurora.deps);
    c.start('aurora');
    await c.ready();
    expect(aurora.calls).toEqual([]);
  });
  test('Docsy on a fresh bundle: the Dock, again after ready, then the bundle\'s icon and its mark with the print', async () => {
    const mac = fakeMac();
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.ready();
    expect(mac.calls).toEqual(['dock:docsy', 'dock:docsy', 'bundle:docsy', `mark:${OURS}`]);
    expect(mac.marks()).toEqual({ [BUNDLE]: { icon: 'docsy', print: OURS } });
  });
  test('a packaged app outside /Applications on Docsy: one notice that only the Dock follows, never a write', async () => {
    const mac = fakeMac({ bundle: null, uninstalled: '/Users/me/Downloads/Atelier.app' });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.ready();
    await icon.reconcile();
    expect(mac.deps.error).toHaveBeenCalledTimes(1);
    expect(mac.deps.error).toHaveBeenCalledWith(expect.stringContaining('/Users/me/Downloads/Atelier.app is not in /Applications'));
    expect(mac.deps.log).toHaveBeenCalledWith({ bundle: 'ineligible' });
    const aurora = fakeMac({ bundle: null, uninstalled: '/Users/me/Downloads/Atelier.app' });
    const quiet = createAppIcon(aurora.deps);
    quiet.start('aurora');
    await quiet.ready();
    expect(aurora.deps.error).not.toHaveBeenCalled();
  });
});

describe('reconcile: the bundle\'s icon matches the theme', () => {
  test('Docsy on a bundle without an icon (first time, or fresh after an update): set it, then the mark', async () => {
    const mac = fakeMac({ marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.reconcile();
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:docsy', `mark:${OURS}`]);
  });
  test('Docsy with ours already on: nothing', async () => {
    const mac = fakeMac({ print: OURS, marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.reconcile();
    expect(mac.calls).toEqual(['dock:docsy']);
  });
  test('Aurora with ours left on: reset, clear the mark, and the Dock gets the Aurora image (the launch loaded Docsy\'s)', async () => {
    const mac = fakeMac({ print: OURS, marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
    const icon = createAppIcon(mac.deps);
    icon.start('aurora');
    await icon.reconcile();
    expect(mac.calls).toEqual(['bundle:reset', 'mark:clear', 'dock:aurora']);
  });
  test('the user\'s own icon is never touched, whatever the theme', async () => {
    for (const theme of ['docsy', 'aurora'] as const) {
      const mac = fakeMac({ print: THEIRS });
      const icon = createAppIcon(mac.deps);
      icon.start(theme);
      await icon.reconcile();
      expect(mac.calls.filter((c) => !c.startsWith('dock:'))).toEqual([]);
    }
  });
  test('the user pasted their own icon over ours: theirs now, kept on Aurora, and the Dock follows it', async () => {
    for (const theme of ['docsy', 'aurora'] as const) {
      const mac = fakeMac({ print: THEIRS, marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
      const icon = createAppIcon(mac.deps);
      icon.start(theme);
      await icon.ready();
      expect(mac.calls, theme).toEqual([]);
      expect(mac.print()).toBe(THEIRS);
    }
  });
  test('two installed copies keep a mark each: one copy\'s write leaves the other\'s mark alone', async () => {
    const mac = fakeMac({ marks: { [OTHER]: { icon: 'docsy', print: OURS } } });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.reconcile();
    expect(mac.marks()).toEqual({ [OTHER]: { icon: 'docsy', print: OURS }, [BUNDLE]: { icon: 'docsy', print: OURS } });
    // Another copy's mark never makes this copy's icon ours.
    const theirs = fakeMac({ print: THEIRS, marks: { [OTHER]: { icon: 'docsy', print: THEIRS } } });
    const other = createAppIcon(theirs.deps);
    other.start('aurora');
    await other.reconcile();
    expect(theirs.calls).toEqual([]);
  });
  test('no eligible bundle (development, release/, a temp copy): never a bundle write, never a mark', async () => {
    const mac = fakeMac({ bundle: null });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.reconcile();
    await icon.themeChanged('aurora');
    expect(mac.calls).toEqual(['dock:docsy', 'dock:aurora']);
    expect(mac.deps.log).toHaveBeenCalledWith({ bundle: 'ineligible' });
  });
  test('a failed write is logged and leaves the marks as they were; the Dock keeps the Docsy image', async () => {
    const mac = fakeMac({ fail: true });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.reconcile();
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:docsy']);
    expect(mac.marks()).toEqual({});
    expect(mac.deps.error).toHaveBeenCalledWith(expect.stringContaining('osascript failed'));
  });
  test('a mark that cannot be written (disk full) is logged, never an unhandled rejection', async () => {
    const mac = fakeMac({ markFails: true });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await expect(icon.reconcile()).resolves.toBeUndefined();
    expect(mac.deps.error).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
  });
});

describe('themeChanged: the order keeps the Dock right at every moment', () => {
  test('to Docsy: the Dock first (at once), then the bundle', async () => {
    const mac = fakeMac({ manual: true });
    const icon = createAppIcon(mac.deps);
    icon.start('aurora');
    const done = icon.themeChanged('docsy');
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:docsy']);
    mac.release();
    await done;
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:docsy', `mark:${OURS}`]);
  });
  test('back to Aurora: the bundle\'s icon removed first, then the Aurora image in the Dock (null would bring back a stale Docsy)', async () => {
    const mac = fakeMac({ manual: true, print: OURS, marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    const done = icon.themeChanged('ember');
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:reset']);
    mac.release();
    await done;
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:reset', 'mark:clear', 'dock:aurora']);
  });
  test('back to Aurora but the bundle\'s icon could not be removed: the Dock stays on Docsy, like Finder', async () => {
    const mac = fakeMac({ fail: true, print: OURS, marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.themeChanged('aurora');
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:reset']);
  });
  test('back to Aurora but its image could not be set: the bundle\'s own icon at least (as before), and the next change asks again', async () => {
    const mac = fakeMac({ dockFails: 'aurora', print: OURS, marks: { [BUNDLE]: { icon: 'docsy', print: OURS } } });
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.themeChanged('aurora');
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:reset', 'mark:clear', 'dock:aurora', 'dock:bundle']);
    await icon.themeChanged('docsy');
    expect(mac.calls.slice(5)).toEqual(['dock:docsy', 'bundle:docsy', `mark:${OURS}`]);
  });
  test('quick changes ending on Aurora: the bundle\'s write finishes, it is reset, and the Dock ends on Aurora\'s image', async () => {
    const mac = fakeMac({ manual: true });
    const icon = createAppIcon(mac.deps);
    icon.start('aurora');
    const a = icon.themeChanged('docsy');
    const b = icon.themeChanged('aurora');
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:docsy']);
    mac.release();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    mac.release();
    await Promise.all([a, b]);
    expect(mac.calls).toEqual(['dock:docsy', 'bundle:docsy', `mark:${OURS}`, 'bundle:reset', 'mark:clear', 'dock:aurora']);
    expect(mac.print()).toBeNull();
  });
  test('Docsy ↔ Docsy Night, Aurora ↔ Tide: the icon is the same, nothing runs', async () => {
    const mac = fakeMac();
    const icon = createAppIcon(mac.deps);
    icon.start('docsy');
    await icon.reconcile();
    mac.calls.length = 0;
    await icon.themeChanged('docsy-night');
    await icon.themeChanged('docsy');
    expect(mac.calls).toEqual([]);
    await icon.themeChanged('aurora');
    mac.calls.length = 0;
    await icon.themeChanged('tide');
    expect(mac.calls).toEqual([]);
  });
  test('Aurora at launch keeps the system\'s own icon; once Docsy came and went, Aurora is the image, both ways', async () => {
    const mac = fakeMac();
    const icon = createAppIcon(mac.deps);
    icon.start('aurora');
    await icon.ready();
    await icon.themeChanged('tide');
    expect(mac.calls).toEqual([]);
    await icon.themeChanged('docsy');
    await icon.themeChanged('aurora');
    await icon.themeChanged('docsy-night');
    await icon.themeChanged('ember');
    expect(mac.calls).toEqual([
      'dock:docsy', 'bundle:docsy', `mark:${OURS}`,
      'bundle:reset', 'mark:clear', 'dock:aurora',
      'dock:docsy', 'bundle:docsy', `mark:${OURS}`,
      'bundle:reset', 'mark:clear', 'dock:aurora'
    ]);
  });
  test('quick changes: one bundle write at a time, and the last theme wins', async () => {
    const mac = fakeMac({ manual: true });
    const icon = createAppIcon(mac.deps);
    icon.start('aurora');
    const a = icon.themeChanged('docsy');
    const b = icon.themeChanged('aurora');
    const c = icon.themeChanged('docsy');
    expect(mac.calls.filter((x) => x.startsWith('bundle:'))).toEqual(['bundle:docsy']);
    mac.release();
    await Promise.all([a, b, c]);
    // The first write finished as Docsy; the queued checks found Docsy wanted and on: nothing more to write.
    expect(mac.calls.filter((x) => x.startsWith('bundle:'))).toEqual(['bundle:docsy']);
    expect(mac.print()).toBe(OURS);
    expect(mac.calls.at(-1)).not.toMatch(/^dock:(bundle|aurora)$/);
  });
});
