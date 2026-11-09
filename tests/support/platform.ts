import { statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { setTestDefaultPlatform } from '../../src/shared/platform';

// The machine a test runs on. Unit tests describe macOS behaviour by default (tests/setup-env
// forces darwin for the app's own platform switch); these tell what the machine itself can do: a test that needs
// POSIX (unix sockets, launchd, zsh, tmux, ps/lsof, codesign, #!/bin/sh fakes, mode bits) says so with posixOnly.

export const isWin = process.platform === 'win32';
export const isPosix = !isWin;

/**
 * The wall-clock budget of a test that tells linear from quadratic work on a big input: macOS's number, five times it
 * on Windows, whose CI runner has slow spells (2026-11-01, the v0.2.0-beta.23 tag: a 200 ms budget measured 300 ms).
 * Quadratic work on those inputs takes minutes, so the wider budget still catches it.
 */
export const linearBudget = (ms: number): number => (isWin ? 5 * ms : ms);

/** describe() that runs only on macOS and Linux: one-line reason in the title or a comment next to it. */
export const posixOnly = describe.skipIf(isWin);
/** test() that runs only on macOS and Linux. */
export const posixTest = test.skipIf(isWin);
/** describe() and test() that run only on Windows (real PowerShell, Git for Windows, native .exe helpers). */
export const winOnly = describe.skipIf(!isWin);
export const winTest = test.skipIf(!isWin);

/**
 * For a test file on real files: the app's platform switch reads the machine's platform (win32 on Windows), so the
 * main process checks native C:\ paths as the app does there. Call at the top of the file.
 */
export function useMachinePlatform(): void {
  beforeAll(() => { setTestDefaultPlatform(null); });
}

/**
 * A file's permission bits, where they exist: NTFS has ACLs instead (a fresh file reads 0o666), so on Windows the
 * check is skipped and the rest of the test still runs.
 */
export function expectMode(path: string, mode: number): void {
  if (isPosix) expect(statSync(path).mode & 0o777).toBe(mode);
}

/** `to` relative to `from` with `/` separators (repo paths in allow-lists are written that way on every machine). */
export const posixRel = (from: string, to: string): string => relative(from, to).split(sep).join('/');
