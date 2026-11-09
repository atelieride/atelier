import type { ThemeId } from './themes';

// The app icon follows Docsy's themes: the pure
// decisions. Main (app-icon.ts) applies them: the running app's Dock icon and the installed bundle's custom icon
// that Finder, Launchpad, Spotlight and the Dock read.

/** An icon other than the bundle's own; only Docsy's themes have one. */
export type AppIcon = 'docsy';

export function appIconFor(theme: ThemeId): AppIcon | null {
  return theme === 'docsy' || theme === 'docsy-night' ? 'docsy' : null;
}

/** The bundle of a macOS main executable (`<bundle>/Contents/MacOS/<name>`), or null. */
export function bundleOf(exePath: string): string | null {
  return /^(\/[^\0]+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath)?.[1] ?? null;
}

/**
 * The bundle whose custom icon Atelier may change: the packaged app installed directly in /Applications or
 * ~/Applications, from the main executable's path (`<bundle>/Contents/MacOS/<name>`). Never anything else: `release/`
 * (packaged tests, stage-update), a CI job's temp folder, a translocated copy or a disk image would carry the icon
 * into what ships, and a build there is not the user's app.
 */
export function eligibleBundle(o: { platform: string; packaged: boolean; exePath: string; home: string }): string | null {
  if (o.platform !== 'darwin' || !o.packaged) return null;
  const bundle = bundleOf(o.exePath);
  if (!bundle) return null;
  const parent = bundle.slice(0, bundle.lastIndexOf('/'));
  const home = o.home.replace(/\/+$/, '');
  return parent === '/Applications' || (home !== '' && parent === `${home}/Applications`) ? bundle : null;
}

export type BundleAction = 'set' | 'reset' | 'none';
/** The marker (ATELIER_HOME/app-icon.json): written once our icon is on, cleared once it is gone, else kept. */
export type MarkAction = 'write' | 'clear' | 'keep';

/**
 * What to do with the bundle's custom icon. `ours`: the marker names this bundle, so a custom icon there is
 * Atelier's; without it, a custom icon is the user's own (Finder's Get Info) and Atelier never overwrites or erases it.
 * An update brings a fresh bundle without the icon: Docsy sets it again.
 */
export function bundleIconPlan(o: { want: AppIcon | null; hasCustomIcon: boolean; ours: boolean }): { action: BundleAction; mark: MarkAction } {
  if (o.want) return o.hasCustomIcon ? { action: 'none', mark: 'keep' } : { action: 'set', mark: 'write' };
  if (o.hasCustomIcon) return o.ours ? { action: 'reset', mark: 'clear' } : { action: 'none', mark: 'keep' };
  return { action: 'none', mark: o.ours ? 'clear' : 'keep' };
}

/**
 * The Dock icon while Atelier runs: the Docsy image, the bundle's own (`null` to Electron: with a custom icon
 * on, macOS shows that), Aurora's image, or the development icon (Electron's would show otherwise). A bundle wearing
 * the user's own custom icon keeps it in the Dock too.
 *
 * `changed`: the Dock or the bundle's icon changed during this run. Then `null` is not enough to get Aurora back: macOS
 * answers it with a stale copy of the Docsy icon, so the Dock gets Aurora's image itself. Until
 * then the bundle's own icon stays, with the system's icon styles (dark, tinted), which an image would not follow.
 */
export type RuntimeIcon = 'docsy' | 'aurora' | 'bundle' | 'dev';

export function runtimeIconFor(o: { want: AppIcon | null; packaged: boolean; foreignIcon: boolean; changed: boolean }): RuntimeIcon {
  if (o.foreignIcon) return 'bundle';
  if (o.want) return 'docsy';
  if (!o.packaged) return 'dev';
  return o.changed ? 'aurora' : 'bundle';
}
