import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SENSITIVE, findBanned } from '../support/banned-strings';

// Static checks on the visual system.
const dir = join(__dirname, '../../src/renderer');
const css = readFileSync(join(dir, 'theme.css'), 'utf8');
const fonts = readFileSync(join(dir, 'fonts.ts'), 'utf8');

test('spec Aurora tokens present', () => {
  for (const tok of ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-hover', '--bg-sel', '--line', '--line-soft', '--line-strong',
    '--text', '--text-2', '--text-3', '--text-4', '--brand', '--violet', '--pink', '--waiting', '--working', '--done', '--error', '--glow']) {
    expect(css, tok).toContain(`${tok}:`);
  }
});

test('no Geist and no v1 tokens', () => {
  expect(css).not.toMatch(/Geist/);
  expect(css).not.toMatch(/--accent:|--running:/);
  expect(fonts).not.toMatch(/Geist/);
});

test('the pop-out bar is as tall as dock-target counts it (a tab popped out opens at its pane\'s size plus the bar)', () => {
  const layout = readFileSync(join(dir, 'layout.css'), 'utf8');
  const rule = /\.popout-bar \{[^}]*\}/.exec(layout)?.[0] ?? '';
  const px = /export const POPOUT_BAR_PX = (\d+);/.exec(readFileSync(join(dir, 'dock-target.ts'), 'utf8'))?.[1];
  expect(px).toBeDefined();
  expect(rule).toContain(`height: ${px}px`);
});

test('motion off with "reduce motion"', () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
});

test('Aurora fonts included', () => {
  expect(fonts).toContain("'Instrument Sans'");
  expect(fonts).toContain("'JetBrains Mono'");
});

const layout = readFileSync(join(dir, 'layout.css'), 'utf8');
const cm = readFileSync(join(dir, 'editor/cmTheme.ts'), 'utf8');
const rule = (sel: string) => [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => m[1]!.split(',').some((s) => s.trim() === sel)).map((m) => m[2]!).join(';');

test('Poppins (the Docsy themes) loads on demand, from a module of its own', () => {
  expect(fonts).toMatch(/import\('\.\/fonts-poppins'\)/);
  expect(fonts).not.toContain('@fontsource/poppins');
  const poppins = readFileSync(join(dir, 'fonts-poppins.ts'), 'utf8');
  for (const w of [400, 500, 600, 700]) {
    expect(poppins).toContain(`@fontsource/poppins/files/poppins-latin-${w}-normal.woff2`);
    expect(poppins).toContain(`@fontsource/poppins/files/poppins-latin-ext-${w}-normal.woff2`);
  }
});

test('the tear-off ghost waits for a theme\'s own face before it shows its card (no font swap under the pointer)', () => {
  const ghost = readFileSync(join(dir, 'ghost/main.ts'), 'utf8');
  expect(ghost).toMatch(/card\.classList\.add\('is-fonts-pending'\);\s*void loadThemeFonts\(\)\.finally\(\(\) => card\.classList\.remove\('is-fonts-pending'\)\)/);
  expect(readFileSync(join(dir, 'ghost/ghost.css'), 'utf8')).toMatch(/\.ghost\.is-fonts-pending \{ visibility: hidden; \}/);
});

test('the stylesheets the live demo carries as text (theme.css, themes.css) never name what the site must not', () => {
  // theme-source.ts reads them raw, comments included; the demo build fails on these too, slowly (demo-build.test.ts).
  for (const f of ['theme.css', 'themes.css']) expect(findBanned(readFileSync(join(dir, f), 'utf8'), SENSITIVE), f).toEqual([]);
});

test('JetBrains Mono without ligatures', () => {
  expect(css).toMatch(/\.mono \{[^}]*font-variant-ligatures: none/);
  expect(cm).toMatch(/fontVariantLigatures: 'none'/);
});

test('essential text never in --text-4 (contrast below 4.5:1)', () => {
  for (const sel of ['.tab', '.change-dir', '.palette-hint', '.term-cmd', '.foot-dim', '.search', '.project-path']) {
    expect(rule(sel), sel).not.toContain('var(--text-4)');
  }
});

test('v1.8 surfaces (bell, notification center, inbox) use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(bell-|notes?-|inbox-)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(10);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('v1.9 surfaces (review view, line comments) use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(rv-|review-|lc-|change-group-review|changes-review)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(20);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('v2.0 trigger surfaces (editor, highlights, center filter) use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(trg-|notes-filter|note-bolt|note-count)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(12);
  // A trigger entry that joined repeated matches shows its count (×N).
  expect(rule('.note-count')).toMatch(/var\(--/);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
  // A highlight never takes the pointer: selection and links underneath keep working.
  expect(rule('.trg-hit')).toMatch(/pointer-events: none/);
});

test('the ⌘K shortcut stays at the end of the search', () => {
  expect(rule('.search-placeholder')).toMatch(/flex: 1/);
});

test('updater surfaces (Settings › About card, notes, footer notice) use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(upd-|foot-update\.is-quiet)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(8);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('background work chips and row ports use tokens, pills, the pop entrance; no shimmer', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(work-|sched-|row-ports)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(8);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
  for (const sel of ['.work-chip', '.sched-chip']) {
    expect(rule(sel), sel).toMatch(/border-radius: 999px/);
    expect(rule(sel), sel).toMatch(/atl-pop/);
  }
  // A thin outline with the working dot: no shimmer, no pulse.
  expect(layout).not.toMatch(/\.work-chip[^{]*\.shimmer/);
  expect(rule('.work-dot')).toMatch(/background: var\(--working\)/);
  // A summary of three kinds compacts a medium line on its own, like ports, a clock or the plan badge do (inside
  // :where(), so the narrower renderings win over it).
  expect(layout).toMatch(/:where\(:has\([^)]*\.work-chip\.is-long\)\) \.session-sub \.work-full \{ display: none; \}/);
  // A compact row's folder glyph is quiet, its worktree glyph keeps the worktree's cyan.
  expect(layout).toMatch(/\[data-tight\] \.cwd-chip:not\(\.is-wt\) svg \{ color: var\(--text-3\); \}/);
  expect(layout).not.toMatch(/\[data-tight\] \.cwd-chip svg \{/);
  // The plan badge keeps its uppercase form at every width.
  expect(layout).not.toMatch(/\.plan-badge \{[^}]*text-transform: none/);
});

test('Connectors surfaces (cards, confirm, gear and section dots) use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(conn-|btn-danger|set-nav-dot|act-dot\.is-quiet|btn-ghost\.is-strong)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(25);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('task surfaces (palette rows, status dots, the chip) use tokens; every tone has its dot; the chip is a pill', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(task-|tchip)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(10);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
  for (const tone of ['idle', 'working', 'waiting', 'done', 'error', 'violet']) expect(layout, tone).toContain(`.task-dot.tone-${tone}`);
  expect(rule('.tchip')).toMatch(/border-radius: 999px/);
  expect(rule('.tchip')).toMatch(/atl-pop/);
  expect(layout).toMatch(/\.tchip:hover/);
  expect(layout).toMatch(/\.tchip:focus-visible/);
  // The display id never wraps or shrinks in a row; offline rows are greyed.
  expect(rule('.task-id')).toMatch(/white-space: nowrap/);
  expect(rule('.palette-item.task-item.is-stale')).toMatch(/opacity/);
});

test('a chosen segment (Settings and the Session panel) is one token, not a copied gradient', () => {
  expect(css).toMatch(/--seg-on:/);
  expect(rule('.set-seg-opt.is-on')).toContain('var(--seg-on)');
  expect(rule('.spanel-model.is-on')).toContain('var(--seg-on)');
  expect(rule('.set-seg-opt.is-on')).toContain('var(--seg-on-shadow)');
  expect(rule('.spanel-model.is-on')).toContain('var(--seg-on-shadow)');
  expect(layout).not.toMatch(/linear-gradient\(135deg, rgba\(139,92,246,\.55\), rgba\(236,72,153,\.38\)\)/);
});

test('the status colors a task tone is matched against are the theme\'s state tokens (theme.css stays the source)', async () => {
  const { TONE_COLORS } = await import('../../src/renderer/task-view');
  for (const [tone, hex] of Object.entries(TONE_COLORS)) expect(css, tone).toMatch(new RegExp(`--${tone}: ${hex};`, 'i'));
});

test('tab bar: tokens only; the active tab is crowned by the theme\'s crown gradient and joined to the content', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /^\.(tabs|tab-strip|tab-feet|tab-new|tab)([\s.:[{]|$)/.test(m[1]!.trim()));
  expect(rules.length).toBeGreaterThan(12);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
  expect(css).toMatch(/--bg-tabs:/);
  expect(rule('.tabs')).toContain('var(--bg-tabs)');
  // A 2px gradient crown that follows the rounded top; the sides and the foot are the content's own surface.
  // The crown is the brand gradient (--tab-crown: Docsy's gold-to-cobalt keyword gradient).
  expect(rule('.tab.is-active')).toMatch(/var\(--tab-crown\) border-box/);
  expect(rule('.tab.is-active')).toMatch(/border-width: 2px 0 0/);
  expect(rule('.tab.is-active')).not.toMatch(/transparent \d+%, var\(--bg-2\)/);
  expect(rule('.tab.is-active .tab-feet')).toContain('display: block');
  // Keyboard focus stays visible on the active tab (its inset ring outranks the global one) and keeps the card's shape;
  // the crown has no halo above it.
  expect(rule('.tab.is-active')).not.toMatch(/box-shadow/);
  expect(rule('.tab.is-active:focus-visible')).toMatch(/box-shadow:[^;]*var\(--violet\)/);
  expect(rule('.tab:focus-visible')).toContain('border-radius: 9px 9px 0 0');
  // "+" and Changes live outside the scrolling strip.
  expect(rule('.tab-strip')).toMatch(/overflow-x: auto/);
  expect(rule('.tabs')).not.toMatch(/overflow/);
});

test('source control: lane and person tokens, the drop motion, a tokens-only stylesheet', () => {
  for (const tok of ['--lane-1', '--lane-2', '--lane-3', '--lane-4', '--lane-5', '--lane-6', '--person-1', '--person-8', '--dim-layer']) expect(css, tok).toContain(`${tok}:`);
  expect(css).toMatch(/@keyframes atl-drop \{ from \{ opacity: 0; transform: translateY\(-8px\) scaleY\(\.94\); \}/);
  expect(css).toMatch(/@keyframes atl-row-in/);
  const scm = readFileSync(join(dir, 'scm/scm.css'), 'utf8');
  const rules = [...scm.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)];
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
  // Reduce motion: the dropdown and its rows appear without movement.
  expect(scm).toMatch(/:root\[data-motion="reduced"\] \.scm-drop/);
  const main = readFileSync(join(dir, 'styles.ts'), 'utf8');
  expect(main).toContain("import './scm/scm.css';");
});

test('Background tab: tokens only, laid out by container queries on the tab, motion optional', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.bgv/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(40);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
  expect(rule('.bgv')).toMatch(/container-type: inline-size/);
  expect(rule('.bgv')).toMatch(/container-name: bgv/);
  expect(layout).toMatch(/@container bgv \(max-width: 639px\)/);
  expect(layout).toMatch(/@container bgv \(max-width: 359px\)/);
  expect(layout).toMatch(/\[data-motion="reduced"\] \.bgv \.pulse/);
});

test('an info toast (e.g. "is in the prompt") never wears the error color', () => {
  expect(rule('.toast.is-info')).toContain('var(--edge-violet)');
  expect(rule('.toast.is-info i')).toContain('var(--violet)');
  expect(rule('.toast.is-info') + rule('.toast.is-info i')).not.toMatch(/--error|rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('Docker surfaces use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(dk-|note-whale|tab-whale|ph-whale|set-text-input|pulse-live)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(100);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('Redis surfaces use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.(rd-|note-redis)/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(150);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('Checked files surfaces use tokens, never raw colors', () => {
  const rules = [...layout.matchAll(/^([^{\n]+)\{([^}]*)\}/gm)].filter((m) => /\.chk-/.test(m[1]!));
  expect(rules.length).toBeGreaterThan(10);
  for (const m of rules) expect(m[2], m[1]).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b/);
});

test('the launch flags suggestions: the palette\'s glass, and above the account rows that follow their card', () => {
  const rule = (sel: string) => new RegExp(`\\${sel} \\{[^}]*\\}`).exec(layout)?.[0] ?? '';
  const suggest = rule('.lf-suggest');
  expect(suggest).toContain('background: var(--bg-float)');
  expect(suggest).toContain('backdrop-filter: blur(24px) saturate(150%)');
  // The card fades in (a stacking context), so do the rows after it: the card needs its own layer above them.
  const card = rule('.lf-card');
  expect(card).toContain('position: relative');
  expect(card).toMatch(/z-index: [1-9]/);
});

// Themes: a theme only redefines tokens, so the stylesheet that lays the app out names
// none of its colors itself (tints are color-mix() of a token, never rgba() of numbers).
// The themes beyond Aurora: themes.css, and Docsy's pair apart (the live demo swaps it out).
const themeBlocks = () => ['themes.css', 'themes-docsy.css'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

test('layout.css carries no raw colors', () => {
  const raw = [...layout.matchAll(/rgba?\(\s*\d[^)]*\)|#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  expect(raw).toEqual([]);
});

test('theme.css and the themes\' stylesheets keep raw colors inside their token blocks (selection, scrollbars, keyframes use tokens)', () => {
  const outside = (css + themeBlocks()).replace(/:root(\[[^\]]*\])?(, \[data-theme-preview="[\w-]+"\])?\s*\{[^}]*\}/g, '');
  const raw = [...outside.matchAll(/rgba?\(\s*\d[^)]*\)|#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  expect(raw).toEqual([]);
});

test('every token layout.css names is defined in theme.css or a theme\'s stylesheet', () => {
  const defined = new Set([...(css + themeBlocks()).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...layout.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!));
  // Set where they are used, not in the theme: in layout.css itself, or from code (inline styles, setProperty).
  const code = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const local = new Set([...layout.matchAll(/(--[\w-]+)\s*:/g), ...code.matchAll(/['"`](--[\w-]+)['"`]/g)].map((m) => m[1]));
  expect([...used].filter((v) => !defined.has(v) && !local.has(v))).toEqual([]);
});

test('the terminal, editor and syntax themes and the state colors in code read tokens, never raw colors', () => {
  for (const f of ['terminal/xtermTheme.ts', 'editor/cmTheme.ts', 'editor/theme.ts', 'task-view.ts', 'components/LogLineView.tsx', 'icons/seti.ts']) {
    const src = readFileSync(join(dir, f), 'utf8');
    expect([...src.matchAll(/rgba?\(\s*\d[^)]*\)|#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]), f).toEqual([]);
  }
});

// Minimal switches the finish off: every colored glow (a blurred, not inset shadow layer in a brand
// or state hue) scales with --fx-glow, every brand wash (a radial gradient) with --fx-wash. Aurora sets both to 1.
const HUES = /var\(--(violet|pink|violet-soft|waiting|working|done|error)\)/;
function topLevel(v: string, sep: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  return [...out, cur];
}
// The quiet finish: no colored glow, no glowing icon, no brand wash, and
// no knob left to bring them back.
test('no colored glows, no glowing icons, no brand washes; --fx-glow and --fx-wash are gone', () => {
  const glows: string[] = [];
  for (const m of layout.matchAll(/(?:^|[;{\s])(box-shadow|text-shadow)\s*:\s*([^;}]+)/g)) {
    for (const layer of topLevel(m[2]!, ',')) {
      const l = layer.trim();
      const lengths = l.replace(/color-mix\([^)]*\)[^)]*\)|var\([^)]*\)/g, '').trim().split(/\s+/);
      const blurred = !l.startsWith('inset') && lengths.length >= 3 && parseFloat(lengths[2]!) > 0;
      if (blurred && HUES.test(l)) glows.push(l);
    }
  }
  for (const m of layout.matchAll(/drop-shadow\(((?:[^()]|\([^()]*(?:\([^()]*\))*[^()]*\))*)\)/g)) {
    if (HUES.test(m[1]!)) glows.push(m[0]);
  }
  for (const m of layout.matchAll(/radial-gradient\(\d+(?:px|%) \d+(?:px|%) at [^,]+,([^;]*)/g)) {
    const first = topLevel(m[1]!, ',')[0]!;
    if (/var\(--(violet|pink|tint-violet|tint-pink|tint-meet|tint-violet-soft)\)/.test(first)) glows.push(first);
  }
  expect(glows).toEqual([]);
  const both = css + themeBlocks();
  expect(both).not.toMatch(/--fx-(glow|wash)/);
});

// Minimal's monochrome avatars: a session's color reaches CSS only as --id, so one rule decides.
test('session identity colors go through --id; the avatar rule lets a theme override them', () => {
  const code = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.')).map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);
  expect(code.filter(([, s]) => /['"]--ring['"]/.test(s)).map(([f]) => f)).toEqual([]);
  // Dots in a session's color too (comments, review, git notices, the log's paste mark).
  expect(code.filter(([, s]) => /background: [\w.[\]!]+\.color\b/.test(s)).map(([f]) => f)).toEqual([]);
  expect(rule('.id-dot')).toContain('background: var(--avatar-color, color-mix(in srgb, var(--id) var(--id-mix), var(--text)))');
  const r = rule('.avatar') + ';' + rule('.sw-avatar');
  const id = 'var(--avatar-color, color-mix(in srgb, var(--id) var(--id-mix), var(--text)))';
  expect(r).toContain(`color: ${id}`);
  expect(r).toContain(`--ring: ${id}`);
});

test('faint white sheens (keys, log rows on hover) are a token light themes turn into a faint shade', () => {
  expect(layout).not.toMatch(/background: color-mix\(in srgb, var\(--light\) \d+%, transparent\)/);
  expect(rule('.kbd')).toContain('var(--sheen-faint)');
  const themes = themeBlocks();
  for (const id of ['daylight', 'paper', 'docsy']) expect(themes, id).toMatch(new RegExp(`data-theme="${id}"[^}]*--sheen-faint: color-mix\\(in srgb, var\\(--shade\\)`));
});

test('the website stays light: theme.css holds no app-only tokens (terminals, code, logs, file icons, the finish)', () => {
  for (const prefix of ['--term-', '--ansi-', '--editor-', '--log-', '--seti-', '--fx-', '--preview-', '--kbd-']) expect(css, prefix).not.toMatch(new RegExp(`${prefix}[\\w-]+\\s*:`));
});
