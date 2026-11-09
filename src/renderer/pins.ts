// Pinned sessions and terminals: terminal ids per project root, saved in localStorage like the panel widths.

export type PinsByProject = Record<string, string[]>;

/** Projects come and go: the least recently changed ones are forgotten past this many. */
export const MAX_PINNED_PROJECTS = 50;
export const KEY = 'atelier.pins';

/** From the saved value (whatever it contains) to valid pins. */
export function parsePins(raw: string | null): PinsByProject {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: no pins */ }
  const out: PinsByProject = {};
  for (const [root, ids] of Object.entries(o)) {
    if (!Array.isArray(ids)) continue;
    const valid = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
    if (valid.length) out[root] = valid;
  }
  return out;
}

/** The pins of `root` replaced by `ids` (none: the project is removed); the project becomes the most recent one. */
export function withProjectPins(all: PinsByProject, root: string, ids: string[]): PinsByProject {
  const rest = Object.entries(all).filter(([r]) => r !== root);
  if (ids.length) rest.push([root, ids]);
  return Object.fromEntries(rest.slice(-MAX_PINNED_PROJECTS));
}

export function loadPins(root: string): string[] {
  try { return parsePins(localStorage.getItem(KEY))[root] ?? []; } catch { return []; }
}

export function savePins(root: string, ids: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(withProjectPins(parsePins(localStorage.getItem(KEY)), root, ids))); } catch { /* not saved: stays for this session */ }
}

/** Pins a terminal at the end of the pinned ones, or unpins it. */
export function togglePin(pins: string[], id: string): string[] {
  return pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
}

/**
 * Pins of terminals that no longer exist are dropped. An empty list drops nothing: it is also what arrives
 * before atelierd has sent the first one, and with no terminals the pins have nothing to reorder anyway.
 */
export function prunePins(pins: string[], alive: string[]): string[] {
  if (alive.length === 0) return pins;
  const ids = new Set(alive);
  return pins.filter((x) => ids.has(x));
}

/** Pinned rows first, in pin order; the others keep their order. */
export function pinnedFirst<T extends { id: string }>(list: T[], pins: string[]): T[] {
  if (pins.length === 0) return list;
  const byId = new Map(list.map((x) => [x.id, x]));
  const pinned = pins.map((id) => byId.get(id)).filter((x): x is T => x !== undefined);
  const set = new Set(pinned.map((x) => x.id));
  return [...pinned, ...list.filter((x) => !set.has(x.id))];
}

/** A resumed session is a new terminal: its pin moves to the new id, at the same place in the pin order. */
export function relinkPin(pins: string[], from: string, to: string): string[] {
  const i = pins.indexOf(from);
  if (i < 0 || from === to) return pins;
  return pins.map((x, j) => (j === i ? to : x)).filter((x, j) => x !== to || j === i);
}
