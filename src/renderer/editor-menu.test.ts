import { expect, test, vi } from 'vitest';
import { csvCellMenu, editorMenu, jsonNodeMenu, previewMenu } from './menus';
import type { MenuItem } from './menu-model';

const base = { copy: null, selectAll: () => {}, find: () => {}, gotoLine: () => {}, mentionLines: null };
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? 'sep' : i.id));

test('the editor menu offers Change Language Mode (untitled tabs too) after Go to Line', () => {
  const run = vi.fn();
  for (const path of ['/p/a.txt', 'untitled:1']) {
    const items = editorMenu(path, { ...base, changeLanguage: run });
    const list = ids(items);
    expect(list.indexOf('change-language')).toBe(list.indexOf('goto') + 1);
    const item = items.find((i) => i !== 'sep' && i.id === 'change-language');
    expect(item !== 'sep' && item?.label).toBe('Change Language Mode…');
    if (item && item !== 'sep') item.run();
  }
  expect(run).toHaveBeenCalledTimes(2);
  expect(ids(editorMenu('/p/a.txt', base))).not.toContain('change-language');
});

test('Find and Replace (⌥⌘F) follows Find in editable views only', () => {
  const run = vi.fn();
  const items = editorMenu('/p/a.ts', { ...base, findReplace: run });
  const list = ids(items);
  expect(list.indexOf('find-replace')).toBe(list.indexOf('find') + 1);
  const item = items.find((i) => i !== 'sep' && i.id === 'find-replace');
  expect(item !== 'sep' && [item?.label, item?.hint]).toEqual(['Find and Replace', '⌥⌘F']);
  if (item && item !== 'sep') item.run();
  expect(run).toHaveBeenCalledOnce();
  expect(ids(editorMenu('/p/a.ts', base))).not.toContain('find-replace');
});

test('Markdown tabs: the editor menu offers Toggle Markdown Preview (⇧⌘V) after Change Language Mode', () => {
  const run = vi.fn();
  const items = editorMenu('/p/a.md', { ...base, changeLanguage: () => {}, togglePreview: run });
  const list = ids(items);
  expect(list.indexOf('md-preview')).toBe(list.indexOf('change-language') + 1);
  const item = items.find((i) => i !== 'sep' && i.id === 'md-preview');
  expect(item !== 'sep' && [item?.label, item?.hint]).toEqual(['Toggle Markdown Preview', '⇧⌘V']);
  if (item && item !== 'sep') item.run();
  expect(run).toHaveBeenCalledOnce();
  expect(ids(editorMenu('/p/a.ts', base))).not.toContain('md-preview');
});

test('the preview menu: line actions, copy, find, Show in Source with its line, file items', () => {
  const pv = { copy: () => {}, copyMarkdown: () => {}, selectAll: () => {}, find: () => {}, showSource: { line: 24, run: vi.fn() }, mentionLines: () => {}, commentLines: () => {}, togglePreview: () => {} };
  const items = previewMenu('/p/a.md', pv);
  expect(ids(items)).toEqual(['comment-lines', 'mention-lines', 'sep', 'copy', 'copy-markdown', 'select-all', 'sep', 'find', 'sep', 'show-source', 'md-preview', 'sep', 'copy-path', 'copy-rel', 'reveal-tree', 'reveal-finder']);
  const show = items.find((i) => i !== 'sep' && i.id === 'show-source');
  expect(show !== 'sep' && [show?.label, show?.hint]).toEqual(['Show in Source', 'Ln 24']);
  // Nothing selected: copies disabled, no line items; no block under the pointer: no Show in Source.
  const bare = previewMenu('untitled:1', { ...pv, copy: null, copyMarkdown: null, mentionLines: null, commentLines: null, showSource: null });
  expect(ids(bare)).toEqual(['copy', 'copy-markdown', 'select-all', 'sep', 'find', 'sep', 'md-preview']);
  expect(bare.filter((i) => i !== 'sep' && i.disabled).map((i) => i !== 'sep' && i.id)).toEqual(['copy', 'copy-markdown']);
});

test('a file outside the project: no relative path to copy, no Files tree to reveal it in; Finder stays', async () => {
  const { useApp } = await import('./store');
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' } });
  try {
    expect(ids(editorMenu('/Users/me/x.json', base))).toContain('reveal-finder');
    expect(ids(editorMenu('/Users/me/x.json', base))).not.toContain('copy-rel');
    expect(ids(editorMenu('/Users/me/x.json', base))).not.toContain('reveal-tree');
    expect(ids(editorMenu('/p/a.ts', base))).toEqual(expect.arrayContaining(['copy-rel', 'reveal-tree']));
  } finally {
    useApp.setState({ project: null });
  }
});

test('JSON tabs: the editor menu offers Toggle JSON Tree (⇧⌘V) and Copy JSON Path (⌥⇧⌘C)', () => {
  const copyPath = vi.fn();
  const toggle = vi.fn();
  const items = editorMenu('/p/a.json', { ...base, changeLanguage: () => {}, jsonTree: toggle, copyJsonPath: copyPath });
  const list = ids(items);
  expect(list.slice(list.indexOf('change-language') + 1, list.indexOf('change-language') + 3)).toEqual(['json-tree', 'copy-json-path']);
  const get = (id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;
  expect([get('json-tree').label, get('json-tree').hint]).toEqual(['Toggle JSON Tree', '⇧⌘V']);
  expect([get('copy-json-path').label, get('copy-json-path').hint]).toEqual(['Copy JSON Path', '⌥⇧⌘C']);
  get('json-tree').run();
  get('copy-json-path').run();
  expect(toggle).toHaveBeenCalledOnce();
  expect(copyPath).toHaveBeenCalledOnce();
});

test('CSV tabs: the editor menu offers Toggle CSV Table (⇧⌘V) and Copy Cell', () => {
  const toggle = vi.fn();
  const copyCell = vi.fn();
  const items = editorMenu('/p/a.csv', { ...base, changeLanguage: () => {}, csvTable: toggle, copyCsvCell: copyCell });
  const list = ids(items);
  expect(list.slice(list.indexOf('change-language') + 1, list.indexOf('change-language') + 3)).toEqual(['csv-table', 'copy-csv-cell']);
  const get = (id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;
  expect([get('csv-table').label, get('csv-table').hint, get('csv-table').icon]).toEqual(['Toggle CSV Table', '⇧⌘V', 'table']);
  expect(get('copy-csv-cell').label).toBe('Copy Cell');
  get('csv-table').run();
  get('copy-csv-cell').run();
  expect(toggle).toHaveBeenCalledOnce();
  expect(copyCell).toHaveBeenCalledOnce();
});

test('the CSV cell menu: copies, Copy As with samples and the header switch, filters, sort, source, session', () => {
  const a = { copy: vi.fn(), copyAs: vi.fn(), toggleHeader: vi.fn(), copyNames: vi.fn(), filterBy: vi.fn(), exclude: vi.fn(), sortAsc: vi.fn(), sortDesc: vi.fn(), showSource: vi.fn(), comment: vi.fn(), mention: vi.fn() };
  const samples = { tsv: '5\t612,90', csv: 'items;total_eur', markdown: '| items | total_eur |', json: '[{"items": 5}]', sql: '(5, 612.90)' };
  const items = csvCellMenu({ value: '948,40', column: 'total_eur', rows: 'Rows 3–9', block: '7 rows × 2 columns', samples, delimiter: ';', header: true }, a);
  expect(ids(items)).toEqual(['copy', 'copy-as', 'copy-names', 'sep', 'filter-by', 'exclude', 'sort-asc', 'sort-desc', 'sep', 'show-source', 'comment', 'mention']);
  const get = (id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;
  expect([get('copy').label, get('copy').hint]).toEqual(['Copy', '⌘C']);
  expect(get('filter-by').label).toBe('Filter by 948,40');
  expect(get('exclude').label).toBe('Exclude 948,40');
  expect(get('sort-desc').label).toBe('Sort by total_eur ↓');
  expect([get('show-source').label, get('show-source').hint]).toEqual(['Show in Source', '⌥⏎']);
  expect([get('comment').label, get('comment').hint]).toEqual(['Comment on Rows 3–9…', '⌥⌘C']);
  expect(get('mention')).toMatchObject({ label: 'Mention Rows 3–9 in Session…', hint: '⌘L', accent: true });
  const sub = get('copy-as').submenu!;
  expect(sub.map((i) => (i === 'sep' ? 'sep' : [i.label, i.detail, i.hint ?? null]))).toEqual([
    ['TSV', '5\t612,90', 'pastes as cells'], ['CSV', 'items;total_eur', "file's delimiter ;"], ['Markdown Table', '| items | total_eur |', null],
    ['JSON', '[{"items": 5}]', 'array of objects'], ['SQL VALUES', '(5, 612.90)', null], 'sep', ['Include Header Row', undefined, null]
  ]);
  expect((sub[6] as Exclude<MenuItem, 'sep'>).icon).toBe('check');
  (sub[2] as Exclude<MenuItem, 'sep'>).run();
  expect(a.copyAs).toHaveBeenCalledWith('markdown');
  (sub[6] as Exclude<MenuItem, 'sep'>).run();
  expect(a.toggleHeader).toHaveBeenCalledOnce();
  // Without a session or for an untitled tab: disabled; a long value is cut in the labels.
  const off = csvCellMenu({ value: 'x'.repeat(40), column: 'c', rows: 'Row 1', block: '1 row × 1 column', samples, delimiter: ',', header: false }, { ...a, comment: null, mention: null });
  const oget = (id: string) => off.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;
  expect([oget('comment').disabled, oget('mention').disabled]).toEqual([true, true]);
  expect(oget('filter-by').label).toBe(`Filter by ${'x'.repeat(23)}…`);
  expect((oget('copy-as').submenu![6] as Exclude<MenuItem, 'sep'>).icon).toBeUndefined();
});

test('the JSON tree node menu: order, hints, the formats submenu, what is disabled', () => {
  const a = { copyValue: vi.fn(), copyKey: vi.fn(), copyPath: vi.fn(), copyPathAs: vi.fn(), openFormatSetting: vi.fn(), showSource: vi.fn(), filterByKey: vi.fn(), expandChildren: vi.fn(), collapseChildren: vi.fn(), mention: vi.fn() };
  const paths = { jq: '.database.pool', js: 'data.database.pool', pointer: '/database/pool' };
  const items = jsonNodeMenu({ box: true, paths, format: 'jq' }, a);
  expect(ids(items)).toEqual(['copy-value', 'copy-key', 'copy-path', 'copy-path-as', 'sep', 'show-source', 'filter-key', 'sep', 'expand-children', 'collapse-children', 'sep', 'mention']);
  const get = (id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;
  expect([get('copy-value').label, get('copy-value').hint]).toEqual(['Copy Value as JSON', '⌘C']);
  expect(get('copy-path').hint).toBe('⌥⇧⌘C');
  expect([get('show-source').label, get('show-source').hint]).toEqual(['Show in Source', '⌥⏎']);
  expect([get('expand-children').hint, get('collapse-children').hint]).toEqual(['⌥→', '⌥←']);
  expect(get('mention')).toMatchObject({ label: 'Mention in Session…', accent: true });
  const sub = get('copy-path-as').submenu!;
  expect(sub.map((i) => (i === 'sep' ? 'sep' : [i.label, i.detail]))).toEqual([['jq', '.database.pool'], ['JavaScript', 'data.database.pool'], ['JSON Pointer', '/database/pool'], 'sep', ['Default for Copy Path: jq', undefined]]);
  (sub[2] as Exclude<MenuItem, 'sep'>).run();
  expect(a.copyPathAs).toHaveBeenCalledWith('pointer');
  (sub[4] as Exclude<MenuItem, 'sep'>).run();
  expect(a.openFormatSetting).toHaveBeenCalledOnce();
  // A scalar in an array: no key to copy or filter by, nothing to expand; the root's pointer shows as (root).
  const leaf = jsonNodeMenu({ box: false, paths: { jq: '.', js: 'data', pointer: '' }, format: 'pointer' }, { ...a, copyKey: null, filterByKey: null, expandChildren: null, collapseChildren: null, mention: null });
  const lget = (id: string) => leaf.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;
  expect(lget('copy-value').label).toBe('Copy Value');
  for (const id of ['copy-key', 'filter-key', 'expand-children', 'collapse-children', 'mention']) expect(lget(id).disabled, id).toBe(true);
  expect((lget('copy-path-as').submenu![2] as Exclude<MenuItem, 'sep'>).detail).toBe('(root)');
  expect((lget('copy-path-as').submenu![4] as Exclude<MenuItem, 'sep'>).label).toBe('Default for Copy Path: JSON Pointer');
});
