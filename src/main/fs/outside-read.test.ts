import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { checkOutsideFile, expandHome } from './outside-read';
import { posixOnly } from '../../../tests/support/platform';

// POSIX: home labels written with `/`, links, a Unix socket. Windows has its own cases (outside-read.win32.test.ts).

let base: string;
let home: string;
let project: string;
let plans: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-oread-')));
  home = join(base, 'home');
  project = join(home, 'repos', 'proj');
  plans = join(home, '.claude', 'plans');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, 'fuzzy-otter.md'), '# plan');
  writeFileSync(join(project, 'src', 'a.ts'), 'a');
});

posixOnly('expandHome', () => {
  test('~/ becomes the home folder, without normalising what follows', () => {
    expect(expandHome('~/.claude/plans/x.md', '/Users/me')).toBe('/Users/me/.claude/plans/x.md');
    // Kept as written: the clean-path check that follows must see the `..`.
    expect(expandHome('~/../other/x.md', '/Users/me')).toBe('/Users/me/../other/x.md');
    expect(expandHome('/tmp/x.md', '/Users/me')).toBe('/tmp/x.md');
    expect(expandHome('~other/x.md', '/Users/me')).toBe('~other/x.md');
  });
});

posixOnly('checkOutsideFile', () => {
  test('a regular file anywhere outside the project: its real path and its home label', async () => {
    const plan = join(plans, 'fuzzy-otter.md');
    expect(await checkOutsideFile(project, plan, home)).toEqual({ path: plan, rel: '~/.claude/plans/fuzzy-otter.md' });
    expect(await checkOutsideFile(project, '~/.claude/plans/fuzzy-otter.md', home)).toEqual({ path: plan, rel: '~/.claude/plans/fuzzy-otter.md' });
    // Outside the home folder: the label is the full path.
    const scratch = join(base, 'scratch.log');
    writeFileSync(scratch, 'log');
    expect(await checkOutsideFile(project, scratch, home)).toEqual({ path: scratch, rel: scratch });
  });

  test('a large file opens too: its tab says it is too large to show', async () => {
    const big = join(base, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 200 * 1024 * 1024);
    expect(await checkOutsideFile(project, big, home)).toEqual({ path: big, rel: big });
  });

  test('a link is followed to its real path; a link to a folder is refused', async () => {
    symlinkSync(join(plans, 'fuzzy-otter.md'), join(base, 'plan-link.md'));
    expect(await checkOutsideFile(project, join(base, 'plan-link.md'), home)).toEqual({ path: join(plans, 'fuzzy-otter.md'), rel: '~/.claude/plans/fuzzy-otter.md' });
    symlinkSync(plans, join(base, 'plans-link'));
    expect(await checkOutsideFile(project, join(base, 'plans-link'), home)).toBeNull();
  });

  test('never a folder, a socket (or FIFO, whose read would block), a missing file', async () => {
    expect(await checkOutsideFile(project, plans, home)).toBeNull();
    expect(await checkOutsideFile(project, join(plans, 'gone.md'), home)).toBeNull();
    const sock = join(base, 's');
    const server = createServer();
    await new Promise<void>((done) => server.listen(sock, done));
    try {
      expect(await checkOutsideFile(project, sock, home)).toBeNull();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test('never inside a .git folder, as written or once links are followed', async () => {
    const repo = join(home, 'repos', 'other');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'config'), '[remote]');
    expect(await checkOutsideFile(project, join(repo, '.git', 'config'), home)).toBeNull();
    symlinkSync(join(repo, '.git', 'config'), join(base, 'config-link'));
    expect(await checkOutsideFile(project, join(base, 'config-link'), home)).toBeNull();
    // A `.git` written in the path that leads elsewhere through a link: refused as written.
    mkdirSync(join(base, 'real-dir'));
    writeFileSync(join(base, 'real-dir', 'x.md'), 'x');
    symlinkSync(join(base, 'real-dir'), join(base, '.git'));
    expect(await checkOutsideFile(project, join(base, '.git', 'x.md'), home)).toBeNull();
  });

  test('a project file, written as one or reached through a link from outside: answered as the project\'s', async () => {
    const a = { path: join(project, 'src', 'a.ts'), rel: 'src/a.ts', project: true };
    expect(await checkOutsideFile(project, join(project, 'src', 'a.ts'), home)).toEqual(a);
    // The project resolver never touches a path written outside the project: the link opens here.
    symlinkSync(join(project, 'src', 'a.ts'), join(base, 'a-link.ts'));
    expect(await checkOutsideFile(project, join(base, 'a-link.ts'), home)).toEqual(a);
    // One it refuses (inside .git) stays refused.
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'config'), 'x');
    symlinkSync(join(project, '.git', 'config'), join(base, 'git-link'));
    expect(await checkOutsideFile(project, join(base, 'git-link'), home)).toBeNull();
  });

  test('only a clean absolute path: never relative, `.` or `..` parts, control characters, over 4096 bytes', async () => {
    expect(await checkOutsideFile(project, '.claude/plans/fuzzy-otter.md', home)).toBeNull();
    expect(await checkOutsideFile(project, `${plans}/../plans/fuzzy-otter.md`, home)).toBeNull();
    expect(await checkOutsideFile(project, `${plans}/./fuzzy-otter.md`, home)).toBeNull();
    expect(await checkOutsideFile(project, '~/.claude/../.claude/plans/fuzzy-otter.md', home)).toBeNull();
    writeFileSync(join(base, 'a\u009bb.md'), 'x');
    expect(await checkOutsideFile(project, join(base, 'a\u009bb.md'), home)).toBeNull();
    expect(await checkOutsideFile(project, '/' + 'x'.repeat(5000), home)).toBeNull();
  });
});
