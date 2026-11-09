// Stamps a green run of the whole suite, next to Playwright's list reporter in
// playwright.config.ts. Only a run whose every test produced a result, built by npm run e2e / e2e:affected from the
// HEAD it is stamped with (ATELIER_E2E_BUILT_HEAD: the build happens before the lock wait, and HEAD may move then),
// with HEAD unchanged until the end and no uncommitted file that reaches the e2e.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import * as map from '../e2e/areas';
import { stampDecision, writeStamp } from './full-green';
// @ts-expect-error: .mjs script without types
import { porcelainPaths, stampBlockers } from '../../scripts/e2e-select.mjs';

interface Git { head(): string | null; dirty(): string[]; stampPath(): string | null }
interface Deps {
  git: Git;
  /** Whether an uncommitted path keeps the run from counting as HEAD's (stampBlockers: CHANGELOG.md doesn't). */
  reaches: (path: string) => boolean;
  /** The HEAD the build came from (ATELIER_E2E_BUILT_HEAD), null when the run wasn't started by our scripts. */
  built: string | null;
  allSpecs: () => string[];
  argv: string[];
  log: (l: string) => void;
  now: () => string;
}

const root = resolve(__dirname, '../..');
const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const realGit: Git = {
  head: () => { try { return run('rev-parse', 'HEAD').trim(); } catch { return null; } },
  dirty: () => porcelainPaths(run('status', '--porcelain', '-z', '--untracked-files=all')) as string[],
  stampPath: () => { try { return resolve(root, run('rev-parse', '--git-common-dir').trim(), 'atelier-e2e-full-green'); } catch { return null; } }
};

const real: Deps = {
  git: realGit,
  reaches: (p) => (stampBlockers([p], map) as string[]).length > 0,
  built: process.env.ATELIER_E2E_BUILT_HEAD || null,
  allSpecs: () => readdirSync(join(root, 'tests/e2e')).filter((n) => n.endsWith('.spec.ts')),
  argv: process.argv,
  log: (l) => console.log(l),
  now: () => new Date().toISOString()
};

export default class FullGreenReporter implements Reporter {
  private ran: string[] = [];
  private tests = 0;
  private results = new Set<string>();
  private head: string | null = null;
  private dirty: string[] = [];

  constructor(private d: Deps = real) {
    // Playwright passes the reporter's options object here; only a full Deps (tests) replaces the real ones.
    if (!d || !('git' in d)) this.d = real;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    const tests = suite.allTests();
    this.tests = tests.length;
    this.ran = [...new Set(tests.map((t) => basename(t.location.file)))];
    this.head = this.d.git.head();
    try { this.dirty = this.d.git.dirty().filter(this.d.reaches); } catch { this.dirty = ['(git status failed)']; }
  }

  onTestEnd(test: TestCase, _result: TestResult): void {
    this.results.add(test.id);
  }

  async onEnd(result: FullResult): Promise<void> {
    const decision = stampDecision({
      status: result.status, ran: this.ran, allSpecs: this.d.allSpecs(), argv: this.d.argv, dirty: this.dirty,
      tests: this.tests, results: this.results.size, built: this.d.built, head: this.head, headAtEnd: this.d.git.head()
    });
    if (!decision.stamp) {
      if (decision.why) this.d.log(`Full e2e run not stamped: ${decision.why}.`);
      return;
    }
    const path = this.d.git.stampPath();
    if (!path || !this.head) return this.d.log('Full e2e run not stamped: not in a git checkout.');
    writeStamp(path, this.head, this.d.now());
    this.d.log(`Full e2e green at ${this.head.slice(0, 7)}: stamped (npm run release reads it).`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
