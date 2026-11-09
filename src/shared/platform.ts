// The one platform switch. Main and atelierd read Node's process.platform, the renderer the
// preload's window.atelier.platform, the website's demo its bridge's; nothing else detects the platform. Read at each
// call, so a module that builds something at load time still sees the right value. Pure: no Node or DOM types.

export type Platform = 'darwin' | 'win32' | 'linux';
/** How paths are written: POSIX on macOS and Linux, drive letters and backslashes on Windows. */
export type PathStyle = 'posix' | 'win32';

let forced: Platform | null = null;
/** What resetPlatformForTests goes back to: null (the machine's) in the app; the unit-test setup sets darwin. */
let testDefault: Platform | null = null;

/** Anything but win32 and linux reads as darwin: the behaviour every platform had before Windows. */
export function asPlatform(p: unknown): Platform {
  return p === 'win32' ? 'win32' : p === 'linux' ? 'linux' : 'darwin';
}

/** Forces the platform (tests; the unit-test setup forces darwin, the behaviour most tests describe). */
export function initPlatform(p: unknown): void {
  forced = asPlatform(p);
}

/** Back to the tests' default platform (none outside tests: the machine's). */
export function resetPlatformForTests(): void {
  forced = testDefault;
}

/** The platform tests run as unless they force one; null: the machine's (tests on real files and native paths). */
export function setTestDefaultPlatform(p: unknown): void {
  testDefault = p === null || p === undefined ? null : asPlatform(p);
  forced = testDefault;
}

export function currentPlatform(): Platform {
  if (forced) return forced;
  const g = globalThis as { atelier?: { platform?: unknown }; process?: { platform?: unknown } };
  return asPlatform(g.atelier?.platform ?? g.process?.platform);
}

export function pathStyle(p: Platform = currentPlatform()): PathStyle {
  return p === 'win32' ? 'win32' : 'posix';
}
