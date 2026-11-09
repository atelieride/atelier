// databases.css and databases-tabs.css: the Databases view's own stylesheet,
// loaded with the view's lazy chunk, and the few rules the first paint needs (the tab strip's), loaded with the app's
// styles (the live demo's first-paint budget). Colors only through Aurora's tokens (production in the
// theme's danger color), no selector of another stylesheet redefined, and the layout rules that hold at every width:
// names truncate, chips and counts never shrink or wrap.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'databases.css');
const TABS = join(RENDERER, 'databases-tabs.css');
const own = readFileSync(OWN, 'utf8');
const tabsCss = readFileSync(TABS, 'utf8');
const code = [own, tabsCss].join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
}

/** Every selector of a stylesheet's rules (comments and at-rule preludes dropped), whitespace normalized. */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => s && !s.startsWith('@'))
    .flatMap((s) => s.split(',')).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** The declarations of every rule that names `sel` among its selectors, joined. */
const rule = (sel: string) => [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]!).join(';');

test('the first paint carries only the tab strip\'s rules, after layout.css; the view\'s stylesheet comes with its lazy chunk', () => {
  const styles = readFileSync(join(RENDERER, 'styles.ts'), 'utf8');
  expect(styles).toMatch(/^import '\.\/databases-tabs\.css';$/m);
  expect(styles.indexOf("'./databases-tabs.css'")).toBeGreaterThan(styles.indexOf("'./layout.css'"));
  expect(styles).not.toContain("'./databases.css'");
  // The lazy modules that draw with it bring it: the sidebar list and a table tab's view.
  for (const f of ['databases/DatabasesList.tsx', 'databases/DbTabView.tsx']) expect(readFileSync(join(RENDERER, f), 'utf8'), f).toMatch(/^import '\.\.\/databases\.css';$/m);
  // Nothing but the strip and the footer's item: every selector of the first-paint file is one of theirs.
  expect(selectors(tabsCss).filter((s) => !/^\.tab[.:\s-]/.test(s) && !/^\.db-foot-item\b/.test(s))).toEqual([]);
});

/** A selector's specificity [ids, classes, elements] — `:not(x)` counts as x; enough for this file's selectors. */
function specificity(sel: string): [number, number, number] {
  const n: [number, number, number] = [0, 0, 0];
  const rest = sel.replace(/:not\(([^)]*)\)/g, (_, inner: string) => { specificity(inner).forEach((v, i) => { n[i] = (n[i] ?? 0) + v; }); return ''; });
  n[0] += (rest.match(/#[\w-]+/g) ?? []).length;
  n[1] += (rest.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  n[2] += (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return n;
}
const outranks = (a: string, b: string) => {
  const [x, y] = [specificity(a), specificity(b)];
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
};

test('the footer\'s item gives way first: it shrinks before any other item, its name ellipsized; production in the danger color', () => {
  // Every footer item may shrink (their text can wrap): this one's flex-shrink outweighs theirs (1) by far, so it
  // gives up its room first — down to nothing (min-width 0) — and its name ellipsizes instead of wrapping.
  const shrink = Number(/flex-shrink: (\d+)/.exec(rule('.db-foot-item'))?.[1]);
  expect(shrink).toBeGreaterThanOrEqual(100);
  const layout = readFileSync(join(RENDERER, 'layout.css'), 'utf8');
  for (const m of layout.matchAll(/\.foot[\w-]*[^{}]*\{[^}]*flex-shrink: (\d+)/g)) expect(Number(m[1])).toBeLessThan(shrink);
  expect(rule('.db-foot-item')).toMatch(/min-width: 0/);
  expect(rule('.db-foot-item')).toMatch(/max-width: \d+px/);
  expect(rule('.db-foot-item span')).toMatch(/overflow: hidden/);
  expect(rule('.db-foot-item span')).toMatch(/text-overflow: ellipsis/);
  expect(rule('.db-foot-item span')).toMatch(/white-space: nowrap/);
  expect(rule('.db-foot-item.is-prod')).toMatch(/color: var\(--text-error\)/);
  expect(rule('.db-foot-item.is-prod i')).toMatch(/background: var\(--error\)/);
  expect(rule('.db-foot-item i')).toMatch(/flex: none/);
  // Production keeps its color on hover: its rule outranks the footer buttons' hover color (layout.css).
  expect(layout).toMatch(/button\.foot-item:not\(:disabled\):hover \{ color: var\(--text-2\); \}/);
  expect(rule('.db-foot-item.is-prod:not(:disabled):hover')).toMatch(/color: var\(--text-error\)/);
  expect(outranks('.db-foot-item.is-prod:not(:disabled):hover', 'button.foot-item:not(:disabled):hover')).toBe(true);
  expect(outranks('.db-foot-item.is-prod', 'button.foot-item:not(:disabled):hover')).toBe(false); // why the hover rule is needed
  expect(layout).toMatch(/\.foot-item \{ display: inline-flex;[^}]*\}/);
  // The markup these rules style (foot.test.ts renders it): a footer button whose click opens the view.
  const footer = readFileSync(join(RENDERER, 'components/Footer.tsx'), 'utf8');
  expect(footer).toMatch(/className=\{`foot-item db-foot-item[^`]*`\}[^>]*onClick=\{\(\) => useApp\.getState\(\)\.setActivity\('databases'\)\}>\s*<i \/><span>/);
});

test('the sidebar list is lazy: Sidebar imports it on demand, never statically, nor anything that only it uses', () => {
  const sidebar = readFileSync(join(RENDERER, 'components/Sidebar.tsx'), 'utf8');
  expect(sidebar).toMatch(/const DatabasesList = lazy\(\(\) => import\('\.\.\/databases\/DatabasesList'\)/);
  expect(sidebar).toMatch(/<Suspense fallback=\{.*?\}><DatabasesList \/><\/Suspense>/);
  // The first paint's modules never reach the sidebar's own: they'd pull it back into the entry chunk.
  const firstPaint = ['components/Sidebar.tsx', 'components/Tabs.tsx', 'components/ActivityBar.tsx', 'App.tsx', 'store.ts', 'databases/install.ts',
    'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts', 'move-window.ts'];
  const own = '(DatabasesList|ConnRow|Catalog|menus|side|test-render)';
  for (const f of firstPaint) {
    const src = readFileSync(join(RENDERER, f), 'utf8');
    const reach = f.startsWith('databases/') ? new RegExp(`^import [^;]*from '\\./${own}'`, 'm') : new RegExp(`^import [^;]*from '[./]*databases/${own}'`, 'm');
    expect(src, f).not.toMatch(reach);
    expect(src, f).not.toMatch(/^import [^;]*from '[./]*i18n\/db'/m);
  }
});

test('colors only through the theme\'s tokens: no hex, rgb or hsl value of its own', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
});

test('redefines no selector of another stylesheet, nor of each other', () => {
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN && f !== TABS) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  const clashes = [...selectors(own), ...selectors(tabsCss)].filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`);
  expect(clashes).toEqual([]);
  const mine = new Set(selectors(own));
  expect(selectors(tabsCss).filter((s) => mine.has(s))).toEqual([]);
});

test('production reads in the theme\'s danger color: the tag and the glyph\'s edge', () => {
  expect(rule('.db-env.is-prod')).toMatch(/color: var\(--text-error\)/);
  expect(rule('.db-env.is-prod')).toMatch(/var\(--edge-error\)/);
  expect(rule('.db-conn.is-prod .db-glyph')).toMatch(/var\(--edge-error\)/);
  expect(rule('.db-st.is-error')).toMatch(/background: var\(--error\)/);
});

test('rows in their state (6): an error\'s glyph in the danger color, idle ones quieter than connected ones', () => {
  expect(rule('.db-conn.is-error .db-glyph')).toMatch(/color: var\(--text-error\)/);
  expect(rule('.db-conn')).toMatch(/color: var\(--text\)/);
  expect(rule('.db-conn.is-idle')).toMatch(/color: var\(--text-2\)/);
  expect(rule('.db-conn:hover')).toMatch(/color: var\(--text\)/);
  expect(code.indexOf('.db-conn:hover')).toBeGreaterThan(code.indexOf('.db-conn.is-idle {'));
});

test('a button waiting for main says so without moving (no spinner growing it), and Show all is a quiet row', () => {
  expect(rule('.db-side [aria-busy="true"]')).toMatch(/cursor: progress/);
  expect(rule('.db-side [aria-busy="true"]')).not.toMatch(/width|padding|margin/);
  expect(rule('.db-more')).toMatch(/white-space: nowrap/);
  expect(rule('.db-more:focus-visible')).toMatch(/box-shadow: inset 0 0 0 1\.5px var\(--violet\)/);
  expect(rule('.db-note-code')).toMatch(/color: var\(--text-4\)/);
});

test('every state dot has its color: connected, idle, needs a password, error, connecting', () => {
  for (const s of ['ok', 'idle', 'warn', 'error', 'busy']) expect(rule(`.db-st.is-${s}`), s).toMatch(/background: var\(--[\w-]+\)/);
});

test('names and sub lines truncate with an ellipsis instead of pushing their row wider', () => {
  for (const sel of ['.db-name', '.db-conn-sub', '.db-rel-name', '.db-schema-name', '.db-rel-ret']) {
    const r = rule(sel);
    expect(r, sel).toMatch(/min-width: 0/);
    expect(r, sel).toMatch(/overflow: hidden/);
    expect(r, sel).toMatch(/text-overflow: ellipsis/);
    expect(r, sel).toMatch(/white-space: nowrap/);
  }
  // Their flex parents let them shrink.
  for (const sel of ['.db-conn', '.db-conn-text', '.db-conn-name', '.db-rel', '.db-schema', '.db-cat-bar', '.db-note']) {
    expect(rule(sel), sel).toMatch(/min-width: 0/);
  }
});

test('tags, counts, glyphs and buttons keep their size and never wrap', () => {
  for (const sel of ['.db-env', '.db-glyph', '.db-head-count', '.db-sec-count', '.db-rel-count']) {
    expect(rule(sel), sel).toMatch(/flex: none/);
  }
  for (const sel of ['.db-env', '.db-head-count', '.db-sec-count', '.db-rel-count', '.db-note-actions > button']) {
    expect(rule(sel), sel).toMatch(/white-space: nowrap/);
  }
});

test('a note out of room stacks its buttons; a label wider than the sidebar ellipsizes instead of spilling out', () => {
  expect(rule('.db-note-actions')).toMatch(/flex-wrap: wrap/);
  expect(rule('.db-note-actions > button')).toMatch(/max-width: 100%/);
  // The buttons are flex boxes: their label's own box ellipsizes.
  for (const p of [/min-width: 0/, /overflow: hidden/, /text-overflow: ellipsis/]) expect(rule('.db-note-actions > button > span')).toMatch(p);
  // The password row likewise: Connect drops under Save in Keychain rather than squeezing it.
  expect(rule('.db-pass-row')).toMatch(/flex-wrap: wrap/);
  expect(rule('.db-pass-row > button')).toMatch(/margin-left: auto/);
  expect(rule('.db-cat-bar')).toMatch(/flex-wrap: wrap/);
});

test('notes in their tone: a problem in the danger color', () => {
  expect(rule('.db-note.is-err')).toMatch(/var\(--edge-error\)/);
  expect(rule('.db-note-detail')).toMatch(/color: var\(--text-error\)/);
});

test('the write note is one quiet line — an amber dot, the sentence ellipsized, a × that answers hover and focus; none of them pushes the line wider', () => {
  expect(rule('.db-write')).toMatch(/min-width: 0/);
  expect(rule('.db-write')).toMatch(/display: flex/);
  expect(rule('.db-write')).not.toMatch(/background|box-shadow|border/);
  for (const p of [/min-width: 0/, /overflow: hidden/, /text-overflow: ellipsis/, /white-space: nowrap/]) expect(rule('.db-write-text')).toMatch(p);
  for (const sel of ['.db-write-dot', '.db-write-x']) expect(rule(sel), sel).toMatch(/flex: none/);
  expect(rule('.db-write-dot')).toMatch(/background: var\(--waiting-mark\)/);
  expect(rule('.db-write-x:hover')).toMatch(/color: var\(--text\)/);
  expect(rule('.db-write-x:focus-visible')).toMatch(/box-shadow: inset 0 0 0 1\.5px var\(--violet\)/);
});

test('the database chip and the schema chip share one line, each ellipsizing its name; the server\'s other databases are quiet rows', () => {
  expect(rule('.db-schema')).toMatch(/max-width: calc\(50% - 3px\)/);
  expect(rule('.db-schema > svg')).toMatch(/flex: none/);
  expect(rule('.db-database > svg:first-child')).toMatch(/color: var\(--violet-light\)/);
  expect(rule('.db-other-db')).toMatch(/color: var\(--text-2\)/);
});

test('Refresh turns while it runs (still under Reduce motion, dimmed instead) and the catalog under it dims, nothing moving', () => {
  // A few turns, then it rests (the idle motion budget: tests/integration/motion-budget.test.ts).
  expect(rule('.db-side .icon-btn.is-busy > svg')).toMatch(/animation: atl-spin \.6s linear var\(--cue-cycles-long\)/);
  expect(rule(':root[data-motion="reduced"] .db-side .icon-btn.is-busy > svg')).toMatch(/animation: none/);
  expect(rule(':root[data-motion="reduced"] .db-side .icon-btn.is-busy > svg')).toMatch(/opacity: \.45/);
  for (const sel of ['.db-list.is-refreshing > .db-rel', '.db-list.is-refreshing > .db-fold', '.db-list.is-refreshing > .db-cat-note']) {
    expect(rule(sel), sel).toMatch(/opacity: \.55/);
  }
  for (const sel of ['.db-rel', '.db-fold']) expect(rule(sel), sel).toMatch(/opacity var\(--t-med\)/);
});

test('the catalog\'s bar stays in view while its tables scroll; fold heads answer hover and focus', () => {
  expect(rule('.db-cat-bar')).toMatch(/position: sticky/);
  expect(rule('.db-fold:hover')).toMatch(/color/);
  expect(rule('.db-fold:focus-visible')).toMatch(/box-shadow: inset 0 0 0 1\.5px var\(--violet\)/);
  expect(rule('.db-fold[aria-expanded="true"] > svg')).toMatch(/transform: rotate\(90deg\)/);
});

test('nothing of the suggestions is left — no card, no sheet row, no command to copy', () => {
  for (const cls of ['.db-sug', '.db-found', '.db-code', '.db-hint']) expect(code, cls).not.toContain(cls);
});

test('rows answer hover and keyboard focus, the focus ring still visible on the selected row', () => {
  for (const row of ['.db-conn', '.db-rel']) {
    expect(rule(`${row}:hover`), row).toMatch(/background/);
    expect(rule(`${row}:focus-visible`), row).toMatch(/box-shadow: inset 0 0 0 1\.5px var\(--violet\)/);
    expect(code.indexOf(`${row}:focus-visible`), row).toBeGreaterThan(code.indexOf(`${row}.is-selected {`));
  }
});

test('table tabs: production framed inside the tab (its width never changes), icon and dot never shrink, the name mono', () => {
  expect(rule('.tab.is-prod')).toMatch(/box-shadow: inset 0 0 0 1px var\(--edge-error\)/);
  expect(rule('.tab.is-prod')).not.toMatch(/border|padding|margin|width/);
  for (const sel of ['.tab-db', '.tab-env']) expect(rule(sel), sel).toMatch(/flex: none/);
  for (const env of ['local', 'dev', 'staging', 'prod']) expect(rule(`.tab-env.is-${env}`), env).toMatch(/background: var\(--[\w-]+\)/);
  expect(rule('.tab-env.is-prod')).toMatch(/background: var\(--error\)/);
  expect(rule('.tab.is-db .tab-name')).toMatch(/font-family: var\(--mono\)/);
  expect(rule('.tab.is-db .tab-name')).toMatch(/font-size: 12px/);
});

test('production\'s frame keeps the strip\'s own shadow states (it loads later at the same weight): the drop caret too', () => {
  const layout = readFileSync(join(RENDERER, 'layout.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Every `.tab.is-<state>` rule of layout.css with a box-shadow and no more weight than `.tab.is-prod`.
  const states = [...layout.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => {
    const shadow = /box-shadow:\s*([^;]+)/.exec(m[2]!)?.[1]?.trim();
    return shadow ? m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => /^\.tab\.is-[a-z-]+$/.test(s)).map((sel) => ({ sel, shadow })) : [];
  });
  expect(states.map((s) => s.sel)).toContain('.tab.is-drop');
  for (const { sel, shadow } of states) {
    const both = rule(`.tab.is-prod${sel.slice('.tab'.length)}`);
    expect(both, sel).toContain(shadow);
    expect(both, sel).toContain('inset 0 0 0 1px var(--edge-error)');
  }
});

test('a table tab\'s view: production\'s 2 px top hairline in the danger color; a long name breaks, its line truncates, the tag whole', () => {
  expect(rule('.db-tab.is-prod')).toMatch(/inset 0 2px 0 var\(--error\)/);
  expect(rule('.db-tab .dk-state-title')).toMatch(/overflow-wrap: anywhere/);
  expect(rule('.db-tab-sub > span')).toMatch(/min-width: 0/);
  expect(rule('.db-tab-sub > span')).toMatch(/text-overflow: ellipsis/);
  expect(rule('.db-tab-sub > span')).toMatch(/white-space: nowrap/);
  expect(rule('.db-tab-sub')).toMatch(/min-width: 0/);
  expect(rule('.db-tab-sub > .db-env')).toMatch(/flex: none/);
});

test('the sidebar holds its footer at the bottom and scrolls the list between', () => {
  expect(rule('.sidebar.is-db')).toMatch(/overflow: hidden/);
  expect(rule('.db-list')).toMatch(/flex: 1/);
  expect(rule('.db-list')).toMatch(/min-height: 0/);
  expect(rule('.db-list')).toMatch(/overflow-y: auto/);
  expect(rule('.db-foot')).toMatch(/flex: none/);
});
