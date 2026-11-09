import { currentPlatform, type Platform } from '@shared/platform';

// Git is optional on Windows (decided): Atelier stays an editor, and the git views say why they
// are empty — not "clean", not a raw spawn error — with a link to the installer. macOS shows what it always did.

export const GIT_FOR_WINDOWS = 'https://git-scm.com/download/win';

/** An error of a git that could not start: no git on the PATH. */
export function isGitMissing(error: string | null | undefined): boolean {
  return !!error && /\bspawn git ENOENT\b/.test(error);
}

/** Whether the git views show "Git isn't installed" instead of their content. */
export function gitMissing(errors: readonly (string | null | undefined)[], platform: Platform = currentPlatform()): boolean {
  return platform === 'win32' && errors.some(isGitMissing);
}
