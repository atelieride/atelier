// Environment helpers for both platforms. Windows reads variable names in any case (`Path`
// is PATH) and separates folder lists with `;`, but a plain object copy of process.env keeps the exact spelling: set
// `PATH` beside an inherited `Path` and the child may see either. POSIX keeps exact keys and `:` lists, as before.
import { pathStyle, type PathStyle } from './platform';

type Env = Record<string, string | undefined>;
const win = (s?: PathStyle) => (s ?? pathStyle()) === 'win32';

/** The key as the OS compares it: itself on POSIX, upper case on Windows. */
export function envKey(k: string, style?: PathStyle): string {
  return win(style) ? k.toUpperCase() : k;
}

/** A variable's value: the exact key on POSIX; whichever spelling is present on Windows. */
export function envGet(env: Env, name: string, style?: PathStyle): string | undefined {
  if (!win(style)) return env[name];
  const want = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === want) return v;
  return undefined;
}

/** A copy with `name` set: `{ ...env, [name]: value }` on POSIX; on Windows every other spelling of it removed first. */
export function withEnv<E extends Env>(env: E, name: string, value: string, style?: PathStyle): E {
  if (!win(style)) return { ...env, [name]: value };
  const want = name.toUpperCase();
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== want) out[k] = v;
  out[name] = value;
  return out as E;
}

/** A PATH-like list's entries (`:` on POSIX, `;` on Windows), empty ones kept: callers filter. */
export function pathListSplit(value: string, style?: PathStyle): string[] {
  return value.split(win(style) ? ';' : ':');
}

export function pathListJoin(parts: string[], style?: PathStyle): string {
  return parts.join(win(style) ? ';' : ':');
}

/**
 * Folders tried before PATH for tools a Dock-opened macOS app wouldn't find (Homebrew's, /usr/local's); none on
 * Windows, where a Start-menu app inherits the user's full PATH.
 */
export function knownBinDirs(style?: PathStyle): string[] {
  return win(style) ? [] : ['/opt/homebrew/bin', '/usr/local/bin'];
}
