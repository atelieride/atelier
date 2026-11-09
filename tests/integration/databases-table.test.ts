// A table tab's Data view: its stylesheet and strings come with the table's
// lazy chunk, never the first paint (the live demo's budget); colors only through Aurora's tokens;
// the layout rules that hold at every width (a pane of ~430 px in split view): the crumb ellipsizes, chips and buttons
// never shrink or wrap, the view labels and the right-side buttons fold to icons, the footer's label gives way before
// Count exactly does. ⌘R refreshes a table tab, listed in Settings › Keyboard, taken by no menu item.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { SHORTCUTS, keysOf } from '../../src/renderer/shortcuts';
import { MENU_SPEC, menuItems } from '../../src/shared/menu-spec';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'databases', 'table.css');
const css = readFileSync(OWN, 'utf8');
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
const src = (f: string) => readFileSync(join(RENDERER, f), 'utf8');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
}
function selectors(text: string): string[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...t.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => s && !s.startsWith('@'))
    .flatMap((s) => s.split(',')).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
/** The declarations of every rule naming `sel` (inside @container blocks too), joined. */
const rule = (sel: string) => [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]!).join(';');
/** The rules inside `@container dkv (max-width: Npx)` blocks, by their width. */
function containerRules(): { width: number; body: string }[] {
  const out: { width: number; body: string }[] = [];
  const re = /@container dkv \(max-width: (\d+)px\) \{/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) depth += code[i] === '{' ? 1 : code[i] === '}' ? -1 : 0;
    out.push({ width: Number(m[1]), body: code.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

test('the stylesheet and the strings travel with the table\'s lazy chunk; the first paint reaches neither', () => {
  expect(src('databases/TableView.tsx')).toMatch(/^import '\.\/table\.css';$/m);
  expect(src('databases/TableView.tsx')).toMatch(/^import \{ tdt \} from '\.\.\/i18n\/db-table';$/m);
  expect(src('styles.ts')).not.toContain('table.css');
  // The table view lives behind DbTabView, which App and pop-outs load on demand.
  expect(src('App.tsx')).toMatch(/const DbTabView = lazy\(\(\) => import\('\.\/databases\/DbTabView'\)/);
  expect(src('components/PopoutWindow.tsx')).toMatch(/const DbTabView = lazy\(\(\) => import\('\.\.\/databases\/DbTabView'\)/);
  const firstPaint = ['App.tsx', 'store.ts', 'styles.ts', 'components/Tabs.tsx', 'components/Settings.tsx', 'components/PopoutWindow.tsx', 'shortcuts.ts',
    'databases/install.ts', 'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts'];
  for (const f of firstPaint) {
    const s = src(f);
    expect(s, f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(TableView|Grid|Cell|grid-model|grid-copy|json-text|MoreRow|data|table-view)'/m);
    expect(s, f).not.toMatch(/^import [^;]*from '[./]*i18n\/db-table'/m);
  }
});

test('Settings › Keyboard\'s list loads with its section, not the first paint (room the table tab gave back)', () => {
  const settings = src('components/Settings.tsx');
  expect(settings).not.toMatch(/^import [^;]*from '\.\.\/shortcuts'/m);
  expect(settings).toMatch(/const Keyboard = lazy\(\(\) => import\('\.\/SettingsKeyboard'\)/);
  expect(settings).toMatch(/section === 'keyboard' && <Suspense fallback=\{null\}><Keyboard \/><\/Suspense>/);
  expect(src('components/SettingsKeyboard.tsx')).toMatch(/^import \{ SHORTCUTS \} from '\.\.\/shortcuts';$/m);
  // The demo's shell labels its keys with kbd.ts's keysOf (first paint already), never through the list's module.
  for (const f of ['accelerators.ts', 'reserved.ts', 'menu-model.ts']) {
    const shell = readFileSync(join(__dirname, '..', '..', 'src', 'demo', 'shell', f), 'utf8');
    expect(shell, f).not.toMatch(/renderer\/shortcuts'/);
  }
  for (const f of ['App.tsx', 'store.ts', 'kbd.ts', 'components/Settings.tsx', 'components/PopoutWindow.tsx']) expect(src(f), f).not.toMatch(/^import [^;]*from '[./]*shortcuts'/m);
});

test('Settings › Connectors\' pages load with their section, not the first paint (room for the palette and footer)', () => {
  const settings = src('components/Settings.tsx');
  expect(settings).toMatch(/const Connectors = lazy\(\(\) => import\('\.\/Connectors'\)/);
  expect(settings).toMatch(/section === 'connectors' && <Suspense fallback=\{null\}><Connectors \/><\/Suspense>/);
  // The sheet's own part (the header's back button, which page is open) stays with it, from a module of its own.
  expect(settings).toMatch(/^import \{ ConnectorsBack, useConnectorDetail \} from '\.\/ConnectorsBack';$/m);
  // Nothing of the first paint imports the section (or what only it draws: Jira's and Notion's options).
  const own = /^import [^;]*from '[./]*(components\/)?(Connectors|JiraOptions|JiraProjects|JiraPicker|NotionSources|NotionPicker|NotionFieldsEditor)'/m;
  for (const f of ['App.tsx', 'store.ts', 'components/Settings.tsx', 'components/ConnectorsBack.tsx', 'components/Palette.tsx', 'components/PopoutWindow.tsx']) expect(src(f), f).not.toMatch(own);
});

test('the palette\'s table results load with the palette, not the first paint', () => {
  const palette = src('components/Palette.tsx');
  expect(palette).toMatch(/import\('\.\.\/databases\/palette'\)/);
  // A chunk that fails to load says so in the console, never silently (the group just doesn't show).
  expect(palette).toMatch(/import\('\.\.\/databases\/palette'\)\.then\(setDbTables, \(e: unknown\) => console\.warn\(/);
  for (const f of ['components/Palette.tsx', 'components/Footer.tsx', 'App.tsx', 'store.ts', 'databases/view.ts', 'databases/store.ts']) {
    expect(src(f), f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?palette'/m);
  }
});

test('colors only through the theme\'s tokens: no hex, rgb or hsl value of its own', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
});

test('its selectors are its own: none of another stylesheet redefined', () => {
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  expect(selectors(css).filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`)).toEqual([]);
  // Every rule is the table's (`.dbt…`), a toolbar's reuse scoped under it.
  expect(selectors(css).filter((s) => !/^\.dbt[-\s.:[]|^\.dbt$/.test(s))).toEqual([]);
});

test('production\'s 2 px hairline shows through the toolbar: the bar paints no background over it', () => {
  expect(src('databases.css')).toMatch(/\.db-tab\.is-prod \{ box-shadow: inset 0 2px 0 var\(--error\); \}/);
  expect(rule('.dbt-bar')).not.toMatch(/background/);
  expect(rule('.dbt')).not.toMatch(/background/);
});

test('the crumb ellipsizes, the table\'s name last; the chips, the view switch and the buttons never shrink or wrap', () => {
  for (const sel of ['.dbt-crumb', '.dbt-crumb-conn', '.dbt-crumb-schema', '.dbt-crumb-name']) {
    const r = rule(sel);
    expect(r, sel).toMatch(/min-width: 0/);
    expect(r, sel).toMatch(/overflow: hidden/);
    expect(r, sel).toMatch(/text-overflow: ellipsis/);
    expect(r, sel).toMatch(/white-space: nowrap/);
  }
  const shrink = (sel: string) => Number(/flex-shrink: (\d+)/.exec(rule(sel))?.[1] ?? /flex: \d+ (\d+)/.exec(rule(sel))?.[1] ?? 1);
  expect(shrink('.dbt-crumb-conn')).toBeGreaterThan(shrink('.dbt-crumb-name'));
  expect(shrink('.dbt-crumb-schema')).toBeGreaterThan(shrink('.dbt-crumb-name'));
  for (const sel of ['.dbt-ro', '.dbt-est', '.dbt-views', '.dbt-ib', '.dbt-sql', '.dbt-crumb-sep']) {
    expect(rule(sel), sel).toMatch(/flex: none/);
  }
  for (const sel of ['.dbt-bar', '.dbt-ro', '.dbt-est', '.dbt-sql', '.dbt-views button']) expect(rule(sel), sel).toMatch(/white-space: nowrap/);
  expect(rule('.dbt-bar')).toMatch(/min-width: 0/);
  expect(rule('.dbt-bar')).not.toMatch(/flex-wrap: wrap/);
  // A safety net only (the ⋯ fold keeps every action reachable): the bar clips rather than spill over the next pane —
  // so the SQL popover lives beside it (the markup test checks where it renders).
  expect(rule('.dbt-bar')).toMatch(/overflow: hidden/);
});

test('a narrow pane folds the Grid / Record toggle into the ⋯ button first, then Mask, Refresh and SQL, then the view switch; wider, the ⋯ stays hidden', () => {
  const blocks = containerRules();
  expect(rule('.dbt-bar .dbt-fold')).toMatch(/display: none/);
  const fold = blocks.find((b) => /\.dbt-bar \.dbt-fold\s*\{[^}]*display: flex/.test(b.body));
  const toggle = blocks.find((b) => /(^|[\s,}])\.dbt-bar \.dbt-rv\s*\{[^}]*display: none/.test(b.body));
  const buttons = blocks.find((b) => /\.dbt-bar \.dbt-ib[^{]*\{[^}]*display: none/.test(b.body));
  // ⋯ shows as soon as something folds into it: with the toggle.
  expect(toggle?.width).toBe(460);
  expect(fold?.width).toBe(toggle?.width);
  expect(buttons?.width).toBe(340);
  for (const sel of ['.dbt-bar .dbt-ib', '.dbt-bar .dbt-sql']) expect(buttons!.body, sel).toMatch(new RegExp(`${sel.replace(/\./g, '\\.')}[^{]*\\{[^}]*display: none`));
  const views = blocks.find((b) => /\.dbt-views\s*\{[^}]*display: none/.test(b.body));
  expect(views?.width).toBeLessThan(buttons!.width);
  expect(views?.width).toBeGreaterThanOrEqual(200);
  // What's left at 340 px fits: padding, the crumb's ellipsis room, the view switch (icons), ⋯ and their gaps.
  expect(8 + 12 + 60 + 94 + 26 + 3 * 6).toBeLessThanOrEqual(340);
  // Just wider than the toggle's fold, the crumb keeps ~100 px: padding, the Read-only chip (icon), the view switch and
  // the toggle (icons), Mask, Refresh, SQL (icon) and their gaps.
  expect(20 + 24 + 94 + 64 + 52 + 30 + 7 * 6 + 100).toBeLessThanOrEqual(461);
});

test('the SQL popover hears Esc on itself (onEscCancel), never through a window or document listener', () => {
  const view = src('databases/TableView.tsx');
  expect(view).not.toMatch(/(document|window)\.addEventListener\('keydown'/);
  expect(view).toMatch(/onKeyDown=\{onEscCancel\(/);
  expect(view).toMatch(/import \{ onEscCancel \} from '\.\.\/confirms\/InlineConfirm';/);
});

test('the popover closes with its tab (unmount) and its statement; the hold is main\'s, read in one module', () => {
  const view = src('databases/TableView.tsx');
  expect(view).toMatch(/useEffect\(\(\) => \(\) => useTableUi\.getState\(\)\.closeSql\(tab\.key\), \[tab\.key\]\);/);
  expect(view).toMatch(/useEffect\(\(\) => useTableUi\.getState\(\)\.sync\(tab\.key, visible, sql\), \[tab\.key, visible, sql\]\);/);
  // The hold is main's (DbConnView.held, one truth for every window); hold.ts only reads it — the menus
  // and the reads both import it, so neither imports the other (no menus → actions → data → menus
  // cycle). Nothing in the renderer holds or releases a connection by itself.
  expect(view).toMatch(/^import \{ connectHeld, useHeld \} from '\.\/hold';$/m);
  expect(src('databases/data.ts')).toMatch(/^import \{ isHeld \} from '\.\/hold';$/m);
  expect(src('databases/hold.ts')).toMatch(/^export const heldIn = \(snap: DbSnapshot, id: string\): boolean => snap\.connections\.some\(\(v\) => v\.conn\.id === id && v\.held\);$/m);
  for (const f of ['hold.ts', 'menus.ts', 'data.ts', 'TableView.tsx', 'OverviewView.tsx', 'DatabasesList.tsx', 'ConnRow.tsx', 'store.ts', 'structure-data.ts']) {
    expect(src(`databases/${f}`), f).not.toMatch(/\bs\.disconnected\b|getState\(\)\.disconnected\b|\bdisconnected: \[|export const (hold|release)\b|\b(hold|release)\(/);
  }
  for (const f of ['data.ts', 'structure-data.ts', 'actions.ts', 'prompts.ts', 'hold.ts']) {
    expect(src(`databases/${f}`), f).not.toMatch(/^import [^;]*from '\.\/menus';$/m);
  }
  expect(src('databases/hold.ts')).not.toMatch(/^import [^;]*from '\.\/(?!store')/m);
});

test('the tab is told whether it has the keyboard, as the other views are', () => {
  expect(src('App.tsx')).toMatch(/<DbTabView tab=\{r\} visible=\{shownIn\(r\.key, activeTab === r\.key\)\} focused=\{focusedIn\(r\.key, activeTab === r\.key\)\}/);
  expect(src('components/PopoutWindow.tsx')).toMatch(/<DbTabView tab=\{table\} visible focused \/>/);
  expect(src('databases/TableView.tsx')).not.toMatch(/s\.split\.focus/);
});

test('the path gives way from its start: the connection\'s name first, then the schema; the table\'s name stays (the whole path in the tooltip)', () => {
  const blocks = containerRules();
  /** The widest block hiding exactly this selector (a rule naming it among its selectors, display: none). */
  const hides = (sel: string) => blocks.find((b) => [...b.body.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .some((r) => /display: none/.test(r[2]!) && r[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)))?.width;
  // ⋯ shows from 460 px: by then the connection's name has gone (a ~430 px split pane reads "public / orders" whole).
  expect(hides('.dbt-crumb-conn')).toBeGreaterThanOrEqual(460);
  expect(hides('.dbt-crumb-conn + .dbt-crumb-sep')).toBe(hides('.dbt-crumb-conn'));
  // Under 400 px, the table's name alone (no separator left around nothing).
  expect(hides('.dbt-crumb-schema')).toBe(400);
  expect(hides('.dbt-crumb-sep')).toBe(400);
  expect(blocks.some((b) => /\.dbt-crumb-name[^{]*\{[^}]*display: none/.test(b.body))).toBe(false);
});

test('narrower panes fold labels to icons (their names stay in the tooltips), widest-first, never wrapping the bar', () => {
  const blocks = containerRules();
  const at = (sel: string) => blocks.find((b) => new RegExp(`(^|[\\s,}])${sel.replace(/[.[\]]/g, '\\$&')}\\s*[,{]`).test(b.body));
  // The estimate goes first, then the view labels and the chip's word, then SQL's word.
  const est = at('.dbt-est');
  const views = at('.dbt-views-label');
  const ro = at('.dbt-ro-label');
  const sql = at('.dbt-sql-label');
  for (const [name, b] of [['estimate', est], ['view labels', views], ['read-only label', ro], ['SQL label', sql]] as const) {
    expect(b, name).toBeDefined();
    expect(b!.body, name).toMatch(/display: none/);
  }
  expect(est!.width).toBeGreaterThanOrEqual(views!.width);
  expect(views!.width).toBeGreaterThanOrEqual(sql!.width);
  // The Grid / Record toggle's labels go before anything else: the bar has room for them only when wide.
  const toggle = at('.dbt-rv-label');
  expect(toggle?.body).toMatch(/display: none/);
  expect(toggle!.width).toBeGreaterThan(est!.width);
  // At a split pane's width (~430 px) everything left fits: all four have folded by then.
  for (const b of [est!, views!, ro!, sql!]) expect(b.width).toBeGreaterThanOrEqual(430);
  // Three panes in a 900 px window: the Read-only chip goes too (the sidebar's footer and the tooltip still say it).
  const chip = blocks.find((b) => /(^|[\s,}])\.dbt-ro\s*\{[^}]*display: none/.test(b.body));
  expect(chip?.width).toBeLessThan(430);
});

test('a container query comes after the rules it narrows: @container adds no specificity (without it the footer\'s scroll hint never hid, its label cut to "100 loaded of ~…"; its narrow gap and padding never applied)', () => {
  const re = /@container dkv \(max-width: (\d+)px\) \{/g;
  const props = (decls: string) => [...decls.matchAll(/([\w-]+)\s*:/g)].map((p) => p[1]!);
  const late: string[] = [];
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) depth += code[i] === '{' ? 1 : code[i] === '}' ? -1 : 0;
    const body = code.slice(m.index + m[0].length, i - 1);
    // Every property this block sets, and a plain rule after the block that sets it again for the same selector.
    for (const h of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const set = props(h[2]!);
      for (const sel of h[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' '))) {
        for (const r of code.slice(i).matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
          if (!r[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)) continue;
          const again = props(r[2]!).filter((p) => set.includes(p));
          if (again.length > 0) late.push(`${sel}: ${again.join(', ')} (≤ ${m[1]} px, set again later)`);
        }
      }
    }
  }
  expect(late).toEqual([]);
});

test('the footer: its label ellipsizes before Count exactly and the time squeeze', () => {
  for (const p of [/min-width: 0/, /overflow: hidden/, /text-overflow: ellipsis/, /white-space: nowrap/]) expect(rule('.dbt-foot-label')).toMatch(p);
  for (const sel of ['.dbt-count', '.dbt-ms']) {
    expect(rule(sel), sel).toMatch(/flex: none/);
    expect(rule(sel), sel).toMatch(/white-space: nowrap/);
  }
  expect(rule('.dbt-foot')).toMatch(/flex: none/);
  expect(rule('.dbt-foot')).toMatch(/min-width: 0/);
  expect(rule('.dbt-foot-hint')).toMatch(/min-width: 0/);
  expect(rule('.dbt-foot-hint')).toMatch(/text-overflow: ellipsis/);
});

test('everything interactive answers hover and keyboard focus', () => {
  // The icon buttons are the app's .icon-btn (hover in layout.css); the view switch is Docker's .dk-views.
  for (const sel of ['.dbt-sql', '.dbt-link', '.dbt-ib']) {
    expect(rule(`${sel}:hover`), sel).toMatch(/color|background|box-shadow/);
    expect(rule(`${sel}:focus-visible`), sel).toMatch(/box-shadow: [^;]*var\(--violet\)/);
  }
});

test('nothing loops (idle motion budget): the skeleton breathes a few times and rests, the spinner is the app\'s .dk-spin', () => {
  expect(code).not.toMatch(/\binfinite\b/);
  expect(rule('.dbt-skel-bar')).toMatch(/animation: [^;]*var\(--cue-cycles-long\)/);
  expect(src('databases/MoreRow.tsx')).toContain('className="dk-spin"');
  // The refresh bar moves for the whole load — as many cycles as the query timeout lasts (set by the view), never more.
  expect(rule('.dbt-progress > i')).toMatch(/animation: atl-indeterminate [^;]*var\(--dbt-cycles\)/);
});

test('the grid scrolls inside the tab, its header stays; the bottom row\'s states each have their tone', () => {
  expect(rule('.dbt-grid')).toMatch(/overflow: auto/);
  expect(rule('.dbt-grid')).toMatch(/min-height: 0/);
  expect(rule('.dbt-table thead th')).toMatch(/position: sticky/);
  expect(rule('.dbt-more.is-error')).toMatch(/var\(--text-error\)|var\(--edge-error\)|var\(--tint-error/);
  expect(rule('.dbt-more.is-cap')).toMatch(/color: var\(--[\w-]+\)/);
});

test('the grid comes with the table\'s chunk: its component, cells and pure parts are the table view\'s own imports', () => {
  expect(src('databases/TableView.tsx')).toMatch(/^import \{ Grid \} from '\.\/Grid';$/m);
  expect(src('databases/Grid.tsx')).toMatch(/^import \{ Cell \} from '\.\/Cell';$/m);
  expect(src('databases/Grid.tsx')).not.toMatch(/^import '[^']*\.css';$/m);
  // The interim body is gone.
  expect(() => src('databases/InterimGrid.tsx')).toThrow();
  // No module whose name differs from Grid.tsx's or Cell.tsx's only by case: `./Grid` would find it first on a
  // case-insensitive disk (macOS), its .ts tried before the .tsx.
  const names = readdirSync(join(RENDERER, 'databases')).filter((f) => !/\.test\./.test(f)).map((f) => f.replace(/\.tsx?$/, ''));
  for (const c of ['Grid', 'Cell', 'Inspector']) expect(names.filter((x) => x.toLowerCase() === c.toLowerCase())).toEqual([c]);
});

test('the header at every width: names ellipsize, icons and the sort arrow never squeeze, the type line one line', () => {
  expect(rule('.dbt-th-line')).toMatch(/display: flex/);
  expect(rule('.dbt-th-line')).toMatch(/min-width: 0/);
  for (const p of [/min-width: 0/, /overflow: hidden/, /text-overflow: ellipsis/, /white-space: nowrap/]) {
    expect(rule('.dbt-th-name'), String(p)).toMatch(p);
    expect(rule('.dbt-th-type'), String(p)).toMatch(p);
  }
  for (const sel of ['.dbt-th-pk', '.dbt-th-fk', '.dbt-th-drv', '.dbt-th-sort']) expect(rule(sel), sel).toMatch(/flex: none/);
  // The edge to resize: on top of the header's content, a resize cursor.
  expect(rule('.dbt-th-rs')).toMatch(/position: absolute/);
  expect(rule('.dbt-th-rs')).toMatch(/cursor: col-resize/);
  expect(rule('.dbt-th-btn:hover')).toMatch(/color|background/);
});

test('cells at every width: one line with an ellipsis (Wrap Cells aside); chips never wrap inside themselves', () => {
  for (const p of [/white-space: nowrap/, /overflow: hidden/, /text-overflow: ellipsis/]) expect(rule('.dbt-table td'), String(p)).toMatch(p);
  expect(rule('.dbt-table.is-wrap td')).toMatch(/white-space: (normal|pre-wrap)/);
  expect(rule('.dbt-wrapc')).toMatch(/-webkit-line-clamp: 6/);
  for (const sel of ['.dbt-en', '.dbt-ach', '.dbt-bool', '.dbt-nul', '.dbt-emp']) {
    expect(rule(sel), sel).toMatch(/white-space: nowrap/);
    expect(rule(sel), sel).toMatch(/flex: none/);
  }
});

test('a cut value\'s mark is never clipped: the value gives way, the mark keeps its room', () => {
  expect(rule('.dbt-cutbox')).toMatch(/display: (inline-)?flex/);
  expect(rule('.dbt-cutbox')).toMatch(/max-width: 100%/);
  expect(rule('.dbt-cutbox')).toMatch(/min-width: 0/);
  for (const p of [/min-width: 0/, /overflow: hidden/, /text-overflow: ellipsis/, /white-space: nowrap/]) expect(rule('.dbt-cutv'), String(p)).toMatch(p);
  expect(rule('.dbt-cut')).toMatch(/flex: none/);
  // Wrapped, the value wraps inside its box and the mark stays at the top.
  expect(rule('.dbt-wrapc .dbt-cutv')).toMatch(/white-space: pre-wrap/);
  expect(rule('.dbt-wrapc .dbt-cutbox')).toMatch(/align-items: flex-start/);
});

test('a foreign key\'s value and a bytea\'s hex give way; the arrow and the size never squeeze', () => {
  for (const sel of ['.dbt-fkv > span', '.dbt-bytes > .dbt-hex']) {
    for (const p of [/min-width: 0/, /overflow: hidden/, /text-overflow: ellipsis/]) expect(rule(sel), `${sel} ${p}`).toMatch(p);
  }
  for (const sel of ['.dbt-fkv > svg', '.dbt-size', '.dbt-ach']) expect(rule(sel), sel).toMatch(/flex: none/);
});

test('Wrap Cells rows are exactly WRAP_ROW_H tall: six lines, the padding and the row\'s border', () => {
  // grid-model.ts's constant, read from its source (this side's tsconfig doesn't compile the renderer's JSX).
  const m = /export const WRAP_ROW_H = (\d+) \* (\d+) \+ (\d+);/.exec(src('databases/grid-model.ts'))!;
  const WRAP_ROW_H = Number(m[1]) * Number(m[2]) + Number(m[3]);
  const px = (v: string) => v.split(/\s+/).map((x) => Number(x.replace('px', '')));
  const pad = px(/padding: ([^;]+)/.exec(rule('.dbt-table.is-wrap td'))![1]!);
  const [top, , bottom = top] = pad;
  const max = Number(/max-height: (\d+)px/.exec(rule('.dbt-wrapc'))![1]);
  const line = Number(/line-height: (\d+)px/.exec(rule('.dbt-wrapc'))![1]);
  const border = Number(/border-bottom: (\d+)px/.exec(rule('.dbt-table td'))![1]);
  expect(max).toBe(6 * line);
  expect(top! + bottom! + max + border).toBe(WRAP_ROW_H);
  expect(WRAP_ROW_H).toBe(120);
});

test('the grid acts on a key only when it reaches the grid itself (Retry keeps its Enter)', () => {
  expect(src('databases/Grid.tsx')).toMatch(/const onKeyDown = \(e: KeyboardEvent<HTMLDivElement>\) => \{\n\s*if \(e\.defaultPrevented \|\| !ownKey\(e\.target, e\.currentTarget\)\) return;/);
});

test('a scroll frame reads only the scroll and the viewport\'s height; the rest is measured on resize', () => {
  const grid = src('databases/Grid.tsx');
  const frame = /const frame = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/.exec(grid)?.[1] ?? '';
  expect(frame).toMatch(/scrollTop/);
  expect(frame).not.toMatch(/scrollWidth|offsetWidth|offsetHeight|clientWidth|getBoundingClientRect/);
  expect(grid).toMatch(/const measure = useCallback\(/);
  expect(grid).toMatch(/onScroll = \(\) => \{ if \(!raf\.current\) raf\.current = requestAnimationFrame\(frame\); \}/);
});

test('Shift+F10 always opens a cell\'s menu: the focused one brought into view first, else the first row on screen', () => {
  const grid = src('databases/Grid.tsx');
  const menu = /const onGridMenu = [\s\S]*?\n {2}\};/.exec(grid)?.[0] ?? '';
  expect(menu).toMatch(/menuCell\(/);
  // Brought into view, then placed from the widths and the scroll (no forced render, no drawn row needed).
  expect(menu).toMatch(/reveal\([\s\S]*menuPoint\(/);
});

test('no number changes on its way: JSON is read as text in the grid, its copies and the inspector, never through JSON.parse', () => {
  for (const f of ['databases/Cell.tsx', 'databases/grid-model.ts', 'databases/grid-copy.ts', 'databases/json-text.ts', 'databases/Grid.tsx', 'databases/Inspector.tsx',
    'databases/inspector-model.ts', 'databases/inspector-data.ts', 'databases/RecordView.tsx', 'databases/record.ts']) {
    expect(src(f).replace(/\/\/.*$/gm, ''), f).not.toMatch(/JSON\.parse|parseFloat|Number\(raw|Number\(v\b/);
  }
});

test('one of each: the copies in grid-copy.ts, the mask predicate pg-format\'s, JSON detection json-text\'s', () => {
  const model = src('databases/grid-model.ts');
  const copy = src('databases/grid-copy.ts');
  expect(model).not.toMatch(/export function (copyText|rowsAs)\b/);
  expect(copy).toMatch(/export function copyText\b/);
  expect(copy).toMatch(/export function rowsAs\b/);
  for (const [f, s] of [['grid-model.ts', model], ['grid-copy.ts', copy], ['Cell.tsx', src('databases/Cell.tsx')]] as const) {
    expect(s, f).not.toMatch(/MASK_COLUMN/);
    expect(s, f).not.toMatch(/\[\[\{\]/);
  }
  expect(src('../shared/pg-format.ts')).toMatch(/^export function isMasked\(/m);
});

test('the row numbers stay in place: sticky on the left, opaque (cells scroll under them), a fixed width', () => {
  expect(rule('.dbt-table .dbt-rn')).toMatch(/position: sticky/);
  expect(rule('.dbt-table .dbt-rn')).toMatch(/left: 0/);
  expect(rule('.dbt-table .dbt-rn')).toMatch(/background: var\(--bg-2\)/);
  expect(rule('.dbt-table thead th.dbt-rn')).toMatch(/z-index: [3-9]/);
});

test('the right fade never covers the last column\'s resize edge: it lets the pointer through, and goes at the end', () => {
  expect(rule('.dbt-fade')).toMatch(/pointer-events: none/);
  expect(rule('.dbt-fade')).toMatch(/position: absolute/);
  expect(src('databases/Grid.tsx')).toMatch(/fade && <div className="dbt-fade"/);
});

test('selection, focus and hover each have their state (never flat)', () => {
  // A selected row keeps its tint under the pointer (its rule comes after hover's, as specific).
  expect(rule('.dbt-table tbody tr.is-sel td')).toMatch(/background/);
  expect(code.indexOf('.dbt-table tbody tr.is-sel td {')).toBeGreaterThan(code.indexOf('.dbt-table tbody tr:hover td {'));
  expect(rule('.dbt-table td.is-focus')).toMatch(/box-shadow: inset 0 0 0 1\.5px var\(--[\w-]+\)/);
  expect(rule('.dbt-table tbody tr:hover td')).toMatch(/background/);
  // The keyboard in the grid: the focused cell in full violet.
  expect(rule('.dbt-grid:focus td.is-focus')).toMatch(/var\(--violet\)/);
  // The row numbers stay opaque under hover and selection too.
  expect(rule('.dbt-table tbody tr:hover td.dbt-rn')).toMatch(/var\(--bg-2\)/);
  expect(rule('.dbt-table tbody tr.is-sel td.dbt-rn')).toMatch(/var\(--bg-2\)/);
});

test('the grid\'s keys are listed in Settings › Keyboard\'s Databases group', () => {
  const db = SHORTCUTS.find((g) => g.title === 'Databases')!.items;
  const label = (keys: string) => db.find((i) => i.keys === keys)?.label ?? '';
  expect(label('↑ ↓')).toMatch(/row/i);
  expect(label('⇧↑ ⇧↓')).toMatch(/extend/i);
  expect(label('⌘A')).toMatch(/every row loaded/i);
  expect(label('Esc')).toMatch(/clear/i);
  expect(label('⏎')).toMatch(/inspector/i);
  expect(label('⌘C')).toMatch(/TSV/);
  expect(label('⌥Z')).toMatch(/wrap/i);
  expect(label('⇧-click')).toMatch(/sort/i);
  // Tab opens the focused row as a record; Tab or Esc comes back.
  expect(label('⇥')).toMatch(/record/i);
  expect(label('⇥')).toMatch(/as a record/);
  expect(label('⇥')).toMatch(/Tab or Esc returns/);
  expect(label('⇥')).not.toMatch(/inspector/i);
  // ⌥Z wraps cells in a table tab, as it wraps lines in an editor: never a menu item's key.
  const accels = menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator ? [i.accelerator] : []));
  for (const k of ['⌥Z', '⌘A', '⌘C']) expect(accels.map(keysOf)).not.toContain(k);
});

test('⌘R refreshes a table tab: listed in Settings › Keyboard, and no menu item takes ⌘R (dev\'s Reload has no accelerator of its own)', () => {
  const accels = menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator ? [i.accelerator] : []));
  expect(accels.map(keysOf)).not.toContain('⌘R');
  const row = SHORTCUTS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title }))).find((i) => i.keys === '⌘R');
  expect(row).toBeDefined();
  expect(row!.group).toBe('Databases');
  expect(row!.label).toMatch(/table tab/i);
});
