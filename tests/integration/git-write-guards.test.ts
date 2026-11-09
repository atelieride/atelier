import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isWin } from '../support/platform';
import { validateGitArgs } from '../../src/main/git/exec';
import { type Invocation, build } from '../../src/main/git/write';
const PUSH_MAIN = { to: { remote: 'origin', branch: 'main' } };

// Git writes are safe by construction: the write modules never carry a
// plain force, a short force or config flag, a hard reset, clean or --discard-changes; only write.ts spawns; runGit
// stays read-only.

const DIR = join(__dirname, '..', '..', 'src', 'main', 'git');
/** A new worktree's folder as the machine writes absolute paths. */
const WT = isWin ? 'C:\\p\\w' : '/p/w';
const files = readdirSync(DIR).filter((n) => /^write.*\.ts$/.test(n) && !n.endsWith('.test.ts'));

const BANNED: Array<[string, RegExp]> = [
  ['a plain --force', /--force(?![-a-z])/],
  ['-f as an argument', /['"`]-f['"`]/],
  ['-c as an argument', /['"`]-c['"`]/],
  ['--hard', /--hard\b/],
  ['clean', /['"`]clean['"`]/],
  ['--discard-changes', /--discard-changes/]
];

describe('static guards on src/main/git/write*.ts', () => {
  test('the write modules are there', () => {
    expect(files).toEqual(expect.arrayContaining(['write.ts', 'write-env.ts', 'write-outcome.ts']));
  });

  test.each(BANNED)('no %s', (_what, re) => {
    for (const f of files) expect(re.test(readFileSync(join(DIR, f), 'utf8')), f).toBe(false);
  });

  test('no --mirror or --delete (a push that deletes or mirrors refs)', () => {
    for (const f of files) expect(/['"`]--(?:mirror|delete)\b/.test(readFileSync(join(DIR, f), 'utf8')), f).toBe(false);
  });

  test("-D only inside build.branchDelete (the confirmed Delete Anyway)", () => {
    const src = readFileSync(join(DIR, 'write.ts'), 'utf8');
    const body = /\n {2}branchDelete\([\s\S]*?\n {2}\},?\n/.exec(src)?.[0] ?? '';
    expect(body).toContain("'-D'");
    // Argv literals (quotes), not the comments' `-D`.
    const count = (s: string) => s.split(/['"]-D['"]/).length - 1;
    expect(count(src)).toBe(count(body));
    for (const f of files.filter((n) => n !== 'write.ts')) expect(count(readFileSync(join(DIR, f), 'utf8')), f).toBe(0);
  });

  test('child_process only in write.ts', () => {
    const users = files.filter((f) => /from ['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\)/.test(readFileSync(join(DIR, f), 'utf8')));
    expect(users).toEqual(['write.ts']);
  });

  test('write.ts exports a closed list: the builders, the validators, the runner; no generic "run these args"', async () => {
    const mod = await import('../../src/main/git/write');
    expect(Object.keys(mod).sort()).toEqual(['LOCAL_TIMEOUT_MS', 'NETWORK_TIMEOUT_MS', 'WRITE_MAX_BYTES', 'build', 'isBuilt', 'isServerHook', 'runWrite',
      'killAllWrites', 'stopAllWrites', 'stripAnsi', 'validBranchName', 'validMessage', 'validOid', 'validRel', 'validRemote', 'validStashMessage', 'validWorktreePath'].sort());
    expect(Object.isFrozen(build)).toBe(true);
  });
});

describe('static guards on src/main/git-ops.ts (it never builds an argv itself)', () => {
  const src = readFileSync(join(DIR, '..', 'git-ops.ts'), 'utf8');
  test.each([
    ["'--force'", /['"`]--force['"`]/], ["'-f'", /['"`]-f['"`]/], ["'-D'", /['"`]-D['"`]/], ["'--hard'", /['"`]--hard['"`]/], ["'clean'", /['"`]clean['"`]/],
    ["'--mirror'", /['"`]--mirror['"`]/], ["'--delete'", /['"`]--delete['"`]/], ["'-c'", /['"`]-c['"`]/], ['--discard-changes', /--discard-changes/]
  ])('no %s', (_what, re) => {
    expect(re.test(src)).toBe(false);
  });
});

describe('every builder, on representative valid input, emits no banned argument', () => {
  const OID = 'c'.repeat(40);
  // One entry per builder: a new builder without samples fails the coverage check below.
  const samples: Record<keyof typeof build, Array<() => Invocation>> = {
    stage: [() => build.stage(['a', '-f', '--force', '-c']), () => build.stage('all')],
    unstage: [() => build.unstage(['a'], true), () => build.unstage(['a'], false), () => build.unstage('all', false)],
    commit: [
      () => build.commit({ message: 'm', amend: false, noVerify: false, coAuthor: false }),
      () => build.commit({ message: '--force\n-f\n-c', amend: true, noVerify: true, coAuthor: true })
    ],
    undoCommit: [() => build.undoCommit(OID)],
    push: [() => build.push(PUSH_MAIN), () => build.push({ publish: { remote: 'origin', branch: 'main' } }),
      () => build.push({ lease: { remote: 'origin', branch: 'main', ref: 'refs/heads/main', oid: OID } })],
    pull: [() => build.pull(false), () => build.pull(true)],
    rebaseAbort: [() => build.rebaseAbort()],
    switchTo: [() => build.switchTo({ branch: 'main' }), () => build.switchTo({ track: { remote: 'origin', branch: 'main' } })],
    branchCreate: [() => build.branchCreate({ name: 'x', switch: false }), () => build.branchCreate({ name: 'x', from: OID, switch: true })],
    branchRename: [() => build.branchRename('a', 'b')],
    branchDelete: [() => build.branchDelete('x', false), () => build.branchDelete('x', true)],
    branchRestore: [() => build.branchRestore('x', OID)],
    branchSetUpstream: [() => build.branchSetUpstream('x', 'refs/remotes/origin/x'), () => build.branchSetUpstream('x', 'refs/heads/main')],
    worktreeAdd: [() => build.worktreeAdd({ path: WT, branch: 'x' }), () => build.worktreeAdd({ path: WT, newName: 'y', branch: 'x' })],
    worktreeRemove: [() => build.worktreeRemove(WT)],
    stashPush: [() => build.stashPush({ message: 'm', untracked: true, staged: false }), () => build.stashPush({ message: 'm', untracked: false, staged: true })],
    stashApply: [() => build.stashApply('a'.repeat(40)), () => build.stashApply('b'.repeat(40))],
    stashDrop: [() => build.stashDrop(0)],
    stashStore: [() => build.stashStore(OID, 'm')],
    restore: [() => build.restore(['a'])]
  };

  test('every builder has samples', () => {
    expect(Object.keys(samples).sort()).toEqual(Object.keys(build).sort());
  });

  test('no --force (only --force-with-lease=… with --force-if-includes), -f, -c, --hard, clean, --discard-changes; never an empty argument', () => {
    for (const [name, list] of Object.entries(samples)) {
      for (const make of list) {
        const { args } = make();
        for (const a of args) {
          expect(['--force', '-f', '-c', '--hard', 'clean', '--discard-changes', ''], `${name}: ${a}`).not.toContain(a);
          if (a.startsWith('--force')) expect(/^--force-with-lease=[^:]+:[0-9a-f]{40,64}$|^--force-if-includes$/.test(a), `${name}: ${a}`).toBe(true);
        }
        if (args.some((a) => a.startsWith('--force-with-lease='))) expect(args).toContain('--force-if-includes');
        // Paths and messages are on stdin, never in argv (the stage sample's `-f` and `--force` are file names).
        if (name === 'stage' || name === 'commit') expect(args.some((a) => /^(?:-f|-c|--force)$/.test(a)), name).toBe(false);
        for (const a of args) {
          // A refspec's `+` forces it; combined short flags must not hide a force (`-fd`, `-uf`).
          expect(a.startsWith('+'), `${name}: ${a}`).toBe(false);
          expect(/^-[A-Za-z]*f[A-Za-z]*$/.test(a), `${name}: ${a}`).toBe(false);
          if (a.startsWith('refs/')) expect(a.includes(':+'), `${name}: ${a}`).toBe(false);
        }
      }
    }
  });
});

describe('nasty names never reach a builder\'s argv (fuzz)', () => {
  const OID = 'c'.repeat(40);
  const NASTY = ['+x', '+main', '-x', '--all', 'refs/heads/x', 'refs/remotes/origin/x', 'HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'x/HEAD', '@', '@{-1}', 'x:y',
    ':x', 'x..y', 'x^', 'x^{}', 'x~1', 'x@{u}', 'x@{1}', '*', 'x y', 'x\ty', 'x\0y', '', '.x', 'x.lock', 'x/', '/x', 'a'.repeat(40), 'b'.repeat(64)];
  // Start points (from, a worktree's branch) may be full refnames of refs main read; never anything else here.
  const START_OK = new Set(['refs/heads/x', 'refs/remotes/origin/x', 'a'.repeat(40), 'b'.repeat(64)]);
  // A remote is one GitOps found configured; a hex name is only odd there (it names no object in that position).
  const REMOTE_OK = new Set(['a'.repeat(40), 'b'.repeat(64)]);
  const builders: Array<[string, (n: string) => Invocation, Set<string>?]> = [
    ['switchTo branch', (n) => build.switchTo({ branch: n })],
    ['switchTo track (branch)', (n) => build.switchTo({ track: { remote: 'origin', branch: n } })],
    ['switchTo track (remote)', (n) => build.switchTo({ track: { remote: n, branch: 'main' } }), REMOTE_OK],
    ['branchCreate name', (n) => build.branchCreate({ name: n, switch: true })],
    ['branchCreate from', (n) => build.branchCreate({ name: 'x', from: n, switch: false }), START_OK],
    ['branchRename from', (n) => build.branchRename(n, 'y')],
    ['branchRename to', (n) => build.branchRename('x', n)],
    ['branchDelete', (n) => build.branchDelete(n, true)],
    ['branchRestore', (n) => build.branchRestore(n, OID)],
    ['branchSetUpstream name', (n) => build.branchSetUpstream(n, 'refs/remotes/origin/x'), new Set()],
    ['branchSetUpstream upstream', (n) => build.branchSetUpstream('x', n), new Set(['refs/heads/x', 'refs/remotes/origin/x'])],
    ['worktreeAdd newName', (n) => build.worktreeAdd({ path: WT, newName: n })],
    ['worktreeAdd branch', (n) => build.worktreeAdd({ path: WT, branch: n })],
    ['worktreeAdd start', (n) => build.worktreeAdd({ path: WT, newName: 'w', branch: n }), START_OK],
    ['publish branch', (n) => build.push({ publish: { remote: 'origin', branch: n } })],
    ['publish remote', (n) => build.push({ publish: { remote: n, branch: 'main' } }), REMOTE_OK],
    ['lease branch', (n) => build.push({ lease: { remote: 'origin', branch: n, ref: 'refs/heads/main', oid: OID } })],
    ['lease ref', (n) => build.push({ lease: { remote: 'origin', branch: 'main', ref: n, oid: OID } }), new Set(['refs/heads/x'])],
    ['lease remote', (n) => build.push({ lease: { remote: n, branch: 'main', ref: 'refs/heads/main', oid: OID } }), REMOTE_OK]
  ];

  test.each(builders)('%s: refused, unless it is a full refname the builder takes', (_what, make, ok = new Set<string>()) => {
    for (const n of NASTY) {
      if (ok.has(n)) {
        const { args } = make(n);
        expect(args.some((a) => a.startsWith('+') || a.startsWith('-' + n)), n).toBe(false);
      } else {
        expect(() => make(n), JSON.stringify(n)).toThrow();
      }
    }
  });
});

describe('quitting: the wiring in src/main/index.ts', () => {
  const src = readFileSync(join(DIR, '..', 'index.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  test('Quit Anyway goes through quitAnyway (cleanups awaited before app.quit), never a bare quit after the cancel', () => {
    const dialog = /gitQuitAnyway = true;([\s\S]*?)\n\s*\}\);/.exec(src)?.[1] ?? '';
    expect(dialog).toContain('quitAnyway({ ops: gitOps, stopWrites: stopAllWrites, quit: () => app.quit() })');
    expect(dialog.replace('quit: () => app.quit()', '')).not.toContain('app.quit()');
  });
  test('will-quit kills whatever still runs, at once', () => {
    expect(src).toMatch(/app\.on\('will-quit', \(\) => \{ gitOps\.cancelAll\(\); killAllWrites\(\);/);
  });
});

describe('runGit stays read-only', () => {
  test.each([
    [['commit', '-m', 'x']], [['add', '.']], [['push']], [['stash', 'push']], [['reset', '--soft', 'HEAD~1']], [['switch', 'main']],
    [['checkout', 'main']], [['branch', 'x']], [['restore', 'a']], [['rm', '--cached', 'a']], [['pull']], [['rebase', '--abort']],
    [['worktree', 'add', '/p/w', 'x']], [['fetch']], [['merge', 'x']], [['clean', '-n']], [['tag', 'v1']]
  ])('refuses %j', (args) => {
    expect(() => validateGitArgs(args)).toThrow();
  });
});
