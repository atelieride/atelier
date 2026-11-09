// Writes build/dmg/DS_Store, the DMG window's Finder layout: `node scripts/dmg-layout.mjs`.
// Local and manual (macOS asks once to let the terminal control Finder); rerun only when DMG_WINDOW or the background
// changes, then commit the file. Finder is the only writer of .DS_Store we trust, so Finder writes it: on a scratch
// image with the same names and volume as the release DMG (a stand-in app, the Applications link, the background).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMG_VOLUME, DMG_WINDOW, DMG_WINDOW_ORIGIN, createDmg, stageDmg, withAttachedDmg } from './release-ci.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build/dmg/DS_Store');
const VOLUME = `/Volumes/${DMG_VOLUME}`;
const WORK = '/private/tmp/atelier-dmg-layout';
/** Finder's bounds include the title bar; the content (the background) is DMG_WINDOW. */
const TITLE_BAR = 28;

/** The main screen's height in points (the screen with the menu bar: Finder's coordinates start there). */
function mainScreenHeight() {
  const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSScreen.screens.firstObject.frame.size.height'], { encoding: 'utf8' });
  const h = Number(r.stdout.trim());
  if (r.status !== 0 || !(h > 0)) throw new Error(`Could not read the main screen's height: ${r.stderr.trim()}`);
  return h;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Aurora's --bg-0 (#08080F) as a 16-bit RGB color: what the window shows if the picture doesn't resolve (a second
 *  mounted image is "Atelier 1"). It doesn't change the labels: Finder draws them black on any picture. */
const FALLBACK_BACKGROUND = '{2056, 2056, 3855}';

/**
 * Finder takes bounds from the top-left of the main screen and saves them from its bottom-left: the top is computed
 * from this screen's height so the saved origin is DMG_WINDOW_ORIGIN on any Mac that runs the layout.
 */
export function layoutScript({ width, height, iconSize, textSize, icons }, screenHeight) {
  const [x, bottom] = DMG_WINDOW_ORIGIN;
  const y = screenHeight - bottom - (height + TITLE_BAR);
  const bounds = `{${x}, ${y}, ${x + width}, ${y + height + TITLE_BAR}}`;
  const place = Object.entries(icons).map(([name, [ix, iy]]) => `    set position of item "${name}" of container window to {${ix}, ${iy}}`);
  // The window is looked up again after every open: a reference kept across close/open goes stale (-10006).
  const chrome = `    tell container window
      set current view to icon view
      set toolbar visible to false
      set statusbar visible to false
      set pathbar visible to false
      set sidebar width to 0
      set bounds to ${bounds}
    end tell`;
  return `tell application "Finder"
  tell disk "${DMG_VOLUME}"
    open
${chrome}
    set o to icon view options of container window
    set arrangement of o to not arranged
    set icon size of o to ${iconSize}
    set text size of o to ${textSize}
    set label position of o to bottom
    set shows item info of o to false
    set shows icon preview of o to false
    set background color of o to ${FALLBACK_BACKGROUND}
    set background picture of o to file ".background:background.tiff"
${place.join('\n')}
    -- Finder saves the window (bwsp: bounds, bars) only for a window it closes after it settled.
    delay 1
    close container window
    delay 1
    open
${chrome}
    update without registering applications
    delay 2
    close container window
  end tell
end tell
`;
}

/** Waits until Finder has written .DS_Store with the window (bwsp) and the view (icvp), and stopped touching it. */
function waitForDsStore(file) {
  let last = null;
  for (let i = 0; i < 120; i++) {
    sleep(500);
    if (!existsSync(file)) continue;
    const d = readFileSync(file);
    if (d.includes('bwsp') && d.includes('icvp') && last?.equals(d)) return d;
    last = d;
  }
  throw new Error(`Finder did not write the window into ${file} within a minute.`);
}

function main() {
  if (existsSync(VOLUME)) throw new Error(`${VOLUME} is already mounted: eject it first (Finder would lay out the wrong disk).`);
  // The background's bookmark records the scratch image's path, and the .DS_Store ships in every public DMG: a fixed,
  // neutral folder rather than the user's temp folder (/var/folders/<per-user>/…).
  if (existsSync(WORK)) throw new Error(`${WORK} exists (a previous run?): check nothing is mounted from it, remove it, rerun.`);
  mkdirSync(WORK);
  let stillAttached = false;
  try {
    // Finder keys the layout by name: an empty bundle called Atelier.app stands in for the app.
    const stub = join(WORK, 'stub/Atelier.app/Contents');
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n');
    const root = join(WORK, 'root');
    mkdirSync(root);
    stageDmg({ root, app: dirname(stub) });
    const rw = join(WORK, 'Atelier.dmg');
    createDmg(root, rw);
    // Mounted where the release DMG will be, and visible: Finder only lays out disks it shows.
    const ds = withAttachedDmg(rw, { browse: true }, (mount) => {
      if (mount !== VOLUME) throw new Error(`The scratch image mounted at ${mount}, not ${VOLUME}.`);
      const osa = spawnSync('/usr/bin/osascript', ['-'], { input: layoutScript(DMG_WINDOW, mainScreenHeight()), encoding: 'utf8' });
      if (osa.status !== 0) throw new Error(`Finder refused the layout (allow the terminal to control Finder in System Settings › Privacy & Security › Automation): ${osa.stderr.trim()}`);
      return waitForDsStore(join(mount, '.DS_Store'));
    });
    if (!ds.includes('background.tiff')) throw new Error('The .DS_Store Finder wrote does not point at the background.');
    writeFileSync(OUT, ds);
    console.log(`Wrote ${OUT} (${ds.length} bytes). Commit it with the background.`);
  } catch (e) {
    stillAttached = e?.stillAttached === true;
    throw e;
  } finally {
    if (!stillAttached) rmSync(WORK, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
