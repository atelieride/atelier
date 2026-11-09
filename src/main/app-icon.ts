import { appIconFor, bundleIconPlan, runtimeIconFor, type AppIcon, type RuntimeIcon } from '@shared/app-icon';
import type { ThemeId } from '@shared/themes';

// The app icon follows Docsy's themes: the Dock
// icon while Atelier runs, and the installed bundle's custom icon that Finder, Launchpad, Spotlight and the Dock read.
// The decisions are in @shared/app-icon; the real Mac behind the deps is in app-icon-exec.ts.

/**
 * What Atelier wrote on one installed bundle (ATELIER_HOME/app-icon.json keeps one per bundle): the icon, and the
 * print of the custom icon it left there. A custom icon with another print is the user's own (pasted over ours in
 * Finder's Get Info, say), and Atelier never overwrites or removes it.
 */
export interface AppIconMark { icon: AppIcon; print: string }

export interface AppIconDeps {
  packaged: boolean;
  /** The installed bundle Atelier may change (eligibleBundle), or null: then only the running Dock icon follows. */
  bundle: string | null;
  /** A packaged macOS app that is not installed (a disk image, Downloads, release/): its bundle, for one notice. */
  uninstalled: string | null;
  /** False when the icon could not be set (the image missing, Electron refusing it). */
  setDockIcon(icon: RuntimeIcon): boolean;
  /** The print of the bundle's custom icon (a hash of `Icon\r`'s resource fork), or null when it has none. */
  customIcon(bundle: string): string | null;
  /** NSWorkspace.setIcon on the bundle: the icon, or null to remove the custom one. Rejects when it failed. */
  setBundleIcon(bundle: string, icon: AppIcon | null): Promise<void>;
  readMarks(): Record<string, AppIconMark>;
  writeMark(bundle: string, mark: AppIconMark | null): void;
  /** The e2e probe (ATELIER_TEST_APP_ICON_LOG): what the Dock got, what the bundle needed. */
  log(line: Record<string, unknown>): void;
  /** The app log (main:app-icon). */
  error(message: string): void;
}

export interface AppIconControl {
  /** Before `ready`: the Dock icon from the saved theme. */
  start(theme: ThemeId): void;
  /** After `ready`: a Docsy or dev Dock icon set again (AppKit may load the bundle's at launch), then reconcile. */
  ready(): Promise<void>;
  /** The bundle's icon brought in line with the theme (one write at a time, the latest theme wins). */
  reconcile(): Promise<void>;
  themeChanged(theme: ThemeId): Promise<void>;
}

export function createAppIcon(deps: AppIconDeps): AppIconControl {
  let want: AppIcon | null = null;
  // What the Dock shows at launch: a packaged app's bundle icon; a development one Electron's (never ours).
  const launchIcon: RuntimeIcon | null = deps.packaged ? 'bundle' : null;
  // What Atelier last set; null when unknown (a set that failed), so the next change asks again.
  let runtime: RuntimeIcon | null = launchIcon;
  // The icon the last set failed for: asked again by the next change, not twice in this one (one error in the log).
  let refused: RuntimeIcon | null = null;
  // The Dock got an image, or the bundle's icon was written, during this run: Aurora is then an image too (runtimeIconFor).
  let changed = false;
  let loop: Promise<void> | null = null;
  let dirty = false;
  // The last bundle write failed: the bundle still shows what it showed, and the Dock with it.
  let failed = false;
  let noticed = false;

  /** The bundle's custom icon and whose it is: ours when Atelier's mark for this bundle has the same print. */
  const bundleState = (bundle: string): { print: string | null; ours: boolean; mark: AppIconMark | undefined } => {
    const print = deps.customIcon(bundle);
    const mark = deps.readMarks()[bundle];
    return { print, mark, ours: mark !== undefined && (print === null || mark.print === print) };
  };
  const foreignIcon = (): boolean => {
    if (!deps.bundle) return false;
    const s = bundleState(deps.bundle);
    return s.print !== null && !s.ours;
  };

  /** `force`: ask again even when unchanged (the bundle's own icon just changed under it, or launch reloaded it). */
  const applyRuntime = (force = false): void => {
    const next = runtimeIconFor({ want, packaged: deps.packaged, foreignIcon: foreignIcon(), changed });
    if ((next === runtime || next === refused) && !force) return;
    if (next !== 'bundle') changed = true;
    if (deps.setDockIcon(next)) {
      runtime = next;
      refused = null;
    } else {
      runtime = null;
      refused = next;
      // Aurora's image refused (missing from a broken build): the bundle's own icon at least, a stale copy at worst.
      if (next === 'aurora') deps.setDockIcon('bundle');
    }
    deps.log({ runtime: next });
  };

  const syncOnce = async (): Promise<void> => {
    const bundle = deps.bundle;
    if (!bundle) {
      deps.log({ bundle: 'ineligible' });
      if (want && deps.uninstalled && !noticed) {
        noticed = true;
        deps.error(`app icon: ${deps.uninstalled} is not in /Applications or ~/Applications: only the Dock follows the theme while Atelier runs`);
      }
      return;
    }
    const target = want;
    try {
      const before = bundleState(bundle);
      const plan = bundleIconPlan({ want: target, hasCustomIcon: before.print !== null, ours: before.ours });
      deps.log({ bundle: plan.action });
      if (plan.action !== 'none') {
        // Even a write that fails may have changed it: the Dock never trusts a reload of the bundle's icon after it.
        changed = true;
        await deps.setBundleIcon(bundle, plan.action === 'set' ? target : null);
      }
      if (plan.mark === 'write' && target) {
        const print = deps.customIcon(bundle);
        if (print) deps.writeMark(bundle, { icon: target, print });
      }
      if (plan.mark === 'clear') deps.writeMark(bundle, null);
      failed = false;
      if (plan.action === 'reset') applyRuntime(true);
    } catch (err) {
      failed = true;
      deps.error(`app icon: the bundle's icon could not be ${target ? 'set' : 'removed'}: ${(err as Error).message}`);
    }
  };

  const reconcile = (): Promise<void> => {
    dirty = true;
    loop ??= (async () => {
      try {
        while (dirty) { dirty = false; await syncOnce(); }
      } finally { loop = null; }
    })();
    return loop;
  };

  return {
    start(theme) {
      want = appIconFor(theme);
      applyRuntime();
    },
    ready() {
      // Anything but the bundle's own icon (which the launch just loaded) is set again; so is one that failed.
      if (runtime !== 'bundle') applyRuntime(true);
      return reconcile();
    },
    reconcile,
    async themeChanged(theme) {
      const next = appIconFor(theme);
      if (next === want) return;
      want = next;
      // To Docsy: the Dock at once, then the bundle. Back: the bundle's icon goes first, then the Dock gets Aurora's
      // image; if the bundle's could not go, the Dock keeps showing what the bundle shows.
      if (want) { applyRuntime(); await reconcile(); }
      else { await reconcile(); if (!failed) applyRuntime(); }
    }
  };
}
