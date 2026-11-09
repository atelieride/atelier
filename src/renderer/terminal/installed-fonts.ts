import { useEffect, useState } from 'react';
import { fuzzyFilter } from '@shared/fuzzy';
import { BUNDLED_FONT, installedMonospace, isFontFamily, isMonospaced } from '@shared/terminal-font';

/**
 * The installed fonts the terminal font pickers offer: read through the bridge,
 * kept monospaced by measuring them on a canvas, cached for the window.
 */

/** Every installed family (for "isn't installed"), and the monospaced ones the lists show; 'failed' when unreadable. */
export type InstalledFonts = { all: string[]; mono: string[] } | 'failed';

export interface FontSource { list(): Promise<string[] | null>; monospaced(family: string): boolean }

const MEASURE_CHUNK = 24;

export async function readInstalledFonts(src: FontSource): Promise<InstalledFonts> {
  let all: string[] | null;
  try { all = await src.list(); } catch { all = null; }
  if (!all) return 'failed';
  // Measured a few at a time, letting the window paint in between (~100 ms for 180 families on the first read); the
  // canvas check remembers each family, so the list below reads the results.
  for (let i = 0; i < all.length; i += MEASURE_CHUNK) {
    for (const f of all.slice(i, i + MEASURE_CHUNK)) if (!f.startsWith('.') && isFontFamily(f)) src.monospaced(f);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { all, mono: installedMonospace(all, src.monospaced) };
}


export interface FontChoice { family: string; bundled: boolean }

/** The two sections, filtered by the query (best match first), and the order ↑↓ walk through them. */
export function fontChoices(installed: readonly string[], query: string): { bundled: FontChoice[]; installed: FontChoice[]; flat: FontChoice[] } {
  const q = query.trim();
  const bundled = fuzzyFilter([BUNDLED_FONT], q, (f) => f, 1).map((family) => ({ family, bundled: true }));
  const rest = fuzzyFilter([...installed], q, (f) => f, installed.length).map((family) => ({ family, bundled: false }));
  return { bundled, installed: rest, flat: [...bundled, ...rest] };
}

// Measured once per family and window: a second opening of a picker costs only the list.
const measured = new Map<string, boolean>();
let ctx: CanvasRenderingContext2D | null | undefined;

/** On a canvas, with sans-serif behind it: a name CSS can't resolve measures as sans-serif and drops out. */
function canvasMonospaced(family: string): boolean {
  const known = measured.get(family);
  if (known !== undefined) return known;
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return false;
  const c = ctx;
  c.font = `40px "${family}", sans-serif`;
  const mono = isMonospaced((ch) => c.measureText(ch).width);
  measured.set(family, mono);
  return mono;
}

const bridge: FontSource = { list: () => window.atelier.localFonts(), monospaced: canvasMonospaced };

let last: InstalledFonts | null = null;
let reading: Promise<InstalledFonts> | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const l of listeners) l(); };

/** Reads the list again (one read at a time); the last list stays available meanwhile. */
export function refreshInstalledFonts(src: FontSource = bridge): Promise<InstalledFonts> {
  if (reading) return reading;
  reading = readInstalledFonts(src).then((fonts) => {
    last = fonts;
    reading = null;
    tell();
    return fonts;
  });
  tell();
  return reading;
}

/**
 * For the Font row and the pickers: the last list at once, read again on mount; `reading` while a read runs (a retry
 * after a failure says so), `retry` to read again.
 */
export function useInstalledFonts(): { fonts: InstalledFonts | null; reading: boolean; retry: () => void } {
  const [state, setState] = useState<{ fonts: InstalledFonts | null; reading: boolean }>({ fonts: last, reading: !!reading });
  useEffect(() => {
    const update = () => setState({ fonts: last, reading: !!reading });
    listeners.add(update);
    void refreshInstalledFonts();
    return () => { listeners.delete(update); };
  }, []);
  return { ...state, retry: () => { void refreshInstalledFonts(); } };
}

/**
 * The font to select once the list changes under a query: typed before the installed fonts
 * arrived, the search found nothing to select; its best match is selected when they do. Null: leave the selection.
 */
export function activeOnLoad(query: string, flat: readonly FontChoice[], active: string): string | null {
  if (!query.trim() || flat.some((c) => c.family === active)) return null;
  return flat[0]?.family ?? null;
}
