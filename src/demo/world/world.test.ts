import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { COMMITS, FILES } from './project';
import { SCENARIOS } from './scenarios';
import { dockerContainers } from './docker';
import { acmeStoreSeed } from './redis';

// The world is imported by the browser demo as well as by Node tests: no Node APIs.
describe('world: Node-free', () => {
  const dir = __dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const NODE = /\b(?:from|import|require)\s*\(?\s*['"](?:node:[^'"]+|fs|fs\/promises|path|os|child_process|crypto|net|http|https|url|util|stream|buffer|process|worker_threads)['"]/;

  // Node's globals in code (`Buffer.from`, `process.env`), not in the data's strings ("node:internal/process/…").
  const NODE_GLOBAL = /(?<![\w.'"/:])(?:Buffer|process)\s*\.|\b__(?:dirname|filename)\b|\brequire\s*\(/;

  test('has the four modules', () => {
    expect(sources).toEqual(expect.arrayContaining(['project.ts', 'scenarios.ts', 'docker.ts', 'redis.ts']));
  });

  test.each(sources)('%s imports no Node module and uses no Node global', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    expect(src).not.toMatch(NODE);
    expect(src).not.toMatch(NODE_GLOBAL);
  });

  test('the guard catches a Node import (mutation check)', () => {
    expect("import { readFileSync } from 'node:fs';").toMatch(NODE);
    expect("import { createHash } from 'crypto';").toMatch(NODE);
    expect("const cp = require('child_process');").toMatch(NODE);
    expect('const b = Buffer.from(s);').toMatch(NODE_GLOBAL);
    expect('if (process.env.X) {}').toMatch(NODE_GLOBAL);
    expect("'    at f (node:internal/process/task_queues:95:5)'").not.toMatch(NODE_GLOBAL);
  });
});

describe('world: the fictional acme-store', () => {
  test('the project has its 8 files, each committed exactly once', () => {
    expect(Object.keys(FILES)).toHaveLength(8);
    expect(COMMITS.map((c) => c.message)).toEqual(['Start the Acme store', 'Add sessions, invoices and the welcome page', 'Test invoice totals']);
    expect(COMMITS.flatMap((c) => c.files).sort()).toEqual(Object.keys(FILES).sort());
  });

  test('five scenarios, in the sidebar order of the screenshots', () => {
    expect(Object.keys(SCENARIOS)).toEqual(['auth-refactor', 'billing-tests', 'onboarding-copy', 'db-migration', 'docs']);
    expect(SCENARIOS['db-migration'].state).toBe('question');
    for (const s of Object.values(SCENARIOS)) for (const e of s.edits) expect(Object.keys(FILES)).toContain(e.file);
  });

  test('the worker crashed with exit code 1 (and runs in the healthy variant)', () => {
    const worker = (healthy: boolean) => dockerContainers('/p', 0, { healthy }).find((c) => c.key === 'worker')!.spec;
    expect(worker(false)).toMatchObject({ state: 'exited', exitCode: 1, restarts: 3 });
    expect(worker(true).state ?? 'running').toBe('running');
  });

  test('Redis holds failed BullMQ jobs', () => {
    const seed = acmeStoreSeed(1_000_000);
    const failed = seed.keys.find((k) => k.key === 'bull:email-queue:failed');
    expect(failed?.value.type).toBe('zset');
    expect(Object.keys(failed!.value.v as Record<string, number>).sort()).toEqual(['8801', '8809', '8812']);
    expect(seed.keys.find((k) => k.key === 'bull:email-queue:8812')?.value).toMatchObject({ type: 'hash', v: { failedReason: 'connect ECONNREFUSED 127.0.0.1:1025' } });
  });
});
