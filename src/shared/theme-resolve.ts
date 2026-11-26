// Themes: theme.css is the only place for color values. Parts that need a finished color
// rather than a CSS value — xterm's theme, the window's background before the page loads, Windows' caption buttons,
// the contrast tests — read the same tokens through this resolver. Pure: no DOM, the same answer in main, the renderer
// and Node.

/** Token declarations by block: '' is `:root`, a theme id is `:root[data-theme="<id>"]`. */
export type ThemeBlocks = Record<string, Record<string, string>>;

interface Rgba { r: number; g: number; b: number; a: number }

export function parseThemeCss(css: string): ThemeBlocks {
  const blocks: ThemeBlocks = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // A theme's block also matches [data-theme-preview] (Settings' cards draw each theme in its own colors).
  for (const m of text.matchAll(/:root(?:\[data-theme="([\w-]+)"\])?(?:\s*,\s*\[data-theme-preview="[\w-]+"\])?\s*\{([^}]*)\}/g)) {
    const block = (blocks[m[1] ?? ''] ??= {});
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) block[d[1]!] = d[2]!.trim();
  }
  return blocks;
}

/** A token's color in a theme (`aurora` is `:root` alone): `#RRGGBB` when opaque, else `rgba(r,g,b,a)`. */
export function resolveToken(blocks: ThemeBlocks, theme: string, name: string): string {
  return format(color(blocks, theme, `var(${name})`, name, new Set()));
}

/**
 * A token's color as hex only, for what reads no CSS (an iPhone): `#RRGGBB` when opaque, else `#RRGGBBAA` with the
 * alpha rounded to a byte (one that rounds to 255 is opaque).
 */
export function resolveHex(blocks: ThemeBlocks, theme: string, name: string): string {
  const c = color(blocks, theme, `var(${name})`, name, new Set());
  const a = byte(c.a * 255);
  const rgb = [c.r, c.g, c.b].map((x) => hex2(byte(x))).join('');
  return `#${rgb}${a === 255 ? '' : hex2(a)}`;
}

/** A channel as CSS draws it: rounded, and clamped to 0…255 (`rgb(300,0,0)` is red). */
const byte = (x: number) => Math.min(255, Math.max(0, Math.round(x)));
const hex2 = (x: number) => x.toString(16).padStart(2, '0').toUpperCase();

function lookup(blocks: ThemeBlocks, theme: string, name: string): string | undefined {
  return blocks[theme]?.[name] ?? blocks['']?.[name];
}

function color(blocks: ThemeBlocks, theme: string, value: string, token: string, seen: Set<string>): Rgba {
  const v = value.trim();
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (ref) {
    const name = ref[1]!;
    const found = lookup(blocks, theme, name);
    if (found === undefined) {
      if (ref[2] !== undefined) return color(blocks, theme, ref[2], token, seen);
      throw new Error(`theme token ${token}: ${name} is not defined`);
    }
    if (seen.has(name)) throw new Error(`theme token ${token}: ${name} refers to itself`);
    return color(blocks, theme, found, token, new Set([...seen, name]));
  }
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgba) return { r: +rgba[1]!, g: +rgba[2]!, b: +rgba[3]!, a: rgba[4] === undefined ? 1 : +rgba[4] };
  const mix = /^color-mix\(\s*in srgb\s*,\s*([\s\S]+?)\s+([\d.]+)%\s*,\s*([\s\S]+)\)$/.exec(v);
  if (mix) return mixed(color(blocks, theme, mix[1]!, token, seen), +mix[2]! / 100, color(blocks, theme, mix[3]!, token, seen));
  throw new Error(`theme token ${token}: not a color (${v})`);
}

/** CSS Color 5 color-mix in srgb: premultiplied by alpha, so mixing with transparent only lowers the alpha. */
function mixed(a: Rgba, p: number, b: Rgba): Rgba {
  const alpha = a.a * p + b.a * (1 - p);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (x: number, y: number) => (x * a.a * p + y * b.a * (1 - p)) / alpha;
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: alpha };
}

function format(c: Rgba): string {
  const r = byte(c.r), g = byte(c.g), b = byte(c.b);
  if (c.a >= 1) return `#${[r, g, b].map(hex2).join('')}`;
  return `rgba(${r},${g},${b},${+c.a.toFixed(4)})`;
}
