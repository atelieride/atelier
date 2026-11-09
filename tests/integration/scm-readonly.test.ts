// Source Control is read-only: every reader leaves the repository byte-identical — no
// index refresh, no ref, log or lock written — and never runs a program the repo configures (gpg for signatures).
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect } from 'vitest';
import { posixTest } from '../support/platform';
import { aheadBehind, locateCommit, readBlob, readCommit, readLog, readRefs, readStashes, readWorktrees, resolveCommit } from '../../src/main/git/history';
import { fixtureGitEnv, git, historyRepo } from '../support/git-fixture';

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p.slice(dir.length)] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.mtimeMs}:${st.ino}`;
    }
  };
  walk(dir);
  return out;
}

// POSIX: the fake gpg, textconv driver and diff tool are sh scripts git runs (and rm cleans up).
posixTest('every reader leaves .git and the working tree untouched, and never runs gpg', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-ro-')));
  const ids = historyRepo(repo);
  const marker = join(repo, '..', `${repo.split('/').at(-1)}-GPG-RAN`);
  // A "gpg" that signs (so a signed commit exists) and leaves a marker whenever it is asked to verify.
  const gpg = join(repo, '..', `${basename(repo)}-gpg.sh`);
  writeFileSync(gpg, `#!/bin/sh\ncase "$*" in *--verify*) touch '${marker}'; exit 0;; esac\necho '[GNUPG:] SIG_CREATED S 1 8 00 1700000000 ABCD' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n`);
  chmodSync(gpg, 0o755);
  git(repo, 'config', 'gpg.program', gpg);
  writeFileSync(join(repo, 'signed.txt'), 's\n');
  git(repo, 'add', 'signed.txt');
  execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'user.signingkey=ABCD', 'commit', '-q', '-S', '-m', 'signed'], { cwd: repo, env: fixtureGitEnv });
  const signed = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'config', 'log.showSignature', 'true');
  // Sanity: plain git log with this config does run the "gpg" (so the test can catch a reader that would).
  git(repo, 'log', '-1', '--format=%H');
  expect(existsSync(marker)).toBe(true);
  execFileSync('rm', ['-f', marker]);
  // A textconv driver and an external diff that would leave a marker too.
  const conv = join(repo, '..', `${repo.split('/').at(-1)}-CONV-RAN`);
  const tool = join(repo, '..', `${repo.split('/').at(-1)}-tool.sh`);
  writeFileSync(tool, `#!/bin/sh\ntouch '${conv}'\ncat "$1" 2>/dev/null\n`);
  chmodSync(tool, 0o755);
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '* diff=mark\n');
  git(repo, 'config', 'diff.mark.textconv', tool);
  git(repo, 'config', 'diff.external', tool);
  git(repo, 'diff', ids.c1, ids.c2);
  expect(existsSync(conv)).toBe(true);
  execFileSync('rm', ['-f', conv, marker]);
  // A stash, a linked worktree, and a file whose mtime changed with the same content (a status would refresh the index).
  writeFileSync(join(repo, 'a.ts'), 'stashed\n');
  git(repo, 'stash', 'push', '-q', '-m', 'keep');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', join(repo, '.worktrees', 'side'));
  const later = new Date(Date.now() + 5000);
  utimesSync(join(repo, 'a.ts'), later, later);

  const before = snapshot(repo);
  const refs = await readRefs(repo);
  const all = { kind: 'refs', refs: 'all', firstParent: false } as const;
  await readLog(repo, all, refs, { skip: 0, count: 400 });
  await readLog(repo, all, refs, { skip: 0, count: 400, filter: 'feat @Ada path:dir' });
  await readLog(repo, { kind: 'compare', base: 'refs/heads/main', head: 'refs/heads/feat/x' }, refs, { skip: 0, count: 400 });
  await locateCommit(repo, all, refs, ids.c2);
  await resolveCommit(repo, ids.c2.slice(0, 7));
  await readCommit(repo, signed, null, refs.emptyTree);
  await readCommit(repo, ids.merge, ids.f2, refs.emptyTree);
  await readCommit(repo, ids.c1, null, refs.emptyTree);
  await readBlob(repo, ids.c3, 'nuovo è.ts');
  await readBlob(repo, ids.c3, 'logo.png');
  await readWorktrees(repo);
  await readStashes(repo);
  await aheadBehind(repo, 'refs/heads/main', 'refs/heads/feat/x');
  expect(snapshot(repo)).toEqual(before);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(conv)).toBe(false);
});
