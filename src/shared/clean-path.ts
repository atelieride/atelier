import { isCleanAbsPath as cleanAbs } from './paths';

/**
 * An absolute path with no empty, `.` or `..` segment and no control character (C0, DEL, C1: such a path may be typed
 * into a terminal, where U+009B is a CSI), at most 4096 long (not `/`). On Windows: a drive path, every name valid
 * there.
 */
export function isCleanAbsPath(p: unknown): p is string {
  // One argument only: a zod refine or an array callback must never reach the helper's `style` parameter.
  return cleanAbs(p);
}
