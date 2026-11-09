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
