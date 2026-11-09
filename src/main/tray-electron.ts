import { Menu, Tray, nativeImage, nativeTheme, type NativeImage } from 'electron';
import type { Platform } from '@shared/platform';
import { TRAY_COLOURS, discBitmap, markBitmap, type Rgb } from './tray-icons';
import type { IconSpec, TrayHandle, TrayHost } from './tray';

// Electron's Tray behind SessionTray. Images come with their 2× bitmap: 18 pt in
// macOS's menu bar, as tall as its other icons; 16 pt in Windows' notification area.

const WHITE: Rgb = [255, 255, 255];
// Aurora's --bg-3: the Λ on a light taskbar.
const INK_LIGHT: Rgb = [0x1B, 0x1B, 0x2E];

function image(icon: IconSpec): NativeImage {
  const draw = (size: number) => {
    if ('tinted' in icon) return discBitmap(size, TRAY_COLOURS[icon.tinted]);
    const ink = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? WHITE : INK_LIGHT;
    return markBitmap(size, { ink, ...(icon.mark !== 'none' && { dot: TRAY_COLOURS[icon.mark] }) });
  };
  const pt = 'tinted' in icon ? 18 : 16;
  const img = nativeImage.createFromBitmap(draw(pt), { width: pt, height: pt, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: pt * 2, height: pt * 2, buffer: draw(pt * 2) });
  return img;
}

export function electronTrayHost(platform: Platform): TrayHost {
  const live = new Map<Tray, IconSpec>();
  // Windows' Λ follows the taskbar's theme (the dots read on both).
  nativeTheme.on('updated', () => { for (const [tray, icon] of live) if ('mark' in icon) tray.setImage(image(icon)); });
  const trays = new WeakMap<TrayHandle, Tray>();
  return {
    create(icon, events) {
      const tray = new Tray(image(icon));
      live.set(tray, icon);
      // Two quick clicks on a menu bar icon are two clicks, not a double click that drops the second.
      if (platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);
      tray.on('click', events.click);
      tray.on('right-click', events.rightClick);
      const handle: TrayHandle = {
        setImage: (i) => { live.set(tray, i); tray.setImage(image(i)); },
        setToolTip: (s) => tray.setToolTip(s),
        // A title is macOS only: the "+N" item.
        setTitle: (s) => { if (platform === 'darwin') tray.setTitle(s, { fontType: 'monospacedDigit' }); },
        destroy: () => { live.delete(tray); tray.destroy(); }
      };
      trays.set(handle, tray);
      return handle;
    },
    popUp(handle, spec) {
      trays.get(handle)?.popUpContextMenu(Menu.buildFromTemplate(spec));
    }
  };
}
