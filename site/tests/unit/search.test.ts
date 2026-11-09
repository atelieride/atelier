import { expect, test } from 'vitest';
import { anchorReleaseHtml, buildIndex, search, slug, type SearchItem } from '../../src/lib/search';
import { renderReleases } from '../../src/lib/releases';

test('slug: lower case, accents dropped, anything else a single dash', () => {
  expect(slug('Worktrees in Changes')).toBe('worktrees-in-changes');
  expect(slug('“Finished” only after a long turn')).toBe('finished-only-after-a-long-turn');
  expect(slug('Terminal › Aliases')).toBe('terminal-aliases');
  expect(slug('Café & co')).toBe('cafe-co');
});

test('changelog entries that start with a bold title get an anchor, deduplicated, titles decoded', () => {
  const html = '<ul>\n<li><strong>Split view</strong>: two panes.</li>\n<li>Plain line.</li>\n'
    + '<li><strong>When Atelier isn’t sure &amp; why</strong>: chips.</li>\n<li><strong>Split view</strong>: again.</li>\n</ul>';
  const out = anchorReleaseHtml(html, '0.2.0-beta.6');
  expect(out.entries).toEqual([
    { title: 'Split view', id: 'v0.2.0-beta.6-split-view' },
    { title: 'When Atelier isn’t sure & why', id: 'v0.2.0-beta.6-when-atelier-isn-t-sure-why' },
    { title: 'Split view', id: 'v0.2.0-beta.6-split-view-2' }
  ]);
  expect(out.html).toContain('<li id="v0.2.0-beta.6-split-view"><strong>Split view</strong>: two panes.</li>');
  expect(out.html).toContain('<li>Plain line.</li>');
  expect(out.html).toContain('<li id="v0.2.0-beta.6-split-view-2"><strong>Split view</strong>: again.</li>');
});

test('the changelog page and the index share one rendering: anchors in the HTML, entries alongside', async () => {
  const md = '# Changelog\n\n## 0.2.0-beta.8\n\n- **Worktrees in Changes**: nested.\n- Small fix.\n\n## 0.2.0-beta.7\n\n- **Source Control**: fetch.\n';
  const releases = await renderReleases(md);
  expect(releases.map((r) => r.version)).toEqual(['0.2.0-beta.8', '0.2.0-beta.7']);
  expect(releases[0]!.html).toContain('id="v0.2.0-beta.8-worktrees-in-changes"');
  expect(releases[0]!.entries).toEqual([{ title: 'Worktrees in Changes', id: 'v0.2.0-beta.8-worktrees-in-changes' }]);
});

const index = buildIndex({
  rows: [{ id: 'sessions', eyebrow: 'Sessions', title: 'Know who needs you.' }, { id: 'workspace', eyebrow: 'Workspace', title: 'Everything side by side.' }],
  bento: [{ title: 'Session panel', text: 'Model, permission mode, MCP servers and skills at a glance.' }],
  keys: [{ keys: ['⌘', '\\'], label: 'Split view' }, { keys: ['⌘', 'J'], label: 'Next session waiting' }],
  releases: [
    { version: '0.2.0-beta.8', entries: [{ title: 'Worktrees in Changes', id: 'v0.2.0-beta.8-worktrees-in-changes' }] },
    { version: '0.2.0-beta.6', entries: [{ title: 'Split view', id: 'v0.2.0-beta.6-split-view' }] }
  ]
});

test('the index: pages, features, the bento, shortcuts and every changelog entry, each with where it leads', () => {
  const find = (group: string, label: string) => index.find((i) => i.group === group && i.label === label);
  expect(index.filter((i) => i.group === 'Pages').map((i) => [i.label, i.href])).toEqual([
    ['Overview', '/'], ['Features', '/features'], ['Changelog', '/changelog'], ['Download', '/download'], ['Support Atelier', '/support'],
    ['Source code', 'https://github.com/atelieride/atelier']
  ]);
  expect(find('Features', 'Sessions')).toMatchObject({ hint: 'Know who needs you.', href: '/features#sessions' });
  expect(find('And more', 'Session panel')).toMatchObject({ href: '/features#more' });
  expect(find('Shortcuts', 'Split view')).toMatchObject({ keys: ['⌘', '\\'], href: '/features#shortcuts' });
  expect(find('Changelog', 'Worktrees in Changes')).toMatchObject({ hint: '0.2.0-beta.8', latest: true, href: '/changelog#v0.2.0-beta.8-worktrees-in-changes' });
  expect(find('Changelog', 'Split view')).toMatchObject({ hint: '0.2.0-beta.6', latest: false });
});

const labels = (groups: ReturnType<typeof search>) => groups.map((g) => [g.title, g.hits.map((h) => h.item.label)]);

test('empty query: pages, features, what is new in the latest version, shortcuts', () => {
  expect(labels(search(index, '  '))).toEqual([
    ['Pages', ['Overview', 'Features', 'Changelog', 'Download', 'Support Atelier', 'Source code']],
    ['Features', ['Sessions', 'Workspace']],
    ['New in 0.2.0-beta.8', ['Worktrees in Changes']],
    ['Shortcuts', ['Split view', 'Next session waiting']]
  ]);
});

test('a query matches labels and hints, case-insensitive, groups ordered by their best hit', () => {
  expect(labels(search(index, 'SPLIT'))).toEqual([['Changelog', ['Split view']], ['Shortcuts', ['Split view']]]);
  // "side" is in a hint only: found, ranked below label hits.
  expect(labels(search(index, 'side'))).toEqual([['Features', ['Workspace']]]);
  expect(labels(search(index, 'sess'))).toEqual([
    ['Features', ['Sessions']], ['And more', ['Session panel']], ['Shortcuts', ['Next session waiting']]
  ]);
});

test('hits carry the matched ranges, for underlining', () => {
  const [hit] = search(index, 'view')[0]!.hits;
  expect(hit!.label).toEqual([6, 10]);
  expect(search(index, 'side')[0]!.hits[0]!.hint).toEqual([11, 15]);
});

test('ranking inside a group: prefix, then word start, then inside a word; then the index order', () => {
  const items: SearchItem[] = ['Repos', 'Sub repo', 'Prepos', 'Repo'].map((label) => ({ group: 'Features', label, hint: '', href: '/' }));
  expect(search(items, 'repo')[0]!.hits.map((h) => h.item.label)).toEqual(['Repos', 'Repo', 'Sub repo', 'Prepos']);
});

test('at most six hits per group', () => {
  const items: SearchItem[] = Array.from({ length: 9 }, (_, i) => ({ group: 'Changelog', label: `Fix ${i}`, hint: '0.1.0', href: '/' }));
  expect(search(items, 'fix')[0]!.hits).toHaveLength(6);
});

test('no match: no groups', () => {
  expect(search(index, 'zzz')).toEqual([]);
});

test('Support Atelier is found by the words people type for it, ranked below any visible match', () => {
  for (const q of ['donate', 'sponsor', 'tip', 'coffee', 'support']) expect(labels(search(index, q))[0], q).toEqual(['Pages', ['Support Atelier']]);
  // A hidden word underlines nothing.
  const [hit] = search(index, 'donate')[0]!.hits;
  expect([hit!.label, hit!.hint]).toEqual([null, null]);
});
