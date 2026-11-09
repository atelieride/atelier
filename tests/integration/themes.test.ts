import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { contrast } from '../../src/renderer/contrast';
import { parseThemeCss, resolveToken } from '../../src/shared/theme-resolve';
import { THEMES } from '../../src/shared/themes';
import { xtermTheme } from '../../src/renderer/terminal/xtermTheme';

// Themes: every theme sets every palette token, and reads.
const css = ['theme.css', 'themes.css', 'themes-docsy.css'].map((f) => readFileSync(join(__dirname, '../../src/renderer', f), 'utf8')).join('\n');
const blocks = parseThemeCss(css);
const RAW = /#[0-9A-Fa-f]{3,8}\b|rgba\(\s*\d/;
// The palette: :root's tokens that hold a color of their own (not mixed from another token). Black and white stay.
const PALETTE = Object.entries(blocks['']!).filter(([n, v]) => RAW.test(v) && !['--shade', '--light'].includes(n)).map(([n]) => n);
const others = THEMES.filter((t) => t.id !== 'aurora');
const c = (theme: string, a: string, b: string) => contrast(resolveToken(blocks, theme, a), resolveToken(blocks, theme, b));

test.each(others.map((t) => t.id))('%s sets every palette token', (id) => {
  const block = blocks[id] ?? {};
  expect(PALETTE.filter((n) => !(n in block))).toEqual([]);
});

test.each(others)('$id: light or dark through and through (color-scheme)', (t) => {
  const rule = new RegExp(`:root\\[data-theme="${t.id}"\\], \\[data-theme-preview="${t.id}"\\]\\s*\\{[^}]*color-scheme:\\s*${t.appearance}`);
  expect(css).toMatch(rule);
});

// Glows and washes are gone from every theme: Minimal is its radii and its one ink.
test.each(['ink', 'paper'])('%s is Minimal: smaller radii, one ink for the brand and avatars', (id) => {
  const b = blocks[id]!;
  expect(b['--radius']).toBe('6px');
  expect(resolveToken(blocks, id, '--violet')).toBe(resolveToken(blocks, id, '--text'));
  expect(resolveToken(blocks, id, '--pink')).toBe(resolveToken(blocks, id, '--text'));
  expect(b['--avatar-color']).toBe('var(--text-3)');
});

// Ember and Tide: Aurora's finish and radii, a brand of their own.
test.each(['ember', 'tide'])('%s keeps Aurora\'s finish with a brand of its own', (id) => {
  const b = blocks[id]!;
  for (const n of ['--r-sm', '--radius', '--r-lg']) expect(b[n], n).toBeUndefined();
  for (const n of ['--violet', '--pink']) expect(resolveToken(blocks, id, n), n).not.toBe(resolveToken(blocks, 'aurora', n));
  expect(resolveToken(blocks, id, '--violet')).not.toBe(resolveToken(blocks, id, '--pink'));
  expect(b['--id-mix'] ?? '100%').toBe('100%');
  expect(b['--avatar-color']).toBeUndefined();
});

// Docsy and Docsy Night: Docsy's finish and type; cobalt fills under text, gold on the marks.
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r!, g!, b!), d = max - Math.min(r!, g!, b!);
  const h = max === r ? ((g! - b!) / d) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
  return (h * 60 + 360) % 360;
};
test.each(['docsy', 'docsy-night'])('%s: Docsy\'s finish (radii 8/10, Poppins); cobalt acts, gold marks', (id) => {
  const b = blocks[id]!;
  expect([b['--r-sm'], b['--radius'], b['--r-lg']]).toEqual(['8px', '10px', undefined]);
  expect(b['--font']).toMatch(/^'Poppins', /);
  for (const n of ['--violet', '--pink']) expect(hue(resolveToken(blocks, id, n)), n).toBeGreaterThan(210);
  for (const n of ['--violet', '--pink']) expect(hue(resolveToken(blocks, id, n)), n).toBeLessThan(230);
  expect(resolveToken(blocks, id, '--waiting-mark')).toBe('#FFB224');
  expect(b['--tab-crown']).toBe('linear-gradient(90deg, var(--waiting-mark), var(--violet))');
});

test.each(THEMES.map((t) => t.id))('%s reads: text, states, brand, terminal, code', (id) => {
  for (const bg of ['--bg-0', '--bg-2']) {
    for (const t of ['--text', '--text-2', '--text-3']) expect(c(id, t, bg), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(c(id, '--text-4', bg), `--text-4 on ${bg}`).toBeGreaterThanOrEqual(3);
    for (const s of ['--waiting', '--working', '--done', '--error']) expect(c(id, s, bg), `${s} on ${bg}`).toBeGreaterThanOrEqual(3);
  }
  for (const fill of ['--violet', '--pink']) expect(c(id, '--on-brand', fill), `--on-brand on ${fill}`).toBeGreaterThanOrEqual(3);
  const term = xtermTheme(id);
  expect(contrast(term.foreground!, term.background!)).toBeGreaterThanOrEqual(7);
  const keys = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
  for (const k of keys) expect(contrast(term[k]!, term.background!), `ansi ${k}`).toBeGreaterThanOrEqual(3);
  expect(c(id, '--editor-fg', '--bg-2')).toBeGreaterThanOrEqual(7);
  for (const s of ['comment', 'keyword', 'operator', 'string', 'number', 'type', 'function', 'tag', 'key', 'variable', 'punct', 'link']) {
    expect(c(id, `--syn-${s}`, '--bg-2'), `--syn-${s}`).toBeGreaterThanOrEqual(3);
  }
});

// Workspace colors: a glyph, a name tint and a card's edge on the sidebar read in every theme.
test.each(THEMES.map((t) => t.id))('%s: workspace colors read on the sidebar and the content', (id) => {
  for (let n = 1; n <= 8; n++) for (const bg of ['--bg-1', '--bg-2']) expect(c(id, `--ws-${n}`, bg), `--ws-${n} on ${bg}`).toBeGreaterThanOrEqual(3);
});

// File icons (Seti): Aurora keeps them; every theme's read on its own ground.
const SETI = { blue: '#519ABA', grey: '#4D5A5E', 'grey-light': '#6D8086', green: '#8DC149', orange: '#E37933', pink: '#F55385', purple: '#A074C4', red: '#CC3E44', white: '#D4D7D6', yellow: '#CBCB41', ignore: '#41535B' };
test('file icon colors: Aurora\'s are Seti\'s; each theme\'s reads on its sidebar', () => {
  for (const [n, hex] of Object.entries(SETI)) expect(resolveToken(blocks, 'aurora', `--seti-${n}`), n).toBe(hex);
  for (const t of THEMES) {
    for (const n of Object.keys(SETI).filter((k) => !['grey', 'ignore'].includes(k))) expect(c(t.id, `--seti-${n}`, '--bg-0'), `${t.id} --seti-${n}`).toBeGreaterThanOrEqual(2.5);
  }
});

// Service and Docker logs (shared/logline.ts): their 16 colors are tokens; Aurora keeps the ones it had.
const LOG = ['#1B1F28', '#F07B74', '#3FB68B', '#EBC77A', '#5B8DEF', '#B794F6', '#4FC3D9', '#C9C7C1', '#6F7682', '#F4A3A3', '#A3D977', '#F5B544', '#9DB8F5', '#E8A0E8', '#7FD3F7', '#E7E5DF'];
test('log colors: Aurora\'s as before; on light themes the readable ones read', () => {
  LOG.forEach((hex, i) => expect(resolveToken(blocks, 'aurora', `--log-${i}`), String(i)).toBe(hex));
  for (const t of THEMES.filter((x) => x.appearance === 'light')) {
    for (let i = 1; i < 16; i++) expect(c(t.id, `--log-${i}`, '--bg-2'), `${t.id} --log-${i}`).toBeGreaterThanOrEqual(3);
  }
});

// Colors that mean different things stay apart (CIE76 ΔE; under ~20 two colors read as one): the brand and the
// current branch's lane are not the error red, a link is not error text, a linked worktree is not the working state
// or a link. Minimal mutes every hue on purpose, so the worktree pair holds where the theme has a finish.
function lab(hex: string): number[] {
  const n = hex.replace('#', '').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [(0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047, 0.2126 * r! + 0.7152 * g! + 0.0722 * b!, (0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.08883].map(f);
  return [116 * y! - 16, 500 * (x! - y!), 200 * (y! - z!)];
}
const apart = (theme: string, a: string, b: string) => {
  const [p, q] = [lab(resolveToken(blocks, theme, a)), lab(resolveToken(blocks, theme, b))];
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
};
test.each(THEMES.map((t) => t.id))('%s: brand, errors, links and worktrees are told apart', (id) => {
  for (const [a, b] of [['--violet', '--error'], ['--brand', '--error'], ['--lane-1', '--error'], ['--link', '--text-error'], ['--link', '--error']]) {
    expect(apart(id, a!, b!), `${a} vs ${b}`).toBeGreaterThanOrEqual(30);
  }
  if (id === 'ink' || id === 'paper') return;
  for (const n of ['--working', '--link']) expect(apart(id, '--worktree', n), `--worktree vs ${n}`).toBeGreaterThanOrEqual(25);
});

// The waiting color's two tokens: every other theme paints its marks with its text color; where the
// mark is a color of its own, the text reads at 4.5:1 and the mark stays apart from the other states and the brand.
test('--waiting-mark and --tab-crown default to the waiting color and the brand (solid)', () => {
  expect(blocks['']!['--waiting-mark']).toBe('var(--waiting)');
  expect(blocks['']!['--tab-crown']).toBe('linear-gradient(var(--brand), var(--brand))');
});
test.each(THEMES.map((t) => t.id))('%s: a waiting mark of its own leaves readable waiting text', (id) => {
  if (resolveToken(blocks, id, '--waiting-mark') === resolveToken(blocks, id, '--waiting')) return;
  for (const bg of ['--bg-0', '--bg-2']) expect(c(id, '--waiting', bg), `--waiting on ${bg}`).toBeGreaterThanOrEqual(4.5);
  for (const n of ['--working', '--done', '--error', '--violet']) expect(apart(id, '--waiting-mark', n), n).toBeGreaterThanOrEqual(30);
});

// What isn't text takes the waiting mark: `var(--waiting)` only as a text color (`color`, or a custom property only
// text reads), the mark's own definition, or a fill that carries text in the background color.
const TEXT_PROPS = new Set(['color', '--alert', '--chip', '--waiting-mark']);
const TEXT_FILLS = ['.note-bolt', '.ask-btn.is-amber'];
const styleDir = join(__dirname, '../../src/renderer');
const sheets = (readdirSync(styleDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.css'));
test('non-text waiting colors go through --waiting-mark', () => {
  expect(sheets.length).toBeGreaterThan(8);
  const bad: string[] = [];
  for (const f of sheets) {
    const text = readFileSync(join(styleDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const r of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = r[1]!.trim();
      for (const d of r[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
        if (!/var\(--waiting\)/.test(d[2]!) || TEXT_PROPS.has(d[1]!)) continue;
        if (d[1] === 'background' && TEXT_FILLS.some((s) => sel.startsWith(s))) continue;
        bad.push(`${f}: ${sel.slice(0, 60)} { ${d[1]} }`);
      }
    }
  }
  expect(bad).toEqual([]);
});

// A dot drawn in its row's text color (`background: currentColor`) would be the waiting text color in a waiting row:
// the waiting variant paints its dot with the mark instead (on Docsy the text is deep gold, dots are gold).
test('dots drawn in currentColor take the waiting mark where their row reads in the waiting color', () => {
  const rules: { sels: string[]; body: string }[] = [];
  for (const f of sheets) {
    const text = readFileSync(join(styleDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const r of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) rules.push({ sels: r[1]!.split(',').map((s) => s.trim()), body: r[2]! });
  }
  const dots = rules.filter((r) => /background:\s*currentColor/i.test(r.body)).flatMap((r) => r.sels);
  const waiting = rules.filter((r) => /(?:^|[;{\s])color:\s*var\(--waiting\)/.test(r.body)).flatMap((r) => r.sels);
  expect(dots.length).toBeGreaterThan(4);
  const missing: string[] = [];
  for (const w of waiting) {
    const base = /^\.[\w-]+/.exec(w)?.[0];
    if (!base) continue;
    for (const d of dots.filter((x) => x.startsWith(base) && x !== base)) {
      const want = /^[\s>]/.test(d.slice(base.length)) ? `${w}${d.slice(base.length)}` : `${w} ${d}`;
      if (!rules.some((r) => r.sels.includes(want) && /background:\s*var\(--waiting-mark\)/.test(r.body))) missing.push(want);
    }
  }
  expect(missing).toEqual([]);
});

// The mark inside the window: the theme's brand pair, its Λ in on-brand (Docsy: Docsy's gold), and
// the Λ reads where it sits, mid-gradient on the front pane.
const mid = (a: string, b: string) => `#${[1, 3, 5].map((i) => Math.round((parseInt(a.slice(i, i + 2), 16) + parseInt(b.slice(i, i + 2), 16)) / 2).toString(16).padStart(2, '0')).join('')}`;
test.each(THEMES.map((t) => t.id))('%s: the mark takes the theme\'s brand and its Λ reads on it', (id) => {
  // Solid in the brand, the fills' own color.
  expect(resolveToken(blocks, id, '--mark-a')).toBe(resolveToken(blocks, id, '--brand'));
  expect(resolveToken(blocks, id, '--mark-b')).toBe(resolveToken(blocks, id, '--brand'));
  const lambda = resolveToken(blocks, id, '--mark-lambda');
  expect(lambda).toBe(id.startsWith('docsy') ? '#FFB224' : resolveToken(blocks, id, '--on-brand'));
  expect(contrast(lambda, mid(resolveToken(blocks, id, '--mark-a'), resolveToken(blocks, id, '--mark-b')))).toBeGreaterThanOrEqual(3);
});

// A brand fill (the accent) lightens under the pointer with --on-brand-lift: white on it
// keeps 3:1 then too, not only at rest.
const layout = readFileSync(join(__dirname, '../../src/renderer/layout.css'), 'utf8');
const lift = Number(/^color-mix\(in srgb, var\(--light\) ([\d.]+)%, transparent\)$/.exec(blocks['']!['--on-brand-lift']!)![1]) / 100;
const lifted = (hex: string) => `#${[1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16); return Math.round(c + (255 - c) * lift).toString(16).padStart(2, '0'); }).join('')}`;
test.each(THEMES.map((t) => t.id))('%s: text on a brand fill reads under the pointer too', (id) => {
  expect(layout).toMatch(/\.btn-primary:hover \{[^}]*inset 0 0 0 99px var\(--on-brand-lift\)/);
  expect(lift).toBeGreaterThan(0);
  expect(blocks['']!['--brand']).toBe('color-mix(in srgb, var(--violet) 50%, var(--pink))');
  for (const fill of ['--brand']) {
    expect(contrast(resolveToken(blocks, id, '--on-brand'), lifted(resolveToken(blocks, id, fill))), fill).toBeGreaterThanOrEqual(3);
  }
});

// --person-* are also the Claude accounts' colors (Settings › Accounts, chips, usage dots): told apart in every theme.
test.each(THEMES.map((t) => t.id))('%s: eight distinct person/account colors', (id) => {
  const people = Array.from({ length: 8 }, (_, i) => resolveToken(blocks, id, `--person-${i + 1}`));
  expect(new Set(people).size).toBe(8);
});

// The picked account card (New Session) is filled with --seg-on: the limit bars on it must not draw in the brand
// (Docsy Night: a cobalt bar on a cobalt card read as an empty groove). Every theme, every stop of a gradient: the bar's
// fill reads on the card and on its groove (3:1, WCAG non-text), and the groove shows on the card at least as much as
// the Minimal themes' faint grooves do (bg-3 on a card, ~1.16).
const flat = layout.replace(/\/\*[\s\S]*?\*\//g, '');
const bgOf = (sel: string) => {
  const rule = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((r) => r[1]!.split(',').map((s) => s.trim()).includes(sel));
  return rule && /(?:^|[;\s])background:\s*([^;]+);/.exec(rule[2]!)?.[1]!.trim();
};
const topSplit = (s: string) => {
  const out: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++; else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { out.push(s.slice(from, i).trim()); from = i + 1; }
  }
  return [...out, s.slice(from).trim()];
};
function stopsOf(id: string, value: string): string[] {
  const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
  const raw = ref ? blocks[id]?.[ref[1]!] ?? blocks['']![ref[1]!] : undefined;
  if (raw && /gradient\(/.test(raw)) return stopsOf(id, raw);
  const g = /^linear-gradient\(([\s\S]*)\)$/.exec(value.trim());
  if (!g) return [value];
  return topSplit(g[1]!).filter((s) => !/^(?:to\s|[\d.]+deg$)/.test(s)).map((s) => s.replace(/\s+[\d.]+%$/, ''));
}
const resolveIn = (id: string, value: string) => resolveToken({ ...blocks, [id]: { ...blocks[id], '--probe': value } }, id, '--probe');
function over(top: string, under: string): string {
  if (top.startsWith('#')) return top;
  const [r, g, b, a] = /rgba\(([^)]*)\)/.exec(top)![1]!.split(',').map(Number) as [number, number, number, number];
  const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  return `#${[r, g, b].map((x, i) => Math.round(x * a + u[i]! * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}
test.each(THEMES.map((t) => t.id))('%s: the limit bars read on the picked account card', (id) => {
  const sheet = over(resolveToken(blocks, id, '--bg-float'), resolveToken(blocks, id, '--bg-0'));
  const track = bgOf('.acct-card.is-on .usage-bar') ?? bgOf('.usage-bar')!;
  const fill = bgOf('.acct-card.is-on .usage-bar .tone-brand') ?? bgOf('.usage-bar .tone-brand')!;
  const low: string[] = [];
  for (const cardStop of stopsOf(id, bgOf('.acct-card.is-on')!)) {
    const card = over(resolveIn(id, cardStop), sheet);
    const groove = over(resolveIn(id, track), card);
    for (const f of stopsOf(id, fill)) {
      const bar = over(resolveIn(id, f), groove);
      if (contrast(bar, card) < 3) low.push(`fill ${bar} on card ${card}: ${contrast(bar, card).toFixed(2)}`);
      if (contrast(bar, groove) < 3) low.push(`fill ${bar} on groove ${groove}: ${contrast(bar, groove).toFixed(2)}`);
    }
    if (contrast(groove, card) < 1.15) low.push(`groove ${groove} on card ${card}: ${contrast(groove, card).toFixed(2)}`);
  }
  expect(low).toEqual([]);
});
