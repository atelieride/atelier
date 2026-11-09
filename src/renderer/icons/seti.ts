import rawDefinitions from './seti/definitions.json';
import rawIcons from './seti/icons.json';

// File icons from the Seti set (MIT, jesseweed/seti-ui), VSCode's default, with its colors. The two JSON files are
// lib/ of the seti-icons 0.0.4 package, unchanged (license: assets/licenses/MIT-seti-icons.txt).
type Def = [string, string];
interface Definitions { files: Record<string, Def>; extensions: Record<string, Def>; partials: [string, Def][]; default: Def }
const defs = rawDefinitions as unknown as Definitions;
const icons = rawIcons as unknown as Record<string, string>;
// The maps come from JSON: only what they really contain is read, never Object's keys ("constructor", "__proto__"...).
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

// Seti's color names; the colors are theme tokens (--seti-<name> in theme.css and themes.css: light themes need darker ones).
const COLORS: Record<string, string> = Object.fromEntries(
  ['blue', 'grey', 'grey-light', 'green', 'orange', 'pink', 'purple', 'red', 'white', 'yellow', 'ignore'].map((n) => [n, `var(--seti-${n})`])
);

/** Atelier additions where the package has no rule. */
function extra(name: string, lower: string): Def | null {
  if (['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep'].includes(lower)) return ['git', 'ignore'];
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || /^(docker-)?compose\.ya?ml$/.test(lower)) return ['docker', 'blue'];
  if (/^licen[cs]e(\.(md|txt))?$/.test(lower)) return ['license', 'yellow'];
  if (lower.startsWith('eslint.config.') || lower.startsWith('.eslintrc')) return ['eslint', 'purple'];
  if (lower === 'yarn.lock') return ['yarn', 'blue'];
  if (lower.endsWith('.lock')) return ['lock', 'green'];
  if (lower === '.env' || lower.startsWith('.env.')) return ['config', 'grey-light'];
  if (lower === 'readme') return ['info', 'blue'];
  if (lower === 'go.mod' || lower === 'go.sum' || lower === 'go.work') return ['go2', 'blue'];
  void name;
  return null;
}

function lookup(name: string): Def {
  const lower = name.toLowerCase();
  const x = extra(name, lower);
  if (x) return x;
  const exact = own(defs.files, name);
  if (exact) return exact;
  // Full file names among the "partials" (e.g. CMakeLists.txt) win over the extension, case-insensitively.
  for (const [part, d] of defs.partials) if (part.toLowerCase() === lower) return d;
  // Extensions from the longest: "a.test.ts" tries ".test.ts", then ".ts".
  let ext = lower.slice(lower.indexOf('.') >= 0 ? lower.indexOf('.') : lower.length);
  while (ext) {
    const d = own(defs.extensions, ext);
    if (d) return d;
    ext = ext.slice(1);
    const i = ext.indexOf('.');
    ext = i >= 0 ? ext.slice(i) : '';
  }
  for (const [part, d] of defs.partials) if (lower.includes(part.toLowerCase())) return d;
  return defs.default;
}

export function iconFor(name: string): { id: string; color: string } {
  const [id, color] = lookup(name);
  return { id: own(icons, id) ? id : 'default', color: own(COLORS, color) ?? COLORS.white! };
}

const KEEP_TAGS = new Set(['path', 'g', 'circle', 'ellipse', 'rect']);
const KEEP_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'transform', 'fill-rule', 'clip-rule', 'opacity']);

/** Only shapes and geometric attributes: no styles, gradients, scripts or event handlers. */
function clean(svg: string): { viewBox: string; body: string } {
  // Seti glyphs occupy the center of the 32×32 grid: the margin is cropped so they show enlarged.
  const raw = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1] ?? '0 0 32 32';
  const viewBox = raw.trim() === '0 0 32 32' ? '5 5 22 22' : raw;
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<defs[\s\S]*?<\/defs>/g, '');
  const body = inner.replace(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g, (_m, close: string, tag: string, attrs: string, self: string) => {
    if (!KEEP_TAGS.has(tag)) return '';
    if (close) return `</${tag}>`;
    const kept = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].filter((a) => KEEP_ATTRS.has(a[1]!)).map((a) => ` ${a[1]}="${a[2]}"`).join('');
    return `<${tag}${kept}${self ? '/' : ''}>`;
  });
  return { viewBox, body };
}

/** A sprite with one symbol per icon: inserted once, and each icon is a <use>. */
export function spriteMarkup(): string {
  const symbols = Object.entries(icons).map(([id, svg]) => {
    const { viewBox, body } = clean(svg);
    return `<symbol id="seti-${id}" viewBox="${viewBox}">${body}</symbol>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${symbols.join('')}</svg>`;
}
