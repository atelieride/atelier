// Runs before any renderer module (main.ts imports it first; ES modules evaluate in import order): the storage shim,
// then the demo shell around the page, then `window.atelier`, so the renderer finds both exactly as it finds the
// preload's bridge in the app. The shell's keydown listener is added here, before any of the renderer's: the demo has no
// native menu behind the page, so its menu's accelerators go first (why that matches the app: shell/accelerators.ts).
import world from 'virtual:demo-world';
import { config as zodConfig } from 'zod';
import { createDemo } from './bridge';
import { installShell } from './shell';
import { isMacPlatform } from './shell/accelerators';
import { installStorageShim } from './storage';
import { seedWorkspaces } from './world/workspaces';

// zod compiles its object parsers with `new Function` when it may, and finds out by trying once: under the demo's
// CSP (script-src 'self', no eval) that try is a CSP violation, an Issue in DevTools that costs Lighthouse's Best
// Practices. jitless: zod never tries (its parsers work the same, interpreted).
zodConfig({ jitless: true });
installStorageShim();
// Workspaces: off as in the app, four fronts ready for when the visitor turns them on.
seedWorkspaces(localStorage, world);
const demo = createDemo(world, { version: __ATELIER_VERSION__, platform: isMacPlatform(navigator) ? 'darwin' : 'linux' });
// The shell watches a few bridge calls for "Things to try" (shell/observe.ts) and hands the renderer the bridge.
window.atelier = installShell(demo, world);
