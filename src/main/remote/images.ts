// The images a paired phone hands this computer (a pasted screenshot, a photo) for a terminal: checked to be the png
// or jpeg they say they are, kept as private files where Atelier keeps the images pasted into its own terminals
// (clipboard-image.ts, pruned after a day), and named to the phone by an opaque reference. A reference belongs to
// the channel that sent the image (each channel holds its own, MAX_HELD_IMAGES at most, the oldest going first) and to
// that terminal, and names the image in a `say` (its path pasted into Claude's prompt) or a `paste` (its path typed
// into the terminal) of that terminal only, for IMAGE_TTL_MS, until the prompt or the paste that names it goes. The
// phone never names a path.
import { randomBytes } from 'node:crypto';
import { saveClipboardImage, type ImageExt } from '../clipboard-image';
import type { ErrorCode } from './messages';

/** An image's bytes at most, once decoded. */
export const MAX_PHONE_IMAGE = 2 * 1024 * 1024;
/** How long a reference names its image. */
export const IMAGE_TTL_MS = 10 * 60_000;
/** References one channel holds at once, at most: a new one drops the oldest. */
export const MAX_HELD_IMAGES = 10;
export const TOO_MANY_IMAGES = 'Too many images at once; try again in a minute.';
export const IMAGE_GONE = 'The image isn\'t on the computer any more. Send it again.';

type Refusal = { code: ErrorCode; message: string };
const UNUSABLE: Refusal = { code: 'invalid', message: 'This image can\'t be used.' };
const NOT_SAVED: Refusal = { code: 'failed', message: 'The image could not be saved on the computer.' };

/** Each type a phone may send: the extension its file gets, and the bytes it starts with. */
const TYPES: Record<string, { ext: ImageExt; signature: Buffer }> = {
  png: { ext: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpeg: { ext: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) }
};
/** The base64url spelling of MAX_PHONE_IMAGE bytes, at most. */
const MAX_DATA = Math.ceil((MAX_PHONE_IMAGE * 4) / 3);
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * The bytes `data` spells in base64url without padding (as every binary value a phone sends), only when it is their
 * exact spelling: Node decodes loosely (it takes base64's own characters too, skips those it doesn't know, drops stray
 * bits), so what it decodes is spelled again and compared.
 */
function decoded(data: string): Buffer | null {
  if (!BASE64URL.test(data)) return null;
  const bytes = Buffer.from(data, 'base64url');
  return bytes.toString('base64url') === data ? bytes : null;
}

/** An image a phone sent, when it is one: `type` png or jpeg, 1 byte to 2 MiB once decoded, starting with that type's signature. */
export function imageOf(type: string, data: string): { bytes: Buffer; ext: ImageExt } | null {
  const kind = Object.hasOwn(TYPES, type) ? TYPES[type]! : null;
  if (!kind || data.length === 0 || data.length > MAX_DATA) return null;
  const bytes = decoded(data);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_PHONE_IMAGE) return null;
  if (bytes.length < kind.signature.length || !bytes.subarray(0, kind.signature.length).equals(kind.signature)) return null;
  return { bytes, ext: kind.ext };
}

/** An image file's path as Atelier's own Paste types it into a terminal: bracketed only when the program asked for it. */
export function imagePaste(path: string, bracketed: boolean): string {
  return bracketed ? `\x1b[200~${path}\x1b[201~` : path;
}

interface Held { terminal: string; path: string; at: number }

/** One channel's images: the references it was given, each to its terminal's image file. */
export class PhoneImages {
  private readonly held = new Map<string, Held>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly o: { dir: string; ttlMs?: number; now?: () => number; save?: typeof saveClipboardImage }) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? IMAGE_TTL_MS;
  }

  /**
   * Keeps an image the phone sent for `terminal`: its reference (the oldest one held makes room for it), or why not
   * (not an image, not saved).
   */
  keep(terminal: string, type: string, data: string): { ref: string } | Refusal {
    this.sweep();
    const image = imageOf(type, data);
    if (!image) return UNUSABLE;
    let path: string | null;
    try { path = (this.o.save ?? saveClipboardImage)(image.bytes, this.o.dir, new Date(), undefined, image.ext); } catch { return NOT_SAVED; }
    if (!path) return UNUSABLE;
    const ref = randomBytes(16).toString('base64url');
    // Oldest first: the map keeps the order references were given in.
    while (this.held.size >= MAX_HELD_IMAGES) this.held.delete(this.held.keys().next().value!);
    this.held.set(ref, { terminal, path, at: this.now() });
    return { ref };
  }

  /** The prompt or the paste that names these references went: they name nothing any more. */
  use(refs: readonly string[]): void {
    for (const r of refs) this.held.delete(r);
  }

  /** The file `ref` names for `terminal`: null when it was never given, ran out, or is another terminal's. */
  pathOf(ref: string, terminal: string): string | null {
    this.sweep();
    const h = this.held.get(ref);
    return h && h.terminal === terminal ? h.path : null;
  }

  /** The files of every reference, in order; null unless each names one for `terminal`. */
  pathsOf(refs: readonly string[], terminal: string): string[] | null {
    const paths = refs.map((r) => this.pathOf(r, terminal));
    return paths.every((p): p is string => p !== null) ? paths : null;
  }

  /** The channel ended: its references name nothing any more (the files go with the folder's own pruning). */
  clear(): void { this.held.clear(); }

  private sweep(): void {
    const now = this.now();
    for (const [ref, h] of this.held) if (now - h.at >= this.ttlMs) this.held.delete(ref);
  }
}
