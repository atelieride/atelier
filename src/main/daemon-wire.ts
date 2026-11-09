// Paths on the app ⇄ atelierd protocol are canonical: `C:/…` on Windows. Main's own paths
// (path.join, dialogs, realpath) are native there, so every request is converted once, where main talks to atelierd.
import { toCanonical } from '@shared/paths';
import { pathStyle, type PathStyle } from '@shared/platform';

const PATH_FIELDS = ['projectRoot', 'cwd', 'root', 'configDir'] as const;
const PATH_LISTS = ['dirty', 'exclude'] as const;

/** The request with its path fields canonical on Windows; the same object on POSIX. */
export function canonicalRequest<T extends object>(msg: T, style: PathStyle = pathStyle()): T {
  if (style !== 'win32') return msg;
  const c = (v: unknown) => (typeof v === 'string' ? toCanonical(v, 'win32') : v);
  const out = { ...msg } as Record<string, unknown>;
  for (const k of PATH_FIELDS) if (k in out) out[k] = c(out[k]);
  for (const k of PATH_LISTS) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(c);
  const profile = out.profile as { shell?: unknown } | undefined;
  if (profile && typeof profile === 'object' && typeof profile.shell === 'string') out.profile = { ...profile, shell: c(profile.shell) };
  return out as T;
}
