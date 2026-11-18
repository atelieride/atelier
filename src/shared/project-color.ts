// A project's color: one of the eight workspace hues (theme.css `--ws-1…8`), kept by project root in the settings and
// worn by the project's window (its chip, a faint tint of the header) so that several windows side by
// side tell apart at a glance. Pure.
import { isAbsPath } from './paths';

export const PROJECT_COLOR_COUNT = 8;
/** The most projects whose color is remembered; past it, the ones colored longest ago go. */
export const PROJECT_COLORS_MAX = 300;
const MAX_ROOT = 1024;

export type ProjectColors = Record<string, number>;

const isColor = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= PROJECT_COLOR_COUNT;
const isRoot = (v: string): boolean => isAbsPath(v) && v.length <= MAX_ROOT && !v.includes('\u0000');

/** Whether `v` is the saved form exactly: what a change coming from a window must be. */
export function isProjectColors(v: unknown): v is ProjectColors {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length <= PROJECT_COLORS_MAX && entries.every(([root, c]) => isRoot(root) && isColor(c));
}

/** From the file (whatever it holds) to valid colors: absolute folders with a color from 1 to 8, the latest kept. */
export function normalizeProjectColors(raw: unknown): ProjectColors {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const ok = Object.entries(raw as Record<string, unknown>).filter((e): e is [string, number] => isRoot(e[0]) && isColor(e[1]));
  return Object.fromEntries(ok.slice(-PROJECT_COLORS_MAX));
}

/** A steady number from a folder's path (FNV-1a). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A folder's steady color, from its path alone: worn while it has none saved, and where main's pick starts. */
function steadyColor(root: string): number {
  return 1 + (hash(root) % PROJECT_COLOR_COUNT);
}

/** The color `root` has: its saved one, else its folder's steady color (never what the other projects have). */
export function projectColorFor(colors: ProjectColors, root: string): number {
  const mine = colors[root];
  return isColor(mine) ? mine : steadyColor(root);
}

/**
 * The color of `root`'s window: the one it has, else the one fewest open windows wear, then the one fewest known
 * projects have, then the folder's own steady pick. `open`: the roots of the windows already open.
 */
export function pickProjectColor(colors: ProjectColors, open: readonly string[], root: string): number {
  const mine = colors[root];
  if (isColor(mine)) return mine;
  const count = (roots: readonly string[]) => {
    const n = new Array<number>(PROJECT_COLOR_COUNT + 1).fill(0);
    for (const r of roots) { const c = colors[r]; if (r !== root && isColor(c)) n[c]!++; }
    return n;
  };
  const inOpen = count(open);
  const inAll = count(Object.keys(colors));
  // From the steady color on: with nothing to tell the colors apart, the pick is the steady color.
  const start = steadyColor(root) - 1;
  let best = 0;
  for (let i = 0; i < PROJECT_COLOR_COUNT; i++) {
    const c = 1 + ((start + i) % PROJECT_COLOR_COUNT);
    if (best === 0 || inOpen[c]! < inOpen[best]! || (inOpen[c] === inOpen[best] && inAll[c]! < inAll[best]!)) best = c;
  }
  return best;
}

/** The colors with `root` wearing `color`, as the latest; the oldest go past the limit. */
export function withProjectColor(colors: ProjectColors, root: string, color: number): ProjectColors {
  const rest = Object.entries(colors).filter(([r]) => r !== root);
  return Object.fromEntries([...rest, [root, color] as [string, number]].slice(-PROJECT_COLORS_MAX));
}

/** The color a window wears: its project's (the folder's steady color until one is saved); none with the tint off or no project. */
export function projectColorOf(s: { projectTint: boolean; projectColors: ProjectColors }, root: string | null | undefined): number | null {
  if (!s.projectTint || !root) return null;
  return projectColorFor(s.projectColors, root);
}
