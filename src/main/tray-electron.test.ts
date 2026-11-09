import { beforeEach, expect, test, vi } from 'vitest';

// The Electron side of the tray, on a mocked Electron: what images it builds and
// how it drives Tray. No real icon is ever made.

const h = vi.hoisted(() => ({
  trays: [] as { image: unknown; guid?: string; handlers: Record<string, () => void>; calls: unknown[][] }[],
  images: [] as { bitmap: Buffer; o: unknown; reps: unknown[] }[],
  theme: { dark: true, listeners: [] as (() => void)[] },
  built: [] as unknown[]
}));

vi.mock('electron', () => {
  class Tray {
    handlers: Record<string, () => void> = {};
    calls: unknown[][] = [];
    constructor(public image: unknown, public guid?: string) { h.trays.push(this as never); }
    on(ev: string, cb: () => void) { this.handlers[ev] = cb; return this; }
    setImage(i: unknown) { this.calls.push(['setImage', i]); }
    setToolTip(s: string) { this.calls.push(['setToolTip', s]); }
    setTitle(s: string, o: unknown) { this.calls.push(['setTitle', s, o]); }
    setIgnoreDoubleClickEvents(v: boolean) { this.calls.push(['ignoreDouble', v]); }
    popUpContextMenu(m: unknown) { this.calls.push(['popUp', m]); }
    destroy() { this.calls.push(['destroy']); }
  }
  return {
    Tray,
    Menu: { buildFromTemplate: (t: unknown) => { h.built.push(t); return { template: t }; } },
    nativeImage: {
      createFromBitmap: (bitmap: Buffer, o: unknown) => { const img = { bitmap, o, reps: [] as unknown[], addRepresentation(r: unknown) { img.reps.push(r); } }; h.images.push(img); return img; }
    },
    nativeTheme: {
      get shouldUseDarkColorsForSystemIntegratedUI() { return h.theme.dark; },
      on: (_e: string, cb: () => void) => { h.theme.listeners.push(cb); }
    }
  };
});

import { electronTrayHost } from './tray-electron';

beforeEach(() => { h.trays.length = 0; h.images.length = 0; h.built.length = 0; h.theme.listeners.length = 0; h.theme.dark = true; });

const events = () => ({ click: vi.fn(), rightClick: vi.fn() });
const px = (b: Buffer, size: number, x: number, y: number) => [...b.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

test('macOS: an 18 pt image (as tall as the menu bar\'s other icons) with its 2× bitmap; clicks wired, double clicks not swallowed', () => {
  const host = electronTrayHost('darwin');
  const ev = events();
  host.create({ tinted: 'waiting' }, ev);
  const img = h.images[0]!;
  expect(img.o).toMatchObject({ width: 18, height: 18, scaleFactor: 1 });
  expect(img.reps[0]).toMatchObject({ width: 36, height: 36, scaleFactor: 2 });
  const tray = h.trays[0]!;
  expect(tray.guid).toBeUndefined();
  expect(tray.calls).toContainEqual(['ignoreDouble', true]);
  tray.handlers.click!();
  tray.handlers['right-click']!();
  expect(ev.click).toHaveBeenCalled();
  expect(ev.rightClick).toHaveBeenCalled();
});

test('macOS: Atelier\'s dark Λ on a disc in the state colour, so it reads on any wallpaper behind the menu bar', () => {
  electronTrayHost('darwin').create({ tinted: 'waiting' }, events());
  const img = h.images[0]!;
  const points = { 18: { below: [8, 14], apex: [8, 5] }, 36: { below: [17, 29], apex: [17, 10] } } as const;
  for (const [bitmap, size] of [[img.bitmap, 18], [(img.reps[0] as { buffer: Buffer }).buffer, 36]] as const) {
    const p = points[size];
    // Below the Λ, inside the disc: amber #FBBF24, opaque.
    expect(px(bitmap, size, p.below[0], p.below[1])).toEqual([0x24, 0xBF, 0xFB, 255]);
    // The Λ's apex: dark.
    const [, , r, a] = px(bitmap, size, p.apex[0], p.apex[1]);
    expect(a).toBe(255);
    expect(r!).toBeLessThan(80);
    // A corner, outside the disc: empty.
    expect(px(bitmap, size, 0, 0)[3]).toBe(0);
  }
});

test('macOS: the "+N" title in digits of equal width', () => {
  const t = electronTrayHost('darwin').create({ tinted: 'done' }, events());
  t.setTitle('+3');
  expect(h.trays[0]!.calls).toContainEqual(['setTitle', '+3', { fontType: 'monospacedDigit' }]);
});

test('Windows: made without a GUID; the Λ white on a dark taskbar, dark on a light one, redrawn when the theme changes', () => {
  const host = electronTrayHost('win32');
  host.create({ mark: 'none' }, events());
  expect(h.trays[0]!.guid).toBeUndefined();
  // Apex of the Λ at 16 px: (8, 3). Premultiplied: white has every channel at its alpha.
  const [b, g, r, a] = px(h.images[0]!.bitmap, 16, 8, 3);
  expect(a).toBeGreaterThan(0);
  expect([b, g, r]).toEqual([a, a, a]);
  h.theme.dark = false;
  for (const cb of h.theme.listeners) cb();
  const redraw = h.trays[0]!.calls.find((c) => c[0] === 'setImage')![1] as { bitmap: Buffer };
  const dark = px(redraw.bitmap, 16, 8, 3);
  expect(dark[2]!).toBeLessThan(dark[3]! * 0.3);
});

test('the menu pops up from the tray it was asked for, built from the spec', () => {
  const host = electronTrayHost('darwin');
  const t = host.create({ tinted: 'waiting' }, events());
  const click = vi.fn();
  host.popUp(t, [{ label: 'Open Session', click }, { type: 'separator' }]);
  const call = h.trays[0]!.calls.find((c) => c[0] === 'popUp')!;
  expect((call[1] as { template: unknown[] }).template).toHaveLength(2);
});

test('destroyed trays no longer follow the theme', () => {
  const host = electronTrayHost('win32');
  const t = host.create({ mark: 'waiting' }, events());
  t.destroy();
  h.theme.dark = false;
  for (const cb of h.theme.listeners) cb();
  expect(h.trays[0]!.calls.filter((c) => c[0] === 'setImage')).toEqual([]);
});
