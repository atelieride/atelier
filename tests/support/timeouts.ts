// The suite's per-test timeout (vitest.config.ts). Windows: on 2026-11-01 three release runs in a row each had one
// git-heavy test (dozens of git, sh and PowerShell processes, 4–8 s there normally) pass 20 s in a slow spell of the
// CI runner, a different test each time (guard.win32, git-ops' push.default); a minute there.
export function testTimeoutFor(platform: NodeJS.Platform): number {
  return platform === 'win32' ? 60_000 : 20_000;
}
