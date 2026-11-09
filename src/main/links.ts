import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, shell } from 'electron';
import { isSafeUrl } from '@shared/links';
import { splitPath } from '@shared/paths';
import { pathStyle } from '@shared/platform';
import { devEnv } from './dev-env';

interface Deps {
  openExternal?: (url: string) => Promise<void>;
}

/** Opens a URL in the user's default browser (never in an internal browser). http/https only. */
export async function openUrl(url: string, deps: Deps = {}): Promise<boolean> {
  if (!isSafeUrl(url)) return false;
  // The browser gets the URL as the parser understands it (spaces and control characters normalized), never the raw string.
  const href = new URL(url.trim()).href;
  // Tests only: the URL is recorded instead of actually opening the browser.
  const log = devEnv('ATELIER_TEST_URL_LOG');
  if (log) { appendFileSync(log, href + '\n'); return true; }
  const open = deps.openExternal ?? ((u: string) => shell.openExternal(u));
  try { await open(href); return true; } catch { return false; }
}

/** Atelier's page in the Microsoft Store app (product "Atelier IDE"). */
export const STORE_PAGE = 'ms-windows-store://pdp/?ProductId=9N9FX0BQ20HF';

/** Windows: opens Atelier's Store page, where the Store offers its update. A fixed link, never one from the renderer. */
export async function openStorePage(deps: Deps = {}): Promise<boolean> {
  const log = devEnv('ATELIER_TEST_URL_LOG');
  if (log && !deps.openExternal) { appendFileSync(log, STORE_PAGE + '\n'); return true; }
  const open = deps.openExternal ?? ((u: string) => shell.openExternal(u));
  try { await open(STORE_PAGE); return true; } catch { return false; }
}

/** Desktop apps a task can open in, by the exact link shape main builds (`Connector.appUrl`). */
const APP_URL = /^(?:clickup:\/\/t\/[A-Za-z0-9_-]{1,64}|notion:\/\/www\.notion\.so\/[0-9a-f]{32})$/;

interface AppDeps extends Deps {
  /** Whether an app on this Mac handles the URL's scheme (Launch Services: no file of another app is read). */
  hasApp?: (url: string) => boolean;
}

function testAppSchemes(): string[] | null {
  const v = devEnv('ATELIER_TEST_APP_SCHEMES');
  return v === undefined ? null : v.split(',').filter((s) => s && s !== 'none');
}

/**
 * Opens a task in its desktop app (`clickup://t/<id>`, `notion://www.notion.so/<id>`). False when the URL isn't one of those, no app handles it (never
 * the system's "no application" dialog) or the open failed: the caller then opens the web page.
 */
export async function openAppUrl(url: string, deps: AppDeps = {}): Promise<boolean> {
  if (!APP_URL.test(url)) return false;
  const scheme = url.slice(0, url.indexOf(':'));
  const testSchemes = testAppSchemes();
  const hasApp = deps.hasApp ?? (testSchemes ? () => testSchemes.includes(scheme) : (u: string) => app.getApplicationNameForProtocol(u) !== '');
  if (!hasApp(url)) return false;
  const log = devEnv('ATELIER_TEST_URL_LOG');
  if (log && !deps.openExternal) { appendFileSync(log, url + '\n'); return true; }
  const open = deps.openExternal ?? ((u: string) => shell.openExternal(u));
  try { await open(url); return true; } catch { return false; }
}

/** Extensions macOS opens as a bundle (launch, install): narrower than "any dotted name". */
export const BUNDLE_EXTENSIONS = /\.(app|pkg|mpkg|bundle|framework|plugin|appex|kext|prefpane|workflow|action|saver|qlgenerator|mdimporter|xpc)$/i;

/** bundleName: which folder names are bundles without an Info.plist; any `name.ext` when absent. */
interface FolderDeps { show?: (path: string) => void; open?: (path: string) => Promise<unknown>; hasInfoPlist?: (path: string) => boolean; bundleName?: RegExp }

/**
 * Opens a terminal's current folder in Finder (Reveal in Finder). That folder follows any `cd`, also into a bundle a
 * repo ships (tools.app, Setup.pkg): opening one would launch or install it, so a bundle is shown selected instead.
 */
export async function openTerminalFolder(path: string, deps: FolderDeps = {}): Promise<void> {
  const name = splitPath(path).at(-1) ?? '';
  const hasInfoPlist = deps.hasInfoPlist ?? ((p: string) => existsSync(join(p, 'Contents', 'Info.plist')));
  // Bundles are macOS's: on Windows opening a folder never runs it (Contoso.Web, site.com open as folders), only the
  // names Windows runs are shown selected.
  const macBundle = () => (deps.bundleName ?? /^[^.].*\.[A-Za-z][A-Za-z0-9]*$/).test(name) || hasInfoPlist(path);
  const bundle = pathStyle() === 'win32' ? runsOnOpen(name) : macBundle() || runsOnOpen(name);
  const log = devEnv('ATELIER_TEST_URL_LOG');
  if (log && !deps.show) { appendFileSync(log, `${bundle ? 'finder-select' : 'finder'}:${path}\n`); return; }
  if (bundle) (deps.show ?? ((p: string) => shell.showItemInFolder(p)))(path);
  else await (deps.open ?? ((p: string) => shell.openPath(p)))(path);
}

/**
 * Names Windows runs instead of showing when opened (shell.openPath on a file executes it): such a name is only ever
 * shown selected. Nothing on macOS, where bundles have their own rule.
 */
const WIN32_RUNS = /\.(exe|com|bat|cmd|lnk|ps1|psm1|msi|msp|scr|vbs|vbe|js|jse|wsf|wsh|hta|cpl|pif|reg|appref-ms|url)$/i;
// Windows drops a name's trailing dots and spaces: `tool.exe.` runs as tool.exe.
const runsOnOpen = (name: string) => pathStyle() === 'win32' && WIN32_RUNS.test(name.replace(/[. ]+$/, ''));

/** Opens the project folder in Finder (decided by the main process, never by the renderer). */
export async function revealFolder(path: string): Promise<void> {
  const log = devEnv('ATELIER_TEST_URL_LOG');
  if (log) { appendFileSync(log, `finder:${path}\n`); return; }
  if (runsOnOpen(splitPath(path).at(-1) ?? '')) { shell.showItemInFolder(path); return; }
  await shell.openPath(path);
}
