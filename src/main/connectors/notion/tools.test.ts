import { describe, expect, test } from 'vitest';
import { InvalidArguments, NotAllowed, SchemaChanged } from '../errors';
import { missingTools } from '../mcp/toolset';
import { ALLOWED_TOOLS, NOTION_ID, NOTION_TOOLS, notionId } from './tools';

const FOUR = ['notion-get-self', 'notion-search', 'notion-fetch', 'notion-query-data-sources'];
const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const HEX = '0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d';
const q = 'notion-query-data-sources' as const;

// The exact JSON that worked against real Notion ("Exact request shapes").
const spike = () => ({
  data: {
    mode: 'rows', data_source_url: `collection://${UUID}`, limit: 100,
    sort: [{ property: 'Deadline', direction: 'ascending' }],
    filter: {
      type: 'group', operator: 'and', filters: [
        { type: 'property', property: 'Owner', propertyType: 'person', operator: 'person_contains', value: { type: 'relative', value: 'me' } },
        { type: 'property', property: 'Status', propertyType: 'status', operator: 'status_is_not', value: { type: 'is_group', value: 'complete' } },
        { type: 'property', property: 'Stage', propertyType: 'select', operator: 'enum_is_not', value: { type: 'exact', value: 'Shipped' } },
        { type: 'property', property: 'Title', propertyType: 'title', operator: 'string_contains', value: { type: 'exact', value: 'PRICING' } }
      ]
    }
  }
});

describe('Notion ToolSet', () => {
  test('exactly the four read tools', () => {
    expect([...NOTION_TOOLS.names].sort()).toEqual([...FOUR].sort());
    expect([...ALLOWED_TOOLS].sort()).toEqual([...FOUR].sort());
    expect(() => (NOTION_TOOLS.names as string[]).push('notion-update-page')).toThrow(TypeError);
  });

  test.each(['notion-create-pages', 'notion-update-page', 'notion-delete-pages', 'notion-query-multiple-data-sources', 'NOTION-FETCH', ' notion-fetch', 'constructor', '__proto__', '', 42, null])(
    '%j refused before any request', (name) => {
      expect(NOTION_TOOLS.isAllowed(name)).toBe(false);
      expect(() => NOTION_TOOLS.parseArgs(name as 'notion-fetch', {})).toThrow(NotAllowed);
      expect(() => NOTION_TOOLS.parseReply(name as 'notion-fetch', {})).toThrow(NotAllowed);
    });

  test('missingTools reports what tools/list lacks', () => {
    expect(missingTools(NOTION_TOOLS, FOUR)).toEqual([]);
    expect(missingTools(NOTION_TOOLS, ['notion-fetch'])).toHaveLength(3);
  });

  test('get-self and search arguments', () => {
    expect(NOTION_TOOLS.parseArgs('notion-get-self', {})).toEqual({});
    expect(() => NOTION_TOOLS.parseArgs('notion-get-self', { x: 1 })).toThrow(InvalidArguments);
    expect(NOTION_TOOLS.parseArgs('notion-search', { query: 'a', page_size: 25, max_highlight_length: 0 })).toEqual({ query: 'a', page_size: 25, max_highlight_length: 0 });
    for (const bad of [{}, { query: '' }, { query: 'x'.repeat(201) }, { query: 'a', page_size: 26 }, { query: 'a', page_size: 0 },
      { query: 'a', max_highlight_length: 5 }, { query: 'a', data_source_url: 'collection://x' }, { query: 'a', page_url: 'x' }]) {
      expect(() => NOTION_TOOLS.parseArgs('notion-search', bad), JSON.stringify(bad)).toThrow(InvalidArguments);
    }
  });

  test('fetch takes only ids and collection:// ids; a URL is refused', () => {
    for (const ok of [UUID, HEX, HEX.toUpperCase(), `collection://${UUID}`, `collection://${HEX}`]) {
      expect(NOTION_TOOLS.parseArgs('notion-fetch', { id: ok })).toEqual({ id: ok });
    }
    for (const bad of ['https://www.notion.so/acme/Backlog-' + HEX, `https://app.notion.com/p/${HEX}`, `${HEX}?v=${HEX}`, 'memory', '', `collection://${UUID}/x`, ` ${UUID}`, `${UUID}\n`, HEX.slice(1)]) {
      expect(() => NOTION_TOOLS.parseArgs('notion-fetch', { id: bad }), bad).toThrow(InvalidArguments);
    }
    expect(() => NOTION_TOOLS.parseArgs('notion-fetch', { id: UUID, extra: 1 })).toThrow(InvalidArguments);
  });

  test('the four filter shapes Notion takes pass', () => {
    expect(NOTION_TOOLS.parseArgs(q, spike())).toEqual(spike());
    expect(NOTION_TOOLS.parseArgs(q, { data: { mode: 'rows', data_source_url: `collection://${UUID}` } })).toBeTruthy();
  });

  test('SQL mode refused', () => {
    expect(() => NOTION_TOOLS.parseArgs(q, { data: { data_source_urls: [`collection://${UUID}`], query: 'SELECT 1' } })).toThrow(InvalidArguments);
    expect(() => NOTION_TOOLS.parseArgs(q, { data: { mode: 'sql', data_source_urls: [`collection://${UUID}`], query: 'SELECT 1' } })).toThrow(InvalidArguments);
  });

  test('view mode refused', () => {
    expect(() => NOTION_TOOLS.parseArgs(q, { data: { mode: 'view', view_url: 'https://notion.so/x' } })).toThrow(InvalidArguments);
  });

  test('a rows query is refused when it strays from the allowed shapes', () => {
    const withFilter = (f: unknown) => ({ data: { ...spike().data, filter: { type: 'group', operator: 'and', filters: [f] } } });
    const prop = { type: 'property', property: 'Owner', propertyType: 'person', operator: 'person_contains', value: { type: 'relative', value: 'me' } };
    const bad: unknown[] = [
      { data: { ...spike().data, data_source_url: 'https://x.test' } },
      { data: { ...spike().data, limit: 101 } },
      { data: { ...spike().data, limit: 0 } },
      { data: { ...spike().data, extra: 1 } },
      { data: { ...spike().data, sort: [{ property: 'a', direction: 'descending' }] } },
      { data: { ...spike().data, sort: [{ property: 'a', direction: 'ascending' }, { property: 'b', direction: 'ascending' }] } },
      { data: { ...spike().data, filter: { type: 'group', operator: 'or', filters: [prop] } } },
      { data: { ...spike().data, filter: { type: 'group', operator: 'and', filters: Array.from({ length: 13 }, () => prop) } } },
      withFilter({ ...prop, operator: 'person_does_not_contain' }),
      withFilter({ ...prop, operator: 'status_is_not' }),
      withFilter({ ...prop, propertyType: 'date' }),
      withFilter({ ...prop, value: { type: 'exact', value: 'me' } }),
      withFilter({ ...prop, value: { type: 'relative', value: 'someone' } }),
      withFilter({ ...prop, extra: 1 }),
      withFilter({ type: 'property', property: 'S', propertyType: 'status', operator: 'status_is_not', value: { type: 'is_group', value: 'to_do' } }),
      withFilter({ type: 'property', property: 'T', propertyType: 'title', operator: 'string_contains', value: { type: 'exact', value: 5 } }),
      withFilter({ ...prop, property: '' }),
      withFilter({ ...prop, property: 'x'.repeat(101) }),
      withFilter({ ...prop, property: 'a\u0000b' }),
      withFilter({ type: 'group', operator: 'and', filters: [] })
    ];
    for (const b of bad) expect(() => NOTION_TOOLS.parseArgs(q, b), JSON.stringify(b)).toThrow(InvalidArguments);
  });

  test('a filter with an unknown operator refused', () => {
    const f = { type: 'property', property: 'Owner', propertyType: 'person', operator: 'person_is', value: { type: 'relative', value: 'me' } };
    expect(() => NOTION_TOOLS.parseArgs(q, { data: { ...spike().data, filter: { type: 'group', operator: 'and', filters: [f] } } })).toThrow(InvalidArguments);
  });

  test('get-self and search replies', () => {
    const self = { workspace: { id: UUID, name: 'W' }, user: { id: UUID, name: 'F', type: 'person', email: 'x' } };
    expect(NOTION_TOOLS.parseReply('notion-get-self', self)).toEqual({ workspace: { id: UUID, name: 'W' }, user: { id: UUID, name: 'F', type: 'person' } });
    expect(() => NOTION_TOOLS.parseReply('notion-get-self', { user: self.user })).toThrow(SchemaChanged);
    const r = NOTION_TOOLS.parseReply('notion-search', { type: 'workspace_search', results: [
      { id: UUID, title: 'Backlog', url: 'https://app.notion.com/p/x', type: 'database', path: 'A / B', highlight: 'h' },
      { id: 5, title: 'bad' }, { id: UUID, title: 'T', type: 'page', url: 7 }
    ] });
    expect(r.results).toEqual([
      { id: UUID, title: 'Backlog', url: 'https://app.notion.com/p/x', type: 'database', path: 'A / B' },
      { id: UUID, title: 'T', type: 'page', url: undefined, path: undefined }
    ]);
    expect(() => NOTION_TOOLS.parseReply('notion-search', {})).toThrow(SchemaChanged);
    expect(NOTION_TOOLS.parseReply('notion-search', { results: [] })).toEqual({ results: [] });
    expect(() => NOTION_TOOLS.parseReply('notion-search', { results: [{ id: 5 }, 'x'] })).toThrow(SchemaChanged);
  });

  test('fetch reply', () => {
    expect(NOTION_TOOLS.parseReply('notion-fetch', { metadata: { type: 'database' }, title: 'B', url: 'u', text: 't', path: 'p' }))
      .toEqual({ metadata: { type: 'database' }, title: 'B', url: 'u', text: 't' });
    expect(NOTION_TOOLS.parseReply('notion-fetch', { metadata: { type: 'weird' }, text: '' }).metadata.type).toBe('weird');
    expect(() => NOTION_TOOLS.parseReply('notion-fetch', { metadata: { type: 'page' } })).toThrow(SchemaChanged);
  });

  test('query reply: rows need a url; a non-empty list with none valid is SchemaChanged', () => {
    const ok = { Name: 'a', url: 'https://app.notion.com/p/' + HEX };
    expect(NOTION_TOOLS.parseReply(q, { results: [ok, { Name: 'no url' }, 3], has_more: false })).toEqual({ results: [ok], has_more: false });
    expect(NOTION_TOOLS.parseReply(q, { results: [] })).toEqual({ results: [] });
    expect(() => NOTION_TOOLS.parseReply(q, { results: [{ Name: 'x' }] })).toThrow(SchemaChanged);
    expect(() => NOTION_TOOLS.parseReply(q, {})).toThrow(SchemaChanged);
  });
});

describe('notionId', () => {
  test('normalizes to 32 lowercase hex', () => {
    expect(notionId(UUID)).toBe(HEX);
    expect(notionId(HEX.toUpperCase())).toBe(HEX);
    expect(notionId(UUID.toUpperCase())).toBe(HEX);
    for (const bad of ['', 'x', HEX + '0', `collection://${UUID}`, ` ${HEX}`, 'g'.repeat(32)]) expect(notionId(bad), bad).toBeNull();
    expect(NOTION_ID.test(UUID)).toBe(true);
  });
});
