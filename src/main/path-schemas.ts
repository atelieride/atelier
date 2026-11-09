// Path shapes for IPC input. The renderer sends paths in the canonical form (shared/paths.ts
// toCanonical): POSIX paths as they are on macOS, `C:/…` on Windows. The POSIX schemas are exactly the zod checks
// ipc-schemas.ts had; the Windows ones refuse backslashes, drive-relative paths and UNC shares outright.
import { z } from 'zod';
import { isRepoRel, isSafeRel, win32NameProblem } from '@shared/paths';
import { pathStyle, type PathStyle } from '@shared/platform';

const CANONICAL_ABS = /^[A-Za-z]:\//;
/**
 * No name NTFS reads as something else either: a colon past the drive is a stream (`.git::$INDEX_ALLOCATION` opens the
 * .git folder, CVE-2019-1352), `con` or `nul.txt` a device; no Windows path has them.
 */
const opensItself = (seg: string) => { const why = win32NameProblem(seg); return why !== 'character' && why !== 'reserved'; };
const canonicalAbs = (p: string) => CANONICAL_ABS.test(p) && !p.includes('\\') && !p.includes('\0') && p.slice(3).split('/').every(opensItself);

/** An absolute path of min..max characters. */
export function absPathSchema(min: number, max: number, style: PathStyle = pathStyle()) {
  const s = z.string().min(min).max(max);
  return style === 'win32' ? s.refine(canonicalAbs, 'path') : s.startsWith('/');
}

/** A relative path that stays inside its root: no empty, `.` or `..` segment (and no Windows-reserved name there). */
export function safeRelSchema(max: number, style: PathStyle = pathStyle()) {
  return z.string().min(1).max(max).refine((r) => isSafeRel(r, style), 'path');
}

/** A path inside a repository as git prints it: relative, no `..` segment, no NUL (and no backslash or drive on Windows). */
export function gitRelSchema(max: number, style: PathStyle = pathStyle()) {
  return z.string().min(1).max(max).refine((r) => isRepoRel(r, style), 'path');
}

/** A file tab's key, `f:` + an absolute path (Save As in a pop-out). */
export function filePathKeySchema(max: number, style: PathStyle = pathStyle()) {
  const s = z.string().min(3).max(max);
  return style === 'win32'
    ? s.refine((k) => k.startsWith('f:') && canonicalAbs(k.slice(2)), 'path')
    : s.startsWith('f:/').refine((k) => !k.includes('\0'), 'path');
}
