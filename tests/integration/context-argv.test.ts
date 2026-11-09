import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Context usage never reaches the model and saves nothing: the only argv of its
// `claude -p` is contextArgs()'s (src/shared/context-usage.ts, whose unit test pins every case), the service hands the
// probe nothing but that argv, and the probe spawns nothing but what it was handed and writes nothing but control
// requests.

const root = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

function uses(re: RegExp): string[] {
  return walk(join(root, 'src/main')).flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (re.test(line) ? [`${posixRel(root, f)}:${i + 1}`] : [])));
}

const service = readFileSync(join(root, 'src/main/context/service.ts'), 'utf8');
const probe = readFileSync(join(root, 'src/main/context/probe.ts'), 'utf8');

test('contextArgs() is called once in main, by the service, and its argv is the only one handed to the probe', () => {
  expect(uses(/\bcontextArgs\(/)).toEqual([expect.stringMatching(/^src\/main\/context\/service\.ts:/)]);
  expect(service.match(/\brunProbe\)\(\{/g)).toHaveLength(1);
  expect(service).toMatch(/const args = contextArgs\(\{/);
  expect(service).toMatch(/runProbe\)\(\{ claudeBin, args, cwd, env, signal,/);
  expect(service.match(/\bargs\b/g)).toHaveLength(2);
});

test('runProbe is called only by the service', () => {
  expect(uses(/\brunProbe\(/)).toEqual([expect.stringMatching(/^src\/main\/context\/probe\.ts:/)]);
});

test('the probe spawns once, the binary it was handed with the argv it was handed, and writes only control requests', () => {
  expect(probe.match(/\bnodeSpawn\b/g)).toHaveLength(2);
  expect(probe).toMatch(/\(o\.spawn \?\? \(nodeSpawn as unknown as ProbeSpawn\)\)\(o\.claudeBin, o\.args, \{/);
  expect(probe).not.toMatch(/o\.args\s*(\.(push|unshift|splice|concat)\b|=[^=])/);
  // stdin gets controlLine()'s lines only: never a user message.
  expect(probe.match(/\.stdin\.write\(/g)).toHaveLength(1);
  expect(probe).toMatch(/child\.stdin\.write\(controlLine\(id, subtype\)\)/);
  expect(probe).not.toMatch(/type: 'user'|"type":"user"/);
});
