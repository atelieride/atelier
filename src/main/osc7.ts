import { toCanonical } from '@shared/paths';
import type { PathStyle } from '@shared/platform';

// A terminal's current folder from OSC 7 (no atelierd change). The PowerShell
// integration prints `ESC ] 7 ; file:///C:/dev/x BEL` at each prompt; main reads it from the data it relays to windows,
// so a terminal no window attached keeps no live folder (its start folder stands in). Pure.

const START = '\x1b]7;';
/** An OSC longer than this is not a folder: dropped rather than buffered. */
const MAX_OSC = 8192;

/** The folder a `file://` URI names, canonical; null for anything else (another scheme, a share, a bad encoding). */
export function osc7Path(uri: string, style: PathStyle): string | null {
  let u: URL;
  try { u = new URL(uri); } catch { return null; }
  if (u.protocol !== 'file:') return null;
  let p: string;
  try { p = decodeURIComponent(u.pathname); } catch { return null; }
  if (style === 'win32') return /^\/[A-Za-z]:\//.test(p) ? toCanonical(p.slice(1), 'win32') : null;
  return p.startsWith('/') && (u.hostname === '' || u.hostname === 'localhost') ? p : null;
}

export class Osc7Tracker {
  private tail = new Map<string, string>();
  private cwd = new Map<string, string>();

  constructor(private readonly style: PathStyle) {}

  feed(id: string, data: string): void {
    const text = (this.tail.get(id) ?? '') + data;
    this.tail.delete(id);
    let at = text.indexOf(START);
    while (at >= 0) {
      const from = at + START.length;
      const bel = text.indexOf('\x07', from);
      const st = text.indexOf('\x1b\\', from);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      if (end < 0) {
        // Unfinished: kept for the next chunk, unless it is already too long to be a folder.
        if (text.length - at <= MAX_OSC) this.tail.set(id, text.slice(at));
        return;
      }
      if (end - from <= MAX_OSC) {
        const p = osc7Path(text.slice(from, end), this.style);
        if (p) this.cwd.set(id, p);
      }
      at = text.indexOf(START, end);
    }
    // A chunk may end inside `ESC ] 7 ;` itself.
    const partial = [3, 2, 1].find((n) => text.endsWith(START.slice(0, n)));
    if (partial) this.tail.set(id, START.slice(0, partial));
  }

  cwdOf(id: string): string | null {
    return this.cwd.get(id) ?? null;
  }

  forget(id: string): void {
    this.tail.delete(id);
    this.cwd.delete(id);
  }
}
