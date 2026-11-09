// Which e2e a change runs. Pure logic on a small map; the real map's own guards are in
// e2e-areas.test.ts.
import { expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { appCommits, classify, countTests, estimate, fullRunGate, fullRunReminder, importGraph, parseLog, pickStamp, pkgChange, porcelainPaths, reminderStamp, removedStrings, report, select, stampBlockers } from '../../scripts/e2e-select.mjs';

const map = {
  SMOKE: ['essentials.spec.ts', 'window.spec.ts'],
  SPECS: {
    'essentials.spec.ts': ['workspace'], 'window.spec.ts': ['workspace'], 'find-replace.spec.ts': ['editor'],
    'language-mode.spec.ts': ['editor'], 'redis.spec.ts': ['services'], 'docker.spec.ts': ['services'],
    'review.spec.ts': ['review', 'editor'], 'split.spec.ts': ['workspace'], 'source-control.spec.ts': ['scm'],
    'whats-new.spec.ts': ['updates']
  },
  SOURCES: {
    'src/renderer/editor/': ['editor'], 'src/renderer/editor/find/': ['editor', 'review'], 'src/main/redis/': ['services'],
    'src/shared/redis': ['services'], 'src/renderer/components/Palette.tsx': ['workspace'],
    'src/renderer/components/ReviewView.tsx': ['review'], 'src/renderer/scm/RevFileView.tsx': ['scm'],
    'src/renderer/editor/highlighter.ts': ['editor'], 'CHANGELOG.md': ['updates']
  },
  WIRING: ['src/main/index.ts', 'src/main/ipc-schemas.ts', 'src/renderer/store.ts', 'src/preload/', 'src/renderer/i18n/', 'src/renderer/App.tsx', 'tests/e2e/env.ts'],
  FOUNDATIONS: ['src/daemon/', 'native/', 'package-lock.json', 'src/renderer/main.tsx'],
  CSS: ['src/renderer/theme.css', 'src/renderer/layout.css'],
  CSS_AREAS: ['workspace'],
  PKG_AREAS: ['updates'],
  HUBS: ['src/renderer/components/Palette.tsx'],
  STRICT_WIRING: ['src/renderer/i18n/'],
  IGNORED: ['docs/', 'site/', 'src/demo/', '.github/', 'tests/integration/', 'electron-builder.yml']
};

const specSources: Record<string, string> = {
  'tests/e2e/essentials.spec.ts': "import { e2eEnv } from './env';",
  'tests/e2e/window.spec.ts': "import { e2eEnv } from './env';",
  'tests/e2e/find-replace.spec.ts': "e2eEnv(); const bin = 'fake-claude-edit.pl';",
  'tests/e2e/language-mode.spec.ts': '',
  'tests/e2e/redis.spec.ts': "import { fakeRedis } from '../support/fake-redis';",
  'tests/e2e/docker.spec.ts': "import { dockerFixture } from './docker-fixture';",
  'tests/e2e/docker-fixture.ts': "import { fakeDocker } from '../support/fake-docker';",
  'tests/support/fake-redis.ts': "import { keys } from './redis-fixtures';",
  'tests/support/redis-fixtures.ts': '',
  'tests/support/fake-docker.ts': '',
  'tests/support/orphan-helper.ts': '',
  'tests/support/macho.ts': '',
  'tests/integration/release-scripts.test.ts': "import { macho } from '../support/macho';",
  'tests/support/site-only.ts': '',
  'tests/e2e/site-shots.manual.ts': "import { x } from '../support/site-only';",
  'tests/e2e/env.ts': "// The engine's fake (tests/support/fake-redis.ts) is passed by each test.\n  /* fake-docker too */\nconst claude = resolve('tests/e2e/fake-claude.pl');",
  'tests/e2e/fake-claude.pl': '',
  'tests/e2e/fake-claude-edit.pl': '',
  'tests/fixtures/claude-image/normal-120.txt': '',
  'src/renderer/terminal/links.test.ts': "const dir = join(__dirname, '../../../tests/fixtures/claude-image');",
  'tests/fixtures/pane-dumps/wide.txt': '',
  'tests/e2e/split.spec.ts': "const dumps = resolve('tests/fixtures/pane-dumps');",
  'tests/fixtures/fake-jira.d.mts': '',
  'tests/fixtures/fake-jira.mjs': '',
  'tests/e2e/review.spec.ts': "const f = 'fake-claude-review.pl'; import { fakeJira } from '../fixtures/fake-jira.mjs';"
};

const run = (changed: string[], extra: Record<string, unknown> = {}) => select({ changed, pkgChange: 'scripts', sources: specSources, map, ...extra });
const files = (r: { specs: string[] }) => [...r.specs].sort();

test('a path in an area runs that area\'s specs plus smoke, with the reason', () => {
  const r = run(['src/renderer/editor/cmTheme.ts']);
  expect(r.mode).toBe('some');
  expect(files(r)).toEqual(['essentials.spec.ts', 'find-replace.spec.ts', 'language-mode.spec.ts', 'review.spec.ts', 'window.spec.ts']);
  expect(r.reasons).toContainEqual({ what: 'editor', from: 'src/renderer/editor/cmTheme.ts' });
  expect(classify('src/renderer/editor/highlighter.ts', map)).toEqual({ kind: 'areas', areas: ['editor'] });
});

test('the longest prefix wins', () => {
  expect(classify('src/renderer/editor/find/find-ext.ts', map)).toEqual({ kind: 'areas', areas: ['editor', 'review'] });
  expect(classify('src/renderer/editor/cmTheme.ts', map)).toEqual({ kind: 'areas', areas: ['editor'] });
  expect(classify('src/shared/redis-monitor.ts', map)).toEqual({ kind: 'areas', areas: ['services'] });
});

test('main and shared files map by area like the renderer', () => {
  const r = run(['src/main/redis/hub.ts']);
  expect(files(r)).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
});

test('a foundation runs everything, saying which path forced it', () => {
  for (const p of ['src/daemon/server.ts', 'native/atelier-pty-host.c', 'package-lock.json', 'src/renderer/main.tsx']) {
    const r = run(['src/renderer/editor/cmTheme.ts', p]);
    expect(r.mode).toBe('all');
    expect(r.reasons).toContainEqual({ what: 'all', from: p, why: 'foundation' });
  }
});

test('wiring adds smoke only; the areas come from the rest of the change', () => {
  const r = run(['src/main/ipc-schemas.ts', 'src/main/index.ts', 'src/preload/index.ts', 'src/main/redis/hub.ts']);
  expect(r.mode).toBe('some');
  expect(files(r)).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
  expect(r.reasons).toContainEqual({ what: 'smoke', from: 'src/main/ipc-schemas.ts', why: 'wiring' });
});

// Features add a fake or a test variable to env.ts; that alone no longer runs everything.
test('env.ts is wiring: with a feature, smoke plus its areas; alone, everything', () => {
  expect(files(run(['tests/e2e/env.ts', 'src/main/redis/hub.ts']))).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
  expect(run(['tests/e2e/env.ts']).mode).toBe('all');
});

test('wiring alone runs everything', () => {
  const r = run(['src/renderer/store.ts', 'src/main/ipc-schemas.ts', 'docs/x.md']);
  expect(r.mode).toBe('all');
  expect(r.reasons).toContainEqual({ what: 'all', from: 'src/renderer/store.ts', why: 'wiring only' });
});

test('package.json: scripts alone run smoke, the version or app fields add PKG_AREAS, a dependency change runs everything', () => {
  expect(files(run(['package.json']))).toEqual(['essentials.spec.ts', 'window.spec.ts']);
  expect(files(run(['package.json'], { pkgChange: 'app' }))).toEqual(['essentials.spec.ts', 'whats-new.spec.ts', 'window.spec.ts']);
  const r = run(['package.json'], { pkgChange: 'deps' });
  expect(r.mode).toBe('all');
  expect(r.reasons).toContainEqual({ what: 'all', from: 'package.json', why: 'dependencies' });
});

test('an unmapped path in src, tests or the root runs everything (fail-safe)', () => {
  for (const p of ['src/renderer/new-thing/x.ts', 'tests/new-dir/y.ts', 'some-new-config.json']) {
    const r = run([p]);
    expect(r.mode).toBe('all');
    expect(r.reasons).toContainEqual({ what: 'all', from: p, why: 'unmapped' });
  }
});

test('a changed spec runs itself (plus smoke); a deleted one runs nothing', () => {
  expect(files(run(['tests/e2e/split.spec.ts']))).toEqual(['essentials.spec.ts', 'split.spec.ts', 'window.spec.ts']);
  expect(run(['tests/e2e/gone.spec.ts']).mode).toBe('none');
});

test('a fixture runs the specs that name it, through helpers too', () => {
  expect(files(run(['tests/e2e/fake-claude-edit.pl']))).toEqual(['essentials.spec.ts', 'find-replace.spec.ts', 'window.spec.ts']);
  // redis-fixtures ← fake-redis ← redis.spec
  expect(files(run(['tests/support/redis-fixtures.ts']))).toEqual(['essentials.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
  // fake-docker ← docker-fixture ← docker.spec
  expect(files(run(['tests/support/fake-docker.ts']))).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'window.spec.ts']);
});

test('a fixture env.ts names, or that nothing names, runs everything', () => {
  expect(run(['tests/e2e/fake-claude.pl']).reasons).toContainEqual({ what: 'all', from: 'tests/e2e/fake-claude.pl', why: 'used by env.ts' });
  expect(run(['tests/support/orphan-helper.ts']).reasons).toContainEqual({ what: 'all', from: 'tests/support/orphan-helper.ts', why: 'used by no spec' });
});

// A fixture loaded through its folder, or typed by a .d.mts, is not "used by no spec".
test('a fixture is also found through its folder, and a declaration file through its module', () => {
  expect(run(['tests/fixtures/claude-image/normal-120.txt']).mode).toBe('none'); // only a unit test loads the folder
  expect(files(run(['tests/fixtures/pane-dumps/wide.txt']))).toEqual(['essentials.spec.ts', 'split.spec.ts', 'window.spec.ts']);
  expect(files(run(['tests/fixtures/fake-jira.d.mts']))).toEqual(['essentials.spec.ts', 'review.spec.ts', 'window.spec.ts']);
});

test('a name in a comment is not a use (env.ts mentions fakes it does not load)', () => {
  expect(files(run(['tests/support/fake-redis.ts']))).toEqual(['essentials.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
  expect(files(run(['tests/support/fake-docker.ts']))).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'window.spec.ts']);
});

test('a helper only unit tests or manual checks name runs nothing', () => {
  expect(run(['tests/support/macho.ts']).mode).toBe('none');
  expect(run(['tests/support/site-only.ts']).mode).toBe('none');
});

test('CSS adds no area by itself: CSS only runs smoke + workspace, with other files only their areas', () => {
  expect(files(run(['src/renderer/layout.css']))).toEqual(['essentials.spec.ts', 'split.spec.ts', 'window.spec.ts']);
  expect(files(run(['src/renderer/layout.css', 'src/main/redis/hub.ts']))).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
});

test('docs, site, the demo, unit tests and manual specs run nothing, and say so', () => {
  const r = run(['docs/a.md', 'NOTES.md', 'site/src/x.astro', 'src/demo/engine/clock.ts', 'src/main/redis/hub.test.ts',
    'tests/integration/x.test.ts', 'tests/e2e/site-shots.manual.ts', 'electron-builder.yml', '.github/workflows/ci.yml']);
  expect(r.mode).toBe('none');
  expect(r.specs).toEqual([]);
});

test('a Markdown file inside src or tests is not ignored for being Markdown', () => {
  expect(classify('src/renderer/new-thing/README.md', map).kind).toBe('unmapped');
});

test('pkgChange: deps (what gets installed), app (version, name, main, build), else scripts', () => {
  const base = { name: 'a', version: '1.0.0', main: 'out/main/index.js', scripts: { a: 'x' }, dependencies: { x: '1' }, devDependencies: { y: '2' } };
  expect(pkgChange(base, { ...base, scripts: { a: 'y', b: 'z' } })).toBe('scripts');
  expect(pkgChange(base, { ...base, version: '1.1.0' })).toBe('app');
  expect(pkgChange(base, { ...base, main: 'x.js' })).toBe('app');
  expect(pkgChange(base, { ...base, dependencies: { x: '2' } })).toBe('deps');
  expect(pkgChange(base, { ...base, devDependencies: { y: '2', z: '1' } })).toBe('deps');
  expect(pkgChange(base, { ...base, overrides: { q: '1' } })).toBe('deps');
  expect(pkgChange(null, base)).toBe('deps');
});

// A file used by another area's views runs that area's specs too (its importers' areas, transitively).
const graphSources: Record<string, string> = {
  'src/renderer/editor/highlighter.ts': "export const h = 1;",
  'src/renderer/components/ReviewView.tsx': "import { h } from '../editor/highlighter';\nimport x from '@shared/languages';",
  'src/renderer/scm/RevFileView.tsx': "import { h } from \"../editor/highlighter\";",
  'src/renderer/scm/CommitDiff.tsx': "import { RevFileView } from './RevFileView';",
  'src/renderer/App.tsx': "import { ReviewView } from './components/ReviewView';",
  'src/renderer/components/Palette.tsx': "import { h } from '../editor/highlighter';\nimport('../scm/lazy');",
  'src/renderer/scm/lazy.ts': '',
  'src/shared/languages.ts': '',
  'src/renderer/components/WhatsNew.tsx': "import log from '../../../CHANGELOG.md?raw';"
};

test('importGraph: relative and @shared imports, dynamic imports, ?raw, extension and index resolution', () => {
  const g = importGraph(graphSources);
  expect([...g.get('src/renderer/editor/highlighter.ts')!].sort()).toEqual(['src/renderer/components/Palette.tsx', 'src/renderer/components/ReviewView.tsx', 'src/renderer/scm/RevFileView.tsx']);
  expect([...g.get('src/shared/languages.ts')!]).toEqual(['src/renderer/components/ReviewView.tsx']);
  expect([...g.get('src/renderer/scm/lazy.ts')!]).toEqual(['src/renderer/components/Palette.tsx']);
  expect([...g.get('CHANGELOG.md')!]).toEqual(['src/renderer/components/WhatsNew.tsx']);
});

test('a source file runs the areas of the files that import it directly; wiring, foundations and hubs add nothing', () => {
  const graph = importGraph(graphSources);
  const r = run(['src/renderer/editor/highlighter.ts'], { graph });
  // editor (itself) + review (ReviewView) + scm (RevFileView); App.tsx (wiring) and Palette.tsx (hub) add nothing;
  // CommitDiff (imports RevFileView) is two steps away: the component tree is too connected to walk transitively
  expect(files(r)).toEqual(['essentials.spec.ts', 'find-replace.spec.ts', 'language-mode.spec.ts', 'review.spec.ts', 'source-control.spec.ts', 'window.spec.ts']);
  expect(r.reasons).toContainEqual({ what: 'scm', from: 'src/renderer/editor/highlighter.ts', why: 'via src/renderer/scm/RevFileView.tsx' });
});

// WhatsNew imports CHANGELOG.md; whats-new.spec reads it.
test('CHANGELOG.md is not ignored as Markdown: it ships in the app', () => {
  expect(files(run(['CHANGELOG.md']))).toEqual(['essentials.spec.ts', 'whats-new.spec.ts', 'window.spec.ts']);
  expect(run(['NOTES.md', 'docs/x.md']).mode).toBe('none');
});

// A changed (not only added) string breaks getByRole/getByText lookups in any area: the specs that use
// the old text run too.
test('strict wiring (i18n): the specs that mention a removed or changed string run; only added lines stay smoke', () => {
  const sources = { ...specSources, 'tests/e2e/split.spec.ts': "await page.getByRole('button', { name: 'Split Right' }).click();" };
  const added = run(['src/renderer/i18n/en.ts', 'src/main/redis/hub.ts'], { sources });
  expect(files(added)).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
  const edited = run(['src/renderer/i18n/en.ts', 'src/main/redis/hub.ts'], { sources, removed: { 'src/renderer/i18n/en.ts': ['split right', 'Nowhere in any spec'] } });
  expect(files(edited)).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'redis.spec.ts', 'split.spec.ts', 'window.spec.ts']);
  expect(edited.reasons).toContainEqual({ what: 'split.spec.ts', from: 'src/renderer/i18n/en.ts', why: 'uses "split right"' });
  // alone, edited strings still count as wiring only
  expect(run(['src/renderer/i18n/en.ts'], { sources, removed: { 'src/renderer/i18n/en.ts': ['Nowhere'] } }).mode).toBe('all');
});

// Specs match part of a string ("Change Language Mode" for "Change Language Mode…").
test('strict wiring: a spec string that is part of a removed string runs that spec too; code identifiers do not count', () => {
  const sources = {
    ...specSources,
    'tests/e2e/language-mode.spec.ts': "await page.getByText('Change Language Mode').click(); const close = tabs;",
    'tests/e2e/split.spec.ts': "await page.getByRole('button', { name: 'Split' });"
  };
  const r = run(['src/renderer/i18n/en.ts', 'src/main/redis/hub.ts'], { sources, removed: { 'src/renderer/i18n/en.ts': ['Change Language Mode…', 'Close tabs'] } });
  expect(files(r)).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'language-mode.spec.ts', 'redis.spec.ts', 'window.spec.ts']);
  expect(r.reasons).toContainEqual({ what: 'language-mode.spec.ts', from: 'src/renderer/i18n/en.ts', why: 'uses "Change Language Mode…"' });
});

// String hits don't make other wiring count as more than wiring.
test('wiring plus i18n with string hits and nothing else still runs everything', () => {
  const sources = { ...specSources, 'tests/e2e/split.spec.ts': "getByRole('button', { name: 'Split Right' })" };
  const r = run(['src/renderer/store.ts', 'src/renderer/i18n/en.ts'], { sources, removed: { 'src/renderer/i18n/en.ts': ['Split Right'] } });
  expect(r.mode).toBe('all');
});

test('removedStrings: the text of string literals on removed lines, interpolations split, short pieces dropped', () => {
  const diff = [
    '--- a/src/renderer/i18n/en.ts', '+++ b/src/renderer/i18n/en.ts', '@@ -1,3 +1,3 @@',
    "-  split: 'Split Right',", "+  split: 'Split to the Right',", '-  n: (k: number) => `${k} results found`,', "-  ok: 'OK',", '-  quote: "Don\'t save"'
  ].join('\n');
  expect(removedStrings(diff)).toEqual(['Split Right', ' results found', "Don't save"]);
});

// Only comments that start a line are dropped; a glob in a string stays code.
test('a block comment marker inside a string does not eat the code after it', () => {
  const r = run(['tests/support/fake-docker.ts'], { sources: { ...specSources, 'tests/e2e/docker.spec.ts': "const g = '**/*.ts'; import { d } from './docker-fixture'; const h = '*/';" } });
  expect(files(r)).toEqual(['docker.spec.ts', 'essentials.spec.ts', 'window.spec.ts']);
});

test('pickStamp: the newest green run HEAD descends from; none of them → the newest, not usable; none at all → null', () => {
  const runs = [{ sha: 'bbbb', at: '2' }, { sha: 'aaaa', at: '1' }];
  expect(pickStamp(runs, (sha: string) => sha === 'aaaa')).toEqual({ stamp: runs[1], isAncestor: true });
  expect(pickStamp(runs, () => true)).toEqual({ stamp: runs[0], isAncestor: true });
  expect(pickStamp(runs, () => false)).toEqual({ stamp: runs[0], isAncestor: false });
  expect(pickStamp([], () => true)).toEqual({ stamp: null, isAncestor: false });
});

test('stampBlockers: uncommitted files that reach the e2e, CHANGELOG.md aside (the release edits it)', () => {
  expect(stampBlockers(['CHANGELOG.md', 'NOTES.md', 'src/main/redis/hub.ts', 'docs/a.md'], map)).toEqual(['src/main/redis/hub.ts']);
});

test('estimate: about 1.7 s a test with two workers, in minutes', () => {
  expect(estimate(240)).toBe('~7 min');
  expect(estimate(10)).toBe('~1 min');
});

// A stamp on this branch but not on main.
test('the reminder for a stamp on this branch only', () => {
  expect(fullRunReminder({ stamp: { sha: 'abc1234def', at: 'x' }, usable: true, onMain: false, appCommits: 0 })).toBe('Last green full run: abc1234, on this branch (not on main yet).');
});

// The whole suite is main's job, once per 10 app changes, before a stage-update; not each session's.
test('the full-run reminder: 10+ app changes on main since the stamp, or no usable stamp, asks for npm run e2e on main before the next stage-update', () => {
  expect(fullRunReminder({ stamp: null, appCommits: 0 })).toMatch(/No green full e2e run on record.*npm run e2e.*on main.*stage-update/);
  expect(fullRunReminder({ stamp: { sha: 'abc1234def', at: '2026-10-16T10:00:00Z' }, usable: false, appCommits: 0 })).toMatch(/not in this history.*npm run e2e.*on main/);
  expect(fullRunReminder({ stamp: { sha: 'abc1234def', at: '2026-10-16T10:00:00Z' }, usable: true, appCommits: 9 })).toMatch(/^Last green full run: abc1234, 9 app changes on main since\.$/);
  expect(fullRunReminder({ stamp: { sha: 'abc1234def', at: '2026-10-16T10:00:00Z' }, usable: true, appCommits: 10 })).toMatch(/10 app changes on main since.*npm run e2e.*on main.*stage-update/);
  expect(fullRunReminder({ stamp: null, appCommits: 0 })).toMatch(/not from a worktree/);
});

test('porcelainPaths reads git status -z: modified, staged, untracked, and both sides of a rename', () => {
  const z = ' M src/a.ts\0A  src/b.ts\0?? tests/e2e/new.spec.ts\0R  src/new-name.ts\0src/old-name.ts\0 D src/gone.ts\0';
  expect(porcelainPaths(z)).toEqual(['src/a.ts', 'src/b.ts', 'tests/e2e/new.spec.ts', 'src/new-name.ts', 'src/old-name.ts', 'src/gone.ts']);
  expect(porcelainPaths('')).toEqual([]);
});

test('countTests counts test(), test.skip/fixme/fail() and test.describe-less calls, not helpers', () => {
  const src = "test('a', async () => {});\n  test.skip('b', () => {});\ntest.describe('g', () => {\n  test('c', () => {});\n});\nconst x = mytest('no');\ntest.beforeEach(() => {});\n";
  expect(countTests(src)).toBe(3);
});

// In "all" mode a new spec not in SPECS counts in the tests and the estimate too.
test('report counts every spec on disk in the whole-suite line', () => {
  const lines = report({ result: { mode: 'all', specs: ['a.spec.ts'], reasons: [] }, base: 'main (1)', changed: 1, tests: { 'a.spec.ts': 2, 'new.spec.ts': 3 }, rendererChanged: false, reminder: null });
  expect(lines.at(-1)).toBe('Runs the whole suite: 2 spec files, 5 tests, ~1 min.');
});

test('report: the areas with their first paths, the counts and the estimate, the demo hint, the reminder', () => {
  const lines = report({
    result: { mode: 'some', specs: ['a.spec.ts', 'b.spec.ts'], reasons: [
      { what: 'editor', from: 'src/renderer/editor/a.ts' }, { what: 'editor', from: 'src/renderer/editor/b.ts' },
      { what: 'editor', from: 'src/renderer/editor/c.ts' }, { what: 'editor', from: 'src/renderer/editor/d.ts' },
      { what: 'smoke', from: 'src/main/ipc-schemas.ts', why: 'wiring' }] },
    base: 'main (1a2b3c4)', changed: 6, tests: { 'a.spec.ts': 10, 'b.spec.ts': 2, 'c.spec.ts': 5 }, rendererChanged: true,
    reminder: 'Last green full run: abc1234, 1 app change on main since.'
  });
  expect(lines).toEqual([
    'e2e:affected: 6 changed files since main (1a2b3c4).',
    '  editor ← src/renderer/editor/a.ts, src/renderer/editor/b.ts, src/renderer/editor/c.ts +1 more',
    '  smoke ← src/main/ipc-schemas.ts (wiring)',
    'Runs 2 of 3 spec files, 12 tests, ~1 min.',
    'The renderer changed: the live demo has its own checks (npm --prefix site run e2e:browsers).',
    'Last green full run: abc1234, 1 app change on main since.'
  ]);
  const all = report({ result: { mode: 'all', specs: ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], reasons: [{ what: 'all', from: 'src/daemon/x.ts', why: 'foundation' }] },
    base: 'origin/main (9f9f9f9)', changed: 1, tests: { 'a.spec.ts': 10, 'b.spec.ts': 2, 'c.spec.ts': 5 }, rendererChanged: false, reminder: null });
  expect(all).toEqual(['e2e:affected: 1 changed file since origin/main (9f9f9f9).', '  all ← src/daemon/x.ts (foundation)', 'Runs the whole suite: 3 spec files, 17 tests, ~1 min.']);
  const none = report({ result: { mode: 'none', specs: [], reasons: [] }, base: 'main (1)', changed: 2, tests: {}, rendererChanged: false, reminder: null });
  expect(none).toEqual(['e2e:affected: 2 changed files since main (1).', 'Nothing here reaches the app\'s e2e (docs, site, demo, unit tests, packaging).']);
});

test('the release gate: a stamp that covers HEAD passes; none, foreign or with app changes since asks', () => {
  const stamp = { sha: 'abc1234def', at: '2026-10-16T10:00:00Z' };
  const docs = { subject: 'docs: notes', files: ['NOTES.md', 'docs/x.md'] };
  const release = { subject: 'release: v0.2.0-beta.15', files: ['package.json', 'package-lock.json', 'CHANGELOG.md'] };
  const app = { subject: 'feat: x', files: ['src/renderer/editor/a.ts', 'src/main/redis/hub.ts', 'docs/y.md'] };
  expect(fullRunGate({ stamp, isAncestor: true, commits: [docs, release], map })).toEqual({ ok: true, why: 'The green full e2e run at abc1234 covers HEAD.' });
  expect(fullRunGate({ stamp: null, isAncestor: false, commits: [], map })).toEqual({ ok: false, why: 'No green full e2e run on record.' });
  expect(fullRunGate({ stamp, isAncestor: false, commits: [], map })).toEqual({ ok: false, why: 'The last green full e2e run (abc1234) is not in this history.' });
  expect(fullRunGate({ stamp, isAncestor: true, commits: [docs, app], map })).toEqual({
    ok: false, why: 'App files changed since the last green full e2e run (abc1234): src/main/redis/hub.ts, src/renderer/editor/a.ts.'
  });
});

test('appCommits: commits since the stamp that reach the e2e; release commits (version bumps) never count', () => {
  // A "release: v…" commit that carries more than the version bump counts.
  expect(appCommits([{ subject: 'release: v1.0.0', files: ['package.json', 'src/main/redis/hub.ts'] }], map)).toBe(1);
  const commits = [
    { subject: 'release: v0.2.0-beta.15', files: ['package.json', 'package-lock.json', 'CHANGELOG.md'] },
    { subject: 'docs', files: ['docs/a.md'] },
    { subject: 'feat', files: ['src/main/redis/hub.ts'] },
    { subject: 'fix', files: ['src/renderer/editor/a.ts', 'docs/b.md'] }
  ];
  expect(appCommits(commits, map)).toBe(2);
});

test('parseLog reads git log --format=%x00%s --name-only', () => {
  const log = '\0release: v1\n\npackage.json\nCHANGELOG.md\n\0feat: x\n\nsrc/a.ts\n';
  expect(parseLog(log)).toEqual([{ subject: 'release: v1', files: ['package.json', 'CHANGELOG.md'] }, { subject: 'feat: x', files: ['src/a.ts'] }]);
  expect(parseLog('')).toEqual([]);
});

// \u escapes are read as the character, in the diff and in the specs alike.
test('removedStrings and spec strings read \\u escapes as characters', () => {
  expect(removedStrings("-  more: 'Show more\\u2026',")).toEqual(['Show more…']);
  const sources = { ...specSources, 'tests/e2e/split.spec.ts': "getByText('Show more\\u2026')" };
  const r = run(['src/renderer/i18n/en.ts', 'src/main/redis/hub.ts'], { sources, removed: { 'src/renderer/i18n/en.ts': ['Show more…'] } });
  expect(r.specs).toContain('split.spec.ts');
});

// A branch made from an older main: the newer green run on main still counts for the reminder.
test('reminderStamp: the newest run main descends from; else one only this branch has; else the newest, unusable', () => {
  const runs = [{ sha: 'cccc', at: '3' }, { sha: 'bbbb', at: '2' }, { sha: 'aaaa', at: '1' }];
  expect(reminderStamp(runs, (s: string) => s === 'cccc', () => false)).toEqual({ stamp: runs[0], usable: true, onMain: true });
  expect(reminderStamp(runs, () => false, (s: string) => s === 'bbbb')).toEqual({ stamp: runs[1], usable: true, onMain: false });
  expect(reminderStamp(runs, () => false, () => false)).toEqual({ stamp: runs[0], usable: false, onMain: false });
  expect(reminderStamp([], () => true, () => true)).toEqual({ stamp: null, usable: false, onMain: false });
});
