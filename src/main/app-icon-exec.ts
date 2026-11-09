import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bundleOf, eligibleBundle, type AppIcon, type RuntimeIcon } from '@shared/app-icon';
import { writeFileAtomic } from '../daemon/fsutil';
import type { AppIconDeps, AppIconMark } from './app-icon';

// The real Mac behind the app icon.
// - The Dock while Atelier runs: Electron's dock.setIcon. null gives back the bundle's own icon, but after a change macOS
//   brings back a stale copy of it: Aurora's image instead (runtimeIconFor).
// - The bundle's custom icon: NSWorkspace.setIcon through /usr/bin/osascript, one fixed JavaScript program, argv only
//   (the app's own Docsy image or "" to remove it, and the installed bundle from eligibleBundle), 10 s, 64 KB. It writes
//   `Icon\r` and the Finder flag at the bundle's root, outside the code signature's seal: a write macOS
//   attributes to Atelier on its own bundle.
// - Its print: a SHA-256 of `Icon\r`'s resource fork, where setIcon keeps the image. setIcon recreates the file every
//   time, so its dates say nothing; the same image gives the same fork, another image (a paste in Get Info) another.
// - The marks ATELIER_HOME/app-icon.json (0600, atomic): per installed bundle, the icon Atelier left and its print.

export const SET_ICON_PROGRAM = `ObjC.import('AppKit');
function run(argv) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  const image = argv[0] === '' ? $() : $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (argv[0] !== '' && image.isNil()) throw new Error('unreadable icon: ' + argv[0]);
  if (!workspace.setIconForFileOptions(image, argv[1], 0)) throw new Error('setIcon refused: ' + argv[1]);
  workspace.noteFileSystemChanged(argv[1]);
  return 'ok';
}`;

type ExecFile = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }, done: (err: Error | null, stdout: string, stderr: string) => void) => void;

export interface AppIconHost {
  packaged: boolean;
  /** The main executable's path (Electron's 'exe' path): `<bundle>/Contents/MacOS/<name>` on macOS. */
  exePath: string;
  /** The user's home (for ~/Applications). */
  userHome: string;
  /** ATELIER_HOME: where the marks live. */
  atelierHome: string;
  resourcesPath: string;
  /** The app's path: the repo in development. */
  appPath: string;
  dock: { setIcon(image: string): void } | undefined;
  log(line: Record<string, unknown>): void;
  error(message: string): void;
}

const MARK_ICONS: readonly AppIcon[] = ['docsy'];
const MAX_MARKS = 8;
/** A custom icon whose fork can't be read: a print no mark ever has, so it counts as the user's (never touched). */
const UNREADABLE = 'unreadable';

export function appIconDeps(host: AppIconHost, execFile: ExecFile = nodeExecFile as unknown as ExecFile): AppIconDeps {
  const brandPng = (name: string) => (host.packaged ? join(host.resourcesPath, name) : join(host.appPath, 'assets', 'brand', name));
  const docsyPng = brandPng('app-icon-docsy.png');
  const auroraPng = brandPng('app-icon-aurora.png');
  const devPng = join(host.appPath, 'build', 'icon.png');
  const marksFile = join(host.atelierHome, 'app-icon.json');
  const bundle = eligibleBundle({ platform: process.platform, packaged: host.packaged, exePath: host.exePath, home: host.userHome });

  const readMarks = (): Record<string, AppIconMark> => {
    try {
      const raw = (JSON.parse(readFileSync(marksFile, 'utf8')) as { bundles?: unknown } | null)?.bundles;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const marks: Record<string, AppIconMark> = {};
      for (const [path, m] of Object.entries(raw as Record<string, Partial<AppIconMark> | null>).slice(0, MAX_MARKS)) {
        if (/^\/[^\0]*\.app$/.test(path) && m && MARK_ICONS.includes(m.icon as AppIcon) && typeof m.print === 'string' && /^[0-9a-f]{64}$/.test(m.print)) {
          marks[path] = { icon: m.icon as AppIcon, print: m.print };
        }
      }
      return marks;
    } catch { return {}; }
  };

  return {
    packaged: host.packaged,
    bundle,
    uninstalled: process.platform === 'darwin' && host.packaged && !bundle ? bundleOf(host.exePath) ?? host.exePath : null,
    setDockIcon(icon: RuntimeIcon) {
      if (!host.dock) return true;
      // null resets NSApp.applicationIconImage (Electron's Browser::DockSetIcon); its typings only say string.
      const image = icon === 'docsy' ? docsyPng : icon === 'aurora' ? auroraPng : icon === 'dev' ? devPng : null;
      if (image && !existsSync(image)) {
        // The dev icon is generated on demand (scripts/render-icon.cjs): without it Electron's shows, as before.
        if (icon !== 'dev') host.error(`app icon: ${image} is missing`);
        return false;
      }
      try {
        host.dock.setIcon(image as string);
        return true;
      } catch (err) {
        if (icon !== 'dev') host.error(`app icon: the Dock refused ${image ?? 'the bundle\'s icon'}: ${(err as Error).message}`);
        return false;
      }
    },
    customIcon(b) {
      const icon = join(b, 'Icon\r');
      if (!existsSync(icon)) return null;
      try { return createHash('sha256').update(readFileSync(join(icon, '..namedfork', 'rsrc'))).digest('hex'); } catch { return UNREADABLE; }
    },
    setBundleIcon: (b, icon) => new Promise((done, fail) => {
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SET_ICON_PROGRAM, icon ? docsyPng : '', b], { timeout: 10_000, maxBuffer: 64 * 1024 },
        (err, _stdout, stderr) => (err ? fail(new Error(`${err.message.trim()}${stderr ? ` ${stderr.trim()}` : ''}`)) : done()));
    }),
    readMarks,
    writeMark(b, mark) {
      const marks = readMarks();
      if (mark) marks[b] = { icon: mark.icon, print: mark.print };
      else delete marks[b];
      if (Object.keys(marks).length === 0) rmSync(marksFile, { force: true });
      else writeFileAtomic(marksFile, JSON.stringify({ bundles: marks }));
    },
    log: host.log,
    error: host.error
  };
}
