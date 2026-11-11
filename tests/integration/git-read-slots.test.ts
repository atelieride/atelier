// The git reads Atelier starts for many repositories at once wait for a slot of the shared limiter: All
// Repositories' facts (one block per repository) and Fetch All's remote check (one per repository). The same facts
// read for an action the user is waiting on (commit, push, pull) never queue.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { gitReads, viewFacts } from '../../src/main/git-ops';
import { hasRemote } from '../../src/main/scm-hub';
import { gitReadLimiter } from '../../src/main/git/read-limiter';
import { commit, git } from '../support/git-fixture';

function repo(): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'atl-slots-')));
  git(r, 'init', '-q', '-b', 'main');
  commit(r, 'first', { 'a.ts': '1\n' });
  return r;
}

const release: (() => void)[] = [];
/** Every slot taken by a read that ends when released. */
function fillSlots() {
  for (let i = 0; i < 4; i++) void gitReadLimiter.run('live', () => new Promise<void>((r) => release.push(r)));
}
afterEach(() => { for (const r of release.splice(0)) r(); });

/** Whether the promise settles within `ms`. */
const settles = (p: Promise<unknown>, ms = 400) => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

test('a repository\'s facts for an action (commit, push, pull) never wait behind the slots', async () => {
  const r = repo();
  fillSlots();
  expect(await settles(gitReads.facts(r), 10_000)).toBe(true);
});

test('All Repositories\' blocks read their facts through the slots', async () => {
  const r = repo();
  fillSlots();
  const facts = viewFacts(gitReads.facts)(r);
  expect(await settles(facts)).toBe(false);
  for (const x of release.splice(0)) x();
  expect(await settles(facts, 10_000)).toBe(true);
});

test('Fetch All\'s remote check waits for a free slot', async () => {
  const r = repo();
  fillSlots();
  const has = hasRemote(r);
  expect(await settles(has)).toBe(false);
  for (const x of release.splice(0)) x();
  expect(await has).toBe(false);
});
