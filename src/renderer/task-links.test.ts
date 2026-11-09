import { afterEach, describe, expect, test, vi } from 'vitest';
import { MAX_LINKED_PROJECTS, fallbackUrl, loadTaskLinks, parseTaskLinks, pruneTaskLinks, saveTaskLinks, taskLinkUrl, withProjectLinks, type TaskLink } from './task-links';

const link = (id: string, over: Partial<TaskLink> = {}): TaskLink => ({
  source: 'clickup', taskId: id, displayId: `ENG-${id}`, title: `Task ${id}`, url: `https://app.clickup.com/t/${id}`, ...over
});

describe('parseTaskLinks: whatever was saved → valid links only', () => {
  test('a good value round-trips', () => {
    const v = { '/p': { t1: link('86a'), t2: link('86b') } };
    expect(parseTaskLinks(JSON.stringify(v))).toEqual(v);
  });
  test.each([
    ['nothing', null],
    ['broken JSON', '{'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['a project that is not an object', '{"/p": 3}']
  ])('%s → none', (_n, raw) => {
    expect(parseTaskLinks(raw)).toEqual({});
  });
  test('bad entries go, the good ones stay', () => {
    const bad: Record<string, unknown> = {
      a: link('86a'),
      b: { ...link('86b'), source: 'linear' },
      c: { ...link('86c'), taskId: 'has space' },
      d: { ...link('86d'), taskId: 'x'.repeat(65) },
      e: { ...link('86e'), url: 'javascript:alert(1)' },
      f: { ...link('86f'), url: 'http://app.clickup.com/t/86f' },
      g: { ...link('86g'), url: 'https://evil.example/t/86g' },
      h: { ...link('86h'), title: 42 },
      i: { ...link('86i'), displayId: 'x'.repeat(65) },
      j: null,
      k: 'str'
    };
    expect(parseTaskLinks(JSON.stringify({ '/p': bad }))).toEqual({ '/p': { a: link('86a') } });
  });
  test('titles and display ids are one line without control or bidi characters (they are shown and copied)', () => {
    const parsed = parseTaskLinks(JSON.stringify({ '/p': { a: link('86a', { title: `Fix\nit${String.fromCharCode(0x202e)}\x07`, displayId: 'ENG\t1' }) } }));
    expect(parsed['/p']!.a).toMatchObject({ title: 'Fix it', displayId: 'ENG 1' });
  });
});

describe('the links of a project', () => {
  test('withProjectLinks replaces one project, drops it when empty, keeps the latest projects', () => {
    const all = { '/a': { t1: link('1') }, '/b': { t2: link('2') } };
    expect(withProjectLinks(all, '/a', { t3: link('3') })).toEqual({ '/b': { t2: link('2') }, '/a': { t3: link('3') } });
    expect(withProjectLinks(all, '/a', {})).toEqual({ '/b': { t2: link('2') } });
    const many = Object.fromEntries(Array.from({ length: MAX_LINKED_PROJECTS + 5 }, (_, i) => [`/p${i}`, { t: link(String(i)) }]));
    const next = withProjectLinks(many, '/new', { t: link('n') });
    expect(Object.keys(next)).toHaveLength(MAX_LINKED_PROJECTS);
    expect(Object.keys(next).at(-1)).toBe('/new');
  });

  test('pruneTaskLinks drops links of terminals that are gone; an empty list (before atelierd answers) drops nothing', () => {
    const links = { t1: link('1'), t2: link('2') };
    expect(pruneTaskLinks(links, ['t1', 'x'])).toEqual({ t1: link('1') });
    expect(pruneTaskLinks(links, [])).toBe(links);
    expect(pruneTaskLinks(links, ['t1', 't2'])).toBe(links);
  });

  test('taskLinkUrl: the saved link when it is the source\'s own page, else the task\'s short link', () => {
    expect(taskLinkUrl(link('86a', { url: 'https://app.clickup.com/9015/v/t/86a' }))).toBe('https://app.clickup.com/9015/v/t/86a');
    expect(taskLinkUrl({ ...link('86a'), url: 'https://evil.example/' })).toBe('https://app.clickup.com/t/86a');
  });
});

describe('storage (localStorage, every access guarded)', () => {
  afterEach(() => vi.unstubAllGlobals());
  test('save then load, per project; other projects untouched', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    saveTaskLinks('/a', { t1: link('1') });
    saveTaskLinks('/b', { t2: link('2') });
    expect(loadTaskLinks('/a')).toEqual({ t1: link('1') });
    expect(loadTaskLinks('/b')).toEqual({ t2: link('2') });
    saveTaskLinks('/a', {});
    expect(loadTaskLinks('/a')).toEqual({});
    expect(loadTaskLinks('/b')).toEqual({ t2: link('2') });
  });
  test('no storage, or one that throws: nothing loaded, nothing thrown', () => {
    expect(loadTaskLinks('/a')).toEqual({});
    expect(() => saveTaskLinks('/a', { t1: link('1') })).not.toThrow();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } });
    expect(loadTaskLinks('/a')).toEqual({});
    expect(() => saveTaskLinks('/a', { t1: link('1') })).not.toThrow();
  });
});

describe('tasks without a display ID, Notion links', () => {
  const notion = (over: Partial<TaskLink> = {}): TaskLink => ({
    source: 'notion', taskId: 'a'.repeat(32), displayId: '', title: 'Write the launch post', url: `https://www.notion.so/${'a'.repeat(32)}`, ...over
  });
  test('a Notion link with an empty displayId and a title is kept', () => {
    const v = { '/p': { t1: notion() } };
    expect(parseTaskLinks(JSON.stringify(v))).toEqual(v);
  });
  test('without a title it is refused; ClickUp still needs a displayId', () => {
    expect(parseTaskLinks(JSON.stringify({ '/p': { t1: notion({ title: '  ' }) } }))).toEqual({});
    expect(parseTaskLinks(JSON.stringify({ '/p': { t1: link('86a', { displayId: '' }) } }))).toEqual({});
  });
  test.each(['app.notion.com', 'www.notion.so', 'notion.so'])('a saved Notion link on %s is kept', (host) => {
    const v = { '/p': { t1: notion({ url: `https://${host}/p/${'a'.repeat(32)}` }) } };
    expect(parseTaskLinks(JSON.stringify(v))).toEqual(v);
  });
  test.each([
    ['http:', 'http://www.notion.so/x'],
    ['a port', 'https://www.notion.so:8443/x'],
    ['credentials', 'https://user:pw@www.notion.so/x']
  ])('a Notion link with %s is refused', (_n, url) => {
    expect(parseTaskLinks(JSON.stringify({ '/p': { t1: notion({ url }) } }))).toEqual({});
  });
  test('evil.example is refused', () => {
    expect(parseTaskLinks(JSON.stringify({ '/p': { t1: notion({ url: 'https://evil.example/x' }) } }))).toEqual({});
    expect(parseTaskLinks(JSON.stringify({ '/p': { t1: notion({ url: 'https://app.clickup.com/t/x' }) } }))).toEqual({});
  });
  test('fallback URLs: ClickUp short link, Notion page', () => {
    expect(taskLinkUrl(link('86a', { url: 'https://evil.example/' }))).toBe('https://app.clickup.com/t/86a');
    expect(taskLinkUrl(notion({ url: 'https://evil.example/' }))).toBe(`https://www.notion.so/${'a'.repeat(32)}`);
    expect(taskLinkUrl(notion({ url: `https://app.notion.com/p/${'a'.repeat(32)}` }))).toBe(`https://app.notion.com/p/${'a'.repeat(32)}`);
  });
});

describe('Jira links', () => {
  const jira = (url: string): unknown => ({ source: 'jira', taskId: '10103', displayId: 'ATL-3', title: 'Billing export', url });
  const parsed = (url: string) => parseTaskLinks(JSON.stringify({ '/p': { t1: jira(url) } }))['/p']?.t1 ?? null;

  test('only a site\'s issue page is kept', () => {
    expect(parsed('https://acme.atlassian.net/browse/ATL-3')).not.toBeNull();
    for (const bad of ['https://evil.example/browse/ATL-3', 'http://acme.atlassian.net/browse/ATL-3', 'https://acme.atlassian.net/wiki/x',
      'https://acme.atlassian.net:8443/browse/ATL-3', 'https://acme.atlassian.net.evil.example/browse/ATL-3']) expect(parsed(bad), bad).toBeNull();
  });

  test('when main has no link (Jira disconnected), a Jira chip falls back to the link it saved; ClickUp and Notion never do', () => {
    const saved = parsed('https://acme.atlassian.net/browse/ATL-3') as TaskLink;
    expect(fallbackUrl(saved)).toBe('https://acme.atlassian.net/browse/ATL-3');
    expect(fallbackUrl(link('86a'))).toBeNull();
  });
});
