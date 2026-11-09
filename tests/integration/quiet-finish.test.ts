import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { parseThemeCss } from '../../src/shared/theme-resolve';

// Quiet finish: no halos, no glowing icons, no gradient fills, nothing that
// moves under the pointer or when pressed, no shimmer; only what waits for the user breathes.
const root = join(__dirname, '../../src/renderer');
function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []);
}
const cssFiles = walk(root, /\.css$/);
const source = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
interface Decl { file: string; selector: string; prop: string; value: string }
/** Every declaration of every innermost rule (keyframes aside), with its rule's selector list. */
const decls: Decl[] = cssFiles.flatMap((f) => {
  const code = source(f).replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => {
    const selector = m[1]!.trim().replace(/\s+/g, ' ');
    return m[2]!.split(';').flatMap((d) => {
      const x = /^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(d);
      return x ? [{ file: relative(root, f), selector, prop: x[1]!, value: x[2]! }] : [];
    });
  });
});
/** A token block (theme.css, themes.css): `:root`, a theme or a theme preview, nothing below it. */
const TOKEN_BLOCK = /^(:root(\[[^\]]+\])?|\[data-theme(-preview)?(="[\w-]+")?\])$/;
const isTokens = (d: Decl) => d.selector.split(',').every((s) => TOKEN_BLOCK.test(s.trim()));
const rules = decls.filter((d) => !isTokens(d));
const where = (d: Decl) => `${d.file}: ${d.selector} { ${d.prop}: ${d.value} }`;

/** Top-level comma split (commas inside functions stay). */
function layers(v: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  return cur.trim() ? [...out, cur.trim()] : out;
}
const SHADE = /var\(--(shade|abyss|dim-layer)\)|#000\b|rgba\(0,\s*0,\s*0/;
/** An outer shadow layer with a blur in a color of its own: a halo. Inset rings and shade shadows are fine. */
function isHalo(layer: string): boolean {
  if (/\binset\b/.test(layer)) return false;
  if (/var\(--(glow|hit-glow)/.test(layer)) return true;
  const lengths = layer.replace(/[\w-]+\((?:[^()]|\([^()]*\))*\)/g, ' ').trim().split(/\s+/).filter((t) => /^-?[\d.]+(px)?$/.test(t));
  return lengths.length >= 3 && parseFloat(lengths[2]!) > 0 && !SHADE.test(layer);
}

test('no halos: no colored outer shadow, no --glow token, anywhere in the app\'s rules', () => {
  const offenders = rules.filter((d) =>
    ((d.prop === 'box-shadow' || d.prop === '--rest-halo') && layers(d.value).some(isHalo)) || /var\(--(glow|hit-glow)/.test(d.value));
  expect(offenders.map(where)).toEqual([]);
});

test('no glowing icons or text', () => {
  expect(rules.filter((d) => d.prop === 'filter' && /drop-shadow/.test(d.value) && !SHADE.test(d.value)).map(where)).toEqual([]);
  expect(cssFiles.filter((f) => /text-shadow/.test(source(f))).map((f) => relative(root, f))).toEqual([]);
});

// Transforms that only place something (centering) are not motion.
const PLACING = /^(none|translate[XY]?\(-50%\)|translate\(-50%,\s*-50%\))$/;
test('nothing grows, lifts, nudges or brightens under the pointer, nothing shrinks or shifts when pressed', () => {
  const interactive = (d: Decl) => /:hover|:active|\.is-dragging/.test(d.selector);
  expect(rules.filter((d) => interactive(d) && /^(transform|scale|translate)$/.test(d.prop) && !PLACING.test(d.value)).map(where)).toEqual([]);
  expect(rules.filter((d) => d.prop === 'filter' && /brightness/.test(d.value) && !/^button:active:not\(:disabled\)$/.test(d.selector)).map(where)).toEqual([]);
});

test('a pressed button darkens instead of shrinking', () => {
  const press = rules.filter((d) => d.selector === 'button:active:not(:disabled)');
  expect(press.map((d) => `${d.prop}: ${d.value}`)).toEqual(['filter: brightness(.94)']);
});

// Gradients that are not fills: fades that end a scrolling row, one-color lines, the tab's crown and feet, the CSV
// hatch, the transparency checkerboard behind images, and pies that draw a proportion (a progress ring, a half-done
// glyph) with hard stops.
const GRADIENT_KEPT = new Set(['.log-actions', '.spp-actions', '.csv-table th.is-extra', '.tab-feet', '.image-stage', '.bgv-ring',
  '.ask-gl.is-in_progress::after']);
/** Whether one of a value's gradients names two colors or more (one color is a line or a flat layer, not a gradient). */
function blends(value: string): boolean {
  const gradients = value.match(/[\w-]*gradient\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g) ?? [];
  return gradients.some((g) => new Set(g.match(/color-mix\((?:[^()]|\([^()]*\))*\)|var\(--[\w-]+\)|#[0-9A-Fa-f]{3,8}\b|\btransparent\b/g) ?? []).size > 1);
}
test('no gradient fills or washes: solid fills, flat selections, flat strips', () => {
  const offenders = rules.filter((d) => /^(background|background-image)$/.test(d.prop) && blends(d.value)
    && !d.selector.split(',').some((s) => GRADIENT_KEPT.has(s.trim())));
  expect(offenders.map(where)).toEqual([]);
  expect(rules.filter((d) => /var\(--brand-x\)/.test(d.value)).map(where)).toEqual([]);
});

test('no card lifts, no finish knobs: --shadow-card, --fx-glow and --fx-wash are gone', () => {
  expect(rules.filter((d) => /var\(--shadow-card\)/.test(d.value)).map(where)).toEqual([]);
  expect(cssFiles.filter((f) => /--fx-(glow|wash)/.test(source(f))).map((f) => relative(root, f))).toEqual([]);
});

const tsx = walk(root, /\.tsx?$/).filter((f) => !/\.test\.tsx?$/.test(f));
test('no shimmer: no class, no keyframes, no component asks for it', () => {
  expect(cssFiles.filter((f) => /shimmer/.test(source(f))).map((f) => relative(root, f))).toEqual([]);
  expect(tsx.filter((f) => /['"` ]shimmer\b|shimmer['"` ]|shimmer:/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))).toEqual([]);
});

test('no violet-to-pink gradient left in components: the usage ring draws in the brand', () => {
  expect(tsx.filter((f) => /linearGradient|radialGradient/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))).toEqual([]);
  expect(rules.filter((d) => d.selector === '.usage-ring.tone-brand .usage-ring-arc').map((d) => `${d.prop}: ${d.value}`)).toEqual(['stroke: var(--brand)']);
  // Fills the first pass flattened to plain violet were the violet-to-pink pair: they take the brand.
  for (const s of ['.resizer::after', '.dp-bars i', '.dict-meter span', '.pane-divider::after', '.tt-head em', '.md-toc-fill']) {
    expect(rules.find((d) => layers(d.selector).includes(s) && d.prop === 'background')?.value, s).toBe('var(--brand)');
  }
  expect(rules.find((d) => d.selector === '.bgv-ring' && d.prop === 'background')?.value).toMatch(/^conic-gradient\(var\(--brand\) /);
});

test('the editor\'s own styles (CodeMirror themes in TS) follow too: no glow tokens', () => {
  expect(tsx.filter((f) => /var\(--(glow|hit-glow)|drop-shadow|textShadow/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))).toEqual([]);
});

// Pulses that grew a halo are gone; only waiting cues breathe, progress indicators keep their motion.
const GONE_KEYFRAMES = ['atl-pulse-ring', 'atl-pulse-dot', 'atl-pulse-working', 'atl-shimmer-once', 'atl-sparkle',
  'atl-starting-dot', 'bgv-live', 'dk-live', 'rd-live', 'cb-run'];
test('no dot pulses a halo: their keyframes are gone and no animation names them', () => {
  const all = cssFiles.map(source).join('\n');
  const animations = decls.filter((d) => /^animation(-name)?$/.test(d.prop)).map((d) => d.value).join('\n');
  for (const k of GONE_KEYFRAMES) {
    const name = new RegExp(`(?<![\\w-])${k}(?![\\w-])`);
    expect(all, k).not.toMatch(new RegExp(`@keyframes ${k}(?![\\w-])`));
    expect(animations, k).not.toMatch(name);
  }
});

const WAITING_CUES = ['.pulse', '.state-chip.st-waiting i', '.conflict-dot', '.avatar.av-waiting'];
test('waiting cues breathe --cue-cycles times without a halo; the waiting avatar\'s ring breathes', () => {
  const bodyOf = (s: string) => rules.filter((d) => d.selector.split(',').map((x) => x.trim()).includes(s));
  for (const s of WAITING_CUES) {
    const anim = bodyOf(s).find((d) => d.prop === 'animation')?.value ?? '';
    expect(anim, s).toMatch(/^atl-(breathe|ring)-cue [\d.]+s [\w-]+ var\(--cue-cycles\)$/);
  }
  expect(bodyOf('.avatar.av-waiting').find((d) => d.prop === 'animation')?.value).toMatch(/^atl-ring-cue/);
  const theme = source(join(root, 'theme.css'));
  const kf = (n: string) => theme.match(new RegExp(`@keyframes ${n}\\s*\\{([\\s\\S]*?\\})\\s*\\}`))?.[1] ?? '';
  expect(kf('atl-breathe-cue')).toMatch(/opacity/);
  expect(kf('atl-breathe-cue')).not.toMatch(/box-shadow|transform/);
  expect(kf('atl-ring-cue')).not.toMatch(/0 0 \d+px|transform/);
});

const css = ['theme.css', 'themes.css', 'themes-docsy.css'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
const blocks = parseThemeCss(css);
test('the app\'s finish is set once, in themes.css\' Aurora block', () => {
  const aurora = blocks['']!;
  // The brand is the logo's own color: the middle of each theme's pair, solid (the fills matched the logo
  // only while they were its gradient). The mark, the tab crown and the usage ring take it too.
  expect(aurora['--brand']).toBe('color-mix(in srgb, var(--violet) 50%, var(--pink))');
  expect(aurora['--mark-a']).toBe('var(--brand)');
  expect(aurora['--mark-b']).toBe('var(--brand)');
  expect(aurora['--tab-crown']).toBe('linear-gradient(var(--brand), var(--brand))');
  expect(aurora['--bg-sel']).toBe('var(--tint-violet)');
  expect(aurora['--seg-on']).toBe('var(--bg-3)');
  expect(aurora['--seg-on-shadow']).toBe('inset 0 0 0 1px var(--line-strong)');
  expect(aurora['--seg-on-text']).toBe('var(--text)');
  expect(aurora['--focus-ring']).toBe('0 0 0 2px var(--bg-0), 0 0 0 3.5px var(--violet)');
  expect(aurora['--on-brand-lift']).toMatch(/color-mix\(in srgb, var\(--light\) \d+%, transparent\)/);
  for (const [id, b] of Object.entries(blocks)) {
    if (id === '') continue;
    const own = Object.keys(b).filter((n) => /^--(glow|seg-on|fx-)/.test(n));
    expect(own, id).toEqual([]);
  }
});

test('a pane waiting for you: hairlines only, no outer glow', () => {
  for (const n of ['--wait-ring', '--wait-ring-bright']) {
    const v = blocks['']![n]!;
    expect(layers(v).every((l) => /^inset 0 0 0 1px /.test(l)), n).toBe(true);
  }
});

const CHIPS = ['.work-chip', '.sched-chip', '.sp-chip', '.rs-chip', '.tchip', '.plan-badge', '.pr-chip', '.port-chip'];
test('status chips are a thin neutral outline; under the pointer they fill one step', () => {
  const own = (s: string, prop: string) => rules.filter((d) => d.selector === s && d.prop === prop).map((d) => d.value);
  for (const c of CHIPS) {
    const edge = [...own(c, 'box-shadow'), ...own(c, 'border')].join(' ');
    expect(edge, c).toMatch(/var\(--line-strong\)/);
    expect(own(c, 'background').every((v) => v === 'none' || v === 'transparent'), c).toBe(true);
    const hover = rules.filter((d) => d.selector.split(',').map((x) => x.trim()).includes(`${c}:hover`) && d.prop === 'background');
    expect(hover.map((d) => d.value), `${c}:hover`).toEqual(['var(--bg-3)']);
  }
});

// What the rewrite could break without a visible error.
test('keyframes follow too: no flash or pulse draws a halo or a card lift', () => {
  const offenders: string[] = [];
  for (const f of cssFiles) {
    for (const m of source(f).matchAll(/@keyframes ([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
      for (const d of m[2]!.matchAll(/box-shadow:\s*([^;}]+)/g)) {
        if (/var\(--(glow|hit-glow|shadow-card)/.test(d[1]!) || layers(d[1]!).some(isHalo)) offenders.push(`${relative(root, f)}: @keyframes ${m[1]}`);
      }
    }
  }
  expect([...new Set(offenders)]).toEqual([]);
});

test('a layered background keeps its color in the last layer (a color earlier drops the whole declaration)', () => {
  const tokens = blocks['']!;
  const isImage = (layer: string) => {
    const head = layer.split(/\s+(?=padding-box|border-box|no-repeat|center|\d)/)[0]!;
    const ref = /^var\((--[\w-]+)\)$/.exec(head);
    return /gradient\(|url\(/.test(ref ? tokens[ref[1]!] ?? '' : head);
  };
  const offenders = rules.filter((d) => /^background(-image)?$/.test(d.prop) && layers(d.value).slice(0, -1).some((l) => !isImage(l)));
  expect(offenders.map(where)).toEqual([]);
});

test('text on a chosen segment reads in light themes too: never --on-brand on the neutral --seg-on', () => {
  const segs = rules.filter((d) => d.prop === 'background' && d.value === 'var(--seg-on)').flatMap((d) => d.selector.split(',').map((s) => s.trim()));
  const onSeg = (s: string) => segs.some((x) => s === x || (s.startsWith(x) && /^[[:.]/.test(s.slice(x.length))));
  expect(rules.filter((d) => d.prop === 'color' && d.value === 'var(--on-brand)' && d.selector.split(',').some((s) => onSeg(s.trim()))).map(where)).toEqual([]);
});

test('the website still finds every animation it names (it imports theme.css)', () => {
  const site = join(root, '../../site/src');
  const files = walk(site, /\.(astro|css)$/).map((f) => readFileSync(f, 'utf8'));
  const defined = new Set([...files, readFileSync(join(root, 'theme.css'), 'utf8')].flatMap((s) => [...s.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]!)));
  const used = new Set(files.flatMap((s) => [...s.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)].map((m) => m[1]!)).filter((n) => !/^(none|inherit|initial)$/.test(n)));
  expect([...used].filter((n) => !defined.has(n))).toEqual([]);
});

test('hover details: a selected row\'s port chip brightens, brand fills keep their ring, nothing widens, no white on a tint', () => {
  const value = (s: string, p: string) => rules.find((d) => layers(d.selector).includes(s) && d.prop === p)?.value;
  expect(value('.is-selected .port-chip:hover', 'color')).toBe('var(--text)');
  for (const [hover, base] of [['.git-check:is(.is-all, .is-partial):hover', '.git-check:is(.is-all, .is-partial)'],
    ['.git-oplog-btn.is-primary:hover', '.git-oplog-btn.is-primary'], ['.btn-primary:hover', '.btn-primary']] as const) {
    const ring = layers(value(base, 'box-shadow') ?? '').filter((l) => /^0 0 0 1px /.test(l));
    expect(ring.length, base).toBeGreaterThan(0);
    for (const r of ring) expect(value(hover, 'box-shadow'), hover).toContain(r);
  }
  expect(value('.cb-bar:hover', 'width')).toBeUndefined();
  expect(value('.fc-btn:hover:not(:disabled)', 'color')).not.toBe('var(--on-brand)');
  expect(value('.plan-badge.is-bypass:hover', 'color') ?? 'var(--text-error)').toBe('var(--text-error)');
});
