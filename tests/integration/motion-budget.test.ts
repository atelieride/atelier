import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { LASTING_MOTION } from '../../src/renderer/motion';

// Idle motion budget: an animation that loops forever keeps Chromium
// producing a frame on every display refresh (measured: ~46% CPU in the GPU process, ~24% in the renderer).
const root = join(__dirname, '../../src/renderer');
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []);
}
/** Every innermost rule of a stylesheet, comments and @keyframes removed: its selectors (whitespace collapsed) and body. */
function rules(css: string): { selectors: string[]; body: string }[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
    body: m[2]!
  }));
}
const files = cssFiles(root);
const all = files.flatMap((f) => rules(readFileSync(f, 'utf8')).map((r) => ({ ...r, file: relative(root, f) })));
const theme = readFileSync(join(root, 'theme.css'), 'utf8');
const allowed = new Set(LASTING_MOTION.map((m) => m.selector));
const bodyOf = (selector: string) => all.filter((r) => r.selectors.includes(selector)).map((r) => r.body).join(';');

test('only allowlisted selectors loop: every other animation is finite', () => {
  expect(files.length).toBeGreaterThan(3);
  const offenders = all.filter((r) => /\binfinite\b/.test(r.body))
    .flatMap((r) => r.selectors.filter((s) => !allowed.has(s)).map((s) => `${r.file}: ${s}`));
  expect(offenders).toEqual([]);
});

test('every lasting animation has a reason and is really in the CSS, looping', () => {
  for (const m of LASTING_MOTION) {
    expect(m.reason.length, m.selector).toBeGreaterThan(8);
    expect(bodyOf(m.selector), m.selector).toMatch(/\binfinite\b/);
  }
});

test('waiting cues play --cue-cycles, then rest; working, live, pending and starting marks stay still', () => {
  expect(theme).toMatch(/--cue-cycles:\s*3;/);
  expect(theme).toMatch(/--cue-cycles-long:\s*8;/);
  for (const c of ['.pulse', '.state-chip.st-waiting i', '.avatar.av-waiting', '.conflict-dot']) {
    expect(bodyOf(c), c).toMatch(/animation:\s*atl-(breathe|ring)-cue [^;]*var\(--cue-cycles\)/);
  }
  for (const c of ['.ci-pending .pr-ci', '.work-dot', '.bgv-live > i', '.bgv-jump.is-following > i', '.pulse-live', '.cb-bar.is-running',
    '.state-chip.st-starting i', '.palette-hint .live-dot']) {
    expect(bodyOf(c), c).not.toMatch(/animation/);
  }
});

test('no label sweeps or loops, not even the visible session bar: the shimmer is gone', () => {
  // Measured on a packaged app: the bar's looping shimmer alone kept the GPU process at 20-25% while Claude worked;
  // Claude
  // Code's own spinner repaints far less (Reduced motion: 0-1% with sessions working).
  expect(files.filter((f) => /shimmer/.test(readFileSync(f, 'utf8')))).toEqual([]);
  expect(LASTING_MOTION.some((m) => m.selector.includes('shimmer'))).toBe(false);
  expect(readFileSync(join(root, 'components/SessionBar.tsx'), 'utf8')).not.toMatch(/is-live/);
});

test('the footer\'s running count is static; the waiting dots are keyed on the count, so each new waiting session replays them', () => {
  const footer = readFileSync(join(root, 'components/Footer.tsx'), 'utf8');
  const bar = readFileSync(join(root, 'components/ActivityBar.tsx'), 'utf8');
  expect(footer).not.toMatch(/c\.running \? 'shimmer'/);
  // Keyed on a key that moves only when the count rises (an answered session must not replay the cue).
  expect(footer).toMatch(/const waitKey = useRisingKey\(c\.waiting\)/);
  expect(footer).toMatch(/<i key=\{waitKey\} className=\{c\.waiting \? 'pulse' : ''\}/);
  expect(bar).toMatch(/const waitKey = useRisingKey\(waiting\)/);
  expect(bar).toMatch(/<span key=\{waitKey\} className="act-dot is-waiting pulse"/);
});

test('an inactive window stops exactly the lasting animations, on their rest state (animation: none)', () => {
  const prefix = ':root[data-window="inactive"] ';
  const rule = all.find((r) => r.selectors.length > 0 && r.selectors.every((s) => s.startsWith(prefix)));
  expect(rule?.body).toMatch(/animation:\s*none\s*!important/);
  expect(rule!.selectors.map((s) => s.slice(prefix.length)).sort()).toEqual([...allowed].sort());
  const main = readFileSync(join(root, 'main.tsx'), 'utf8');
  expect(main).toMatch(/trackWindowActivity\(window, document\.documentElement, document\.hasFocus\(\)\)/);
});

test('a cue starts and ends on its rest state: nothing snaps at the cycle boundaries, no halo', () => {
  const kf = (n: string) => theme.match(new RegExp(`@keyframes ${n}\\s*\\{([\\s\\S]*?\\})\\s*\\}`))?.[1] ?? '';
  expect(kf('atl-breathe-cue')).toMatch(/0%, 100% \{ opacity: 1; \}/);
  expect(kf('atl-ring-cue')).toMatch(/0%, 100% \{ box-shadow: 0 0 0 1\.5px var\(--ring, var\(--waiting-mark\)\); \}/);
  expect(bodyOf('.avatar.av-waiting')).toMatch(/box-shadow:\s*0 0 0 1\.5px var\(--ring, var\(--waiting-mark\)\)/);
  expect(all.filter((r) => /--rest-halo/.test(r.body)).flatMap((r) => r.selectors)).toEqual([]);
});

test('waiting worktree avatars in Changes keep their ring at rest', () => {
  // The ring is a mark, not text: --waiting-mark (--waiting itself in every theme but Docsy).
  expect(bodyOf('.wt-avatars .avatar.av-waiting')).toMatch(/box-shadow:\s*0 0 0 1\.5px var\(--ring, var\(--waiting-mark\)\)/);
});

test('the Docker view waiting for a stopped engine spins a few cycles, then rests', () => {
  expect(bodyOf('.dk-state.st-stopped .dk-spin')).toMatch(/animation-iteration-count:\s*var\(--cue-cycles-long\)/);
});

test('the waiting pane glow: a calm static layer, and a bright layer that animates opacity only, --cue-cycles times', () => {
  const kf = theme.match(/@keyframes atl-wait-ring\s*\{([\s\S]*?\})\s*\}/)?.[1] ?? '';
  expect(kf).toMatch(/opacity/);
  expect(kf).not.toMatch(/box-shadow/);
  for (const el of ['.workspace-body.is-waiting', '.pane-frame.is-waiting']) {
    expect(bodyOf(`${el}::before`), el).toMatch(/box-shadow:\s*var\(--wait-ring\)/);
    expect(bodyOf(`${el}::after`), el).toMatch(/box-shadow:\s*var\(--wait-ring-bright\)/);
    expect(bodyOf(`${el}::after`), el).toMatch(/opacity:\s*0\s*;/);
    expect(bodyOf(`${el}::after`), el).toMatch(/animation:\s*atl-wait-ring 2\.4s ease-in-out var\(--cue-cycles\)/);
  }
});
