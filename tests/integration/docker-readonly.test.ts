import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { posixRel } from '../support/platform';
import { ALLOWED_PATHS } from '../../src/main/docker/engine';

// Whoever can write to the Docker socket is root-equivalent on the engine, so read-only must be
// impossible to break by mistake, not just unused:
// - the allowlist is exactly the nine read endpoints;
// - under src/main/docker/ no method but GET, and none of the write endpoints is even spelled;
// - engine.ts connects through `socketPath` only (no host, no port: never a TCP engine);
// - only engine.ts imports node:http among the Docker modules, and nothing else in src/ names the Docker socket API.
const root = join(__dirname, '..', '..');
const DIR = 'src/main/docker/';
const ENGINE = 'src/main/docker/engine.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
type Source = { path: string; text: string };
const all = (): Source[] => sources(join(root, 'src')).map((p) => ({ path: posixRel(root, p), text: readFileSync(p, 'utf8') }));

const WRITE_WORDS = /\/(start|stop|restart|kill|exec|attach|create|prune|pull|build|pause|unpause|update|rename|wait|commit|export|archive|resize)\b|['"`](POST|PUT|DELETE|PATCH|HEAD)['"`]/;

const rules = {
  methods: (files: Source[]) => files.filter((f) => f.path.startsWith(DIR)).flatMap((f) =>
    [...f.text.matchAll(/method\s*:\s*['"`]?([A-Za-z]+)/g)].map((m) => m[1]).filter((m) => m !== 'GET').map((m) => `${f.path}: ${m}`)),
  writeWords: (files: Source[]) => files.filter((f) => f.path.startsWith(DIR) && WRITE_WORDS.test(f.text)).map((f) => f.path),
  socketOnly: (files: Source[]) => files.filter((f) => f.path === ENGINE && (!/socketPath:/.test(f.text) || /\b(host|hostname|port)\s*:/.test(f.text))).map((f) => f.path),
  httpImports: (files: Source[]) => files.filter((f) => f.path.startsWith(DIR) && f.path !== ENGINE && /from\s+['"](node:)?(https?|net|http2)['"]/.test(f.text)).map((f) => f.path),
  engineApi: (files: Source[]) => files.filter((f) => !f.path.startsWith(DIR) && /['"`]\/containers\/|['"`]\/_ping['"`]|['"`]\/system\/df['"`]/.test(f.text)).map((f) => f.path)
};

describe('Docker stays read-only', () => {
  test('the allowlist is exactly the nine read endpoints', () => {
    expect([...ALLOWED_PATHS].sort()).toEqual([
      '/_ping', '/containers/json', '/containers/{id}/json', '/containers/{id}/logs', '/containers/{id}/stats', '/events', '/info', '/system/df', '/version'
    ]);
  });
  test('no method but GET under src/main/docker/', () => { expect(rules.methods(all())).toEqual([]); });
  test('no write endpoint or verb is spelled under src/main/docker/', () => { expect(rules.writeWords(all())).toEqual([]); });
  test('the engine is reached through socketPath only', () => {
    expect(rules.socketOnly(all())).toEqual([]);
    expect(readFileSync(join(root, ENGINE), 'utf8')).toContain("method: 'GET'");
  });
  test('only engine.ts makes requests among the Docker modules; nobody else talks to the Engine API', () => {
    expect(rules.httpImports(all())).toEqual([]);
    expect(rules.engineApi(all())).toEqual([]);
  });

  test('the rules catch what they guard against', () => {
    const bad: Source[] = [
      { path: 'src/main/docker/hub.ts', text: "request({ method: 'POST' }); const p = `/containers/${id}/restart`;" },
      { path: ENGINE, text: "request({ socketPath: s, host: 'localhost', port: 2375, method: 'GET' })" },
      { path: 'src/main/docker/other.ts', text: "import http from 'node:http';" },
      { path: 'src/main/elsewhere.ts', text: "get('/containers/json')" }
    ];
    expect(rules.methods(bad)).toEqual(['src/main/docker/hub.ts: POST']);
    expect(rules.writeWords(bad)).toEqual(['src/main/docker/hub.ts']);
    expect(rules.socketOnly(bad)).toEqual([ENGINE]);
    expect(rules.httpImports(bad)).toEqual(['src/main/docker/other.ts']);
    expect(rules.engineApi(bad)).toEqual(['src/main/elsewhere.ts']);
  });
});
