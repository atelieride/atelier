// The Databases view's e2e: the app launched on a project, the test Postgres
// (tests/support/pg-server.ts: PGlite on a loopback port, the acme world) added by hand as the user would — the view
// looks for
// nothing, so the Mac's own Postgres is never contacted. Helpers the databases*.spec.ts files share: launch
// and stop, adding the connection, the view's usual places, the copy log (the app's clipboard test hook: the real
// clipboard is never read nor written).
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';
import type { PgServer } from '../support/pg-server';

/** Where the `look()` shots go (taken only with ATELIER_E2E_SHOTS=1). */
export const SHOTS = resolve('e2e-shots/databases-view');

/** `url`: the test Postgres's (no password in it), what addConnection adds; null without a server. */
export interface Launched { app: ElectronApplication; home: string; root: string; env: Record<string, string>; win: Page; url: string | null }

export interface LaunchOptions {
  /** The project's .env (none by default): nothing reads it for databases any more. */
  dotenv?: string;
  env?: Record<string, string>;
  prefs?: Record<string, unknown>;
  width?: number;
  height?: number;
  /** Launch again on this home and project (a restart). */
  again?: { home: string; root: string; env: Record<string, string> };
}

/** The app on a fresh project `acme-store` (or `again`'s). Times shown in Rome (the boards' zone). */
export async function launchDb(server: PgServer | null, o: LaunchOptions = {}): Promise<Launched> {
  let root: string;
  let home: string;
  let env: Record<string, string>;
  if (o.again) {
    ({ root, home, env } = o.again);
  } else {
    const parent = mkdtempSync(join(tmpdir(), 'atl-prj-'));
    root = join(parent, 'acme-store');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'schema.sql'), '-- the acme store\nselect 1;\n');
    if (o.dotenv !== undefined) writeFileSync(join(root, '.env'), o.dotenv);
    ({ env, home } = e2eEnv({
      ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl'),
      TZ: 'Europe/Rome',
      ...o.env
    }));
    if (o.prefs) writeFileSync(join(home, 'preferences.json'), JSON.stringify(o.prefs));
  }
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: o.width ?? 1440, height: o.height ?? 900 });
  return { app, home, root, env, win, url: server?.url ?? null };
}

/** Closes the app; `daemon`: its atelierd too (the last launch on this home). */
export async function stopDb(l: Pick<Launched, 'app' | 'home'>, daemon = true): Promise<void> {
  await l.app.close().catch(() => undefined);
  if (!daemon) return;
  try { process.kill((JSON.parse(readFileSync(join(l.home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

export const dbIcon = (win: Page): Locator => win.locator('.activity-bar .act[aria-label^="Databases"]');
export const tabOf = (win: Page, name: string): Locator => win.locator('.tab.is-db', { has: win.locator('.tab-name', { hasText: new RegExp(`^${esc(name)}$`) }) });
export const dbTabs = (win: Page): Locator => win.locator('.tab.is-db');
/** A catalog row (table, view, materialized view) by its name. */
export const relRow = (win: Page, name: string): Locator => win.locator('.db-rel', { has: win.locator('.db-rel-name', { hasText: new RegExp(`^${esc(name)}$`) }) });
export const connRow = (win: Page, name: string): Locator => win.locator('.db-conn', { has: win.locator('.db-name', { hasText: new RegExp(`^${esc(name)}$`) }) });
/** The table tab in front (one per pane: the focused pane's when `pane` is not given). */
/** The table tab on screen; split (tables live in Databases), the newest one: the right pane's in our tests. */
export const front = (win: Page): Locator => win.locator('.dbt:visible').last();
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rows drawn in the front table's grid (virtualized: the ones on screen and an overscan). */
export const gridRows = (t: Locator): Locator => t.locator('.dbt-grid tbody tr[data-row]');
/** A header cell by its column's name. */
export const header = (t: Locator, name: string): Locator => t.locator('.dbt-th', { has: t.page().locator('.dbt-th-name', { hasText: new RegExp(`^${esc(name)}$`) }) });
/** A cell: its row index (0-based, as loaded) and its column's name. */
export async function cell(t: Locator, row: number, column: string): Promise<Locator> {
  const col = await header(t, column).getAttribute('data-col');
  return t.locator(`.dbt-grid tbody tr[data-row="${row}"] td[data-col="${col}"]`);
}

/** "+ Filter" and the chips (the bar's hidden measuring copy left out). */
export const addFilterBtn = (t: Locator): Locator => t.locator('button.dbt-fadd');
export const chips = (t: Locator): Locator => t.locator('.dbt-fchips > .dbt-fchip > button.dbt-fchip-main');

/**
 * A filter through "+ Filter": the column found by `find` (Enter picks the first match), the operator, the values (one
 * field each); Apply.
 */
export async function addFilter(t: Locator, find: string, op: string, values: string[] = []): Promise<void> {
  await addFilterBtn(t).click();
  const pop = t.page().locator('.dbt-fpop');
  const search = pop.getByRole('combobox', { name: 'Find a column' });
  await search.fill(find);
  await search.press('Enter');
  await pop.locator('.dbt-fpop-op').selectOption(op);
  const fields = pop.locator('.dbt-fpop-input input');
  for (let i = 0; i < values.length; i++) await fields.nth(i).fill(values[i]!);
  await pop.getByRole('button', { name: 'Apply' }).click();
  await expect(pop).toHaveCount(0);
}

/**
 * View › Databases, ⌃⇧B (the menu's own item: a hidden test window gets no native key, so it is clicked): the view opens
 * whatever Show Databases Auto says. Returns the item's accelerator.
 */
export async function openDbView(l: Pick<Launched, 'app' | 'win'>): Promise<string> {
  await expect(l.win.locator('.activity-bar .act').first()).toBeVisible({ timeout: 20000 });
  const accelerator = await l.app.evaluate(({ Menu, BrowserWindow }) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === 'Databases' && it.accelerator) return it; const s = it.submenu ? walk(it.submenu.items) : undefined; if (s) return s; }
      return undefined;
    };
    const it = walk(Menu.getApplicationMenu()!.items)!;
    it.click(undefined, BrowserWindow.getAllWindows()[0]);
    return it.accelerator ?? '';
  });
  await expect(l.win.locator('.db-side')).toBeVisible();
  return accelerator;
}

/**
 * Adds a connection by hand, as the user would (nothing is suggested): the view opened, Add Connection…, the URL
 * typed, Continue, Save and Connect (no password typed). `catalog` (default): waits for the acme world's tables.
 */
export async function addConnection(l: Pick<Launched, 'app' | 'win' | 'url'>, o: { url?: string; catalog?: boolean } = {}): Promise<void> {
  const { win } = l;
  if (!(await win.locator('.db-side').isVisible())) await openDbView(l);
  await win.locator('.db-side .sidebar-head').getByRole('button', { name: 'Add Connection…' }).click();
  const sheet = win.locator('.db-sheet');
  const url = sheet.getByLabel('Connection URL');
  await url.fill(o.url ?? l.url!);
  await url.press('Enter');
  await expect(sheet.getByLabel('Host')).toHaveValue('127.0.0.1');
  await sheet.getByRole('button', { name: 'Save and Connect' }).click();
  await expect(sheet).toHaveCount(0);
  if (o.catalog !== false) await expect(relRow(win, 'orders')).toBeVisible({ timeout: 20000 });
}

/** A table opened from the sidebar: a single click (the preview), or a double click (kept). Waits for its rows. */
export async function openTable(win: Page, name: string, how: 'click' | 'dblclick' = 'click'): Promise<Locator> {
  if (how === 'click') await relRow(win, name).click();
  else await relRow(win, name).dblclick();
  await expect(tabOf(win, name)).toHaveClass(/is-active/);
  const t = front(win);
  await expect(t.locator('.dbt-crumb-name')).toHaveText(name);
  await expect(gridRows(t).first()).toBeVisible({ timeout: 20000 });
  return t;
}

/** Every text the app copied (the clipboard test hook's log, one JSON value per line). */
export function copies(home: string): string[] {
  const log = join(home, 'test-clipboard.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => {
    const v = JSON.parse(l) as string | { text: string };
    return typeof v === 'string' ? v : v.text;
  });
}
/** The last copy, waited for (`after`: how many copies there were before). */
export async function lastCopy(home: string, after: number): Promise<string> {
  await expect.poll(() => copies(home).length, { timeout: 10000 }).toBeGreaterThan(after);
  return copies(home).at(-1)!;
}

/** Settings through the app's own bridge (as the Settings sheet writes them). */
export async function setSettings(win: Page, patch: Record<string, unknown>): Promise<void> {
  await win.evaluate((p) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set(p), patch);
}

/** A screenshot to look at: the pointer parked out of the way first. */
export async function shot(win: Page, name: string, target?: Locator): Promise<void> {
  const v = win.viewportSize();
  await win.mouse.move((v?.width ?? 1440) - 4, (v?.height ?? 900) - 4);
  await look(target ?? win, join(SHOTS, `${name}.png`), { settle: 400 });
}

/** Two frames: what a layout change measures has been drawn. */
export const frames = (win: Page): Promise<void> => win.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
