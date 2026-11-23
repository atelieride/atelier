import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Every way main asks atelierd for a terminal that may run in the Atelier profile checks
// the user's zsh files first. Static guard: dropping one of these awaits would otherwise pass every other test.
const hub = readFileSync('src/main/terminal-hub.ts', 'utf8');

/** A handler's body: from its `handle(IPC.<name>,` to the next `handle(` or `on(` at the same indentation. */
function handler(name: string): string {
  const start = hub.indexOf(`    handle(IPC.${name},`);
  expect(start, name).toBeGreaterThan(-1);
  const next = hub.slice(start + 1).search(/\n {4}(handle|on|ipcMain\.handle)\(/);
  return hub.slice(start, next === -1 ? undefined : start + 1 + next);
}

test.each(['termCreate', 'termCreateSession', 'termResume', 'claudeResume'])('%s checks the shell environment before asking atelierd', (name) => {
  const body = handler(name);
  const check = body.indexOf('await this.freshEnv(');
  const request = body.search(/this\.client\.request</);
  expect(check, `${name}: no freshEnv`).toBeGreaterThan(-1);
  expect(request, `${name}: no request`).toBeGreaterThan(-1);
  expect(check, `${name}: freshEnv after the request`).toBeLessThan(request);
});

test('a session a phone starts checks the shell environment before each request to atelierd', () => {
  const start = hub.indexOf('  async createRemoteSession(');
  expect(start).toBeGreaterThan(-1);
  const body = hub.slice(start, hub.indexOf('\n  }\n', start));
  // One check before each of the two requests (Claude session, terminal).
  const checks = [...body.matchAll(/await this\.freshEnvQuietly\(/g)].map((m) => m.index!);
  const requests = [...body.matchAll(/this\.client\.request</g)].map((m) => m.index!);
  expect(requests).toHaveLength(2);
  expect(checks).toHaveLength(2);
  expect(checks[0]!).toBeLessThan(requests[0]!);
  expect(checks[1]!).toBeGreaterThan(requests[0]!);
  expect(checks[1]!).toBeLessThan(requests[1]!);
  // A session a phone resumes too: checked before its request.
  const resume = hub.slice(hub.indexOf('  async resumeRemote('));
  const resumeBody = resume.slice(0, resume.indexOf('\n  }\n'));
  expect(resumeBody.indexOf('await this.freshEnvQuietly(')).toBeGreaterThan(-1);
  expect(resumeBody.indexOf('await this.freshEnvQuietly(')).toBeLessThan(resumeBody.search(/this\.client\.request</));
  const quiet = hub.slice(hub.indexOf('  private async freshEnvQuietly('));
  expect(quiet.slice(0, quiet.indexOf('\n  }\n'))).toMatch(/await this\.freshness\.ensure\(this\.checkedFiles\(\)/);
});
