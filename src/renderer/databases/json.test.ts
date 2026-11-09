import { describe, expect, test } from 'vitest';
import { MASK, MASK_COLUMN } from '@shared/pg-format';
import { JsonNum } from '../redis/view';
import {
  budgetHidden, budgetOf, colMenuItems, columnJsonLines, columnProfile, crumbs, escClearsFind, findHits, idOf, scrollKey, jsonPathSql, jsonPathText, jsonRows, lineMenu,
  nodeAt, nodeCopy, nodeDerived, nodeFilter, oneLine, prettyJson, profileLabel, revealPath, ROW_BUDGET, startFind, tableCell, tableOf, tableTargetOf, treeKey,
  unixHint, urlOf, utf8Bytes, visiblePath, type JsonNode, type JsonRow
} from './json';
import { isSafeUrl } from '@shared/links';
import { parseJson } from './json-text';

// The JSON tools' pure part: the inspector's rows (folds at depth 3, "… N more" after
// 50 items, parsed strings marked, unix time and URLs recognized, masks), find over the tree's data, the Table view's
// columns, paths and SQL (into a parsed string too), the hover actions' filters and JSON columns, the key profile.
// Every number exactly as Postgres printed it: the trees are json-text.ts's lossless ones.

const ROME = { times: 'local' as const, tz: 'Europe/Rome' };
const secret = (k: string) => MASK_COLUMN.test(k);

/** Board 2's inspected payload, as Postgres prints it (numbers as written). */
const BOARD = `{"id": "evt_1Q8f2aK9", "type": "invoice.paid", "created": 1793813327, "livemode": false, "data": {"object": {"id": "in_1Q8f29K9",
 "status": "paid", "amount_due": 4900, "customer_email": "mara@lindqvist.example", "invoice_pdf": "https://pay.example.com/in_1Q8f29K9/pdf",
 "lines": {"data": [{"id": "il_1Q8f29K9", "price": {"id": "price_pro_monthly", "unit_amount": 4900, "recurring": {"interval": "month"}}, "quantity": 1},
 {"id": "il_1Q8f2BK9", "price": {"id": "price_seat_monthly", "unit_amount": 0, "recurring": {"interval": "month"}}, "quantity": 3}]},
 "metadata": {"order_id": "10482", "notes_json": "{\\"gift\\":true,\\"n\\":12345678901234567890,\\"msg\\":\\"Happy birthday\\"}"}},
 "previous_attributes": {"status": "open"}}, "request": {"id": "req_8f2a91c4K9xQ", "idempotency_key": "6d1c2f0a-91b7-4c3e-a8f2-31b7c0a4e7d1"}}`;
const tree = (s: string): JsonNode => {
  const t = parseJson(s);
  if (t === undefined) throw new Error(`not JSON: ${s.slice(0, 40)}`);
  return t as JsonNode;
};
const BOARD_TREE = tree(BOARD);
const NO: ReadonlySet<string> = new Set();
const P = (...p: (string | number)[]) => p;
const NOTES = P('data', 'object', 'metadata', 'notes_json');
const row = (rows: readonly JsonRow[], path: (string | number)[], role: JsonRow['role'] = 'leaf') =>
  rows.find((r) => r.role === role && r.path.length === path.length && r.path.every((p, i) => p === path[i]));
const head = (rows: readonly JsonRow[], path: (string | number)[]) => rows.find((r) => r.role !== 'close' && r.role !== 'more' && idOf(r.path) === idOf(path));

describe('jsonRows', () => {
  test('folds containers at depth 3 and deeper at first; a fold flips that one; the root and depths 1–2 open', () => {
    const rows = jsonRows(BOARD_TREE, NO, NO, { zone: ROME });
    expect(rows[0]).toMatchObject({ role: 'open', depth: 0, key: null, text: '{', folded: false, kind: 'object' });
    expect(head(rows, P('data'))).toMatchObject({ role: 'open', depth: 1, folded: false });
    expect(head(rows, P('data', 'object'))).toMatchObject({ role: 'open', depth: 2, folded: false });
    // Depth 3: folded, one row with its count.
    expect(head(rows, P('data', 'object', 'lines'))).toMatchObject({ role: 'open', depth: 3, folded: true, text: '{…}', count: 1, kind: 'object' });
    expect(row(rows, P('data', 'object', 'lines', 'data'))).toBeUndefined();
    expect(rows[rows.length - 1]).toMatchObject({ role: 'close', depth: 0, text: '}' });
    // Unfolding one shows its members (its own depth-4 children fold in turn).
    const open = jsonRows(BOARD_TREE, new Set([idOf(P('data', 'object', 'lines'))]), NO, { zone: ROME });
    expect(head(open, P('data', 'object', 'lines'))).toMatchObject({ folded: false, text: '{' });
    expect(head(open, P('data', 'object', 'lines', 'data'))).toMatchObject({ folded: true, text: '[…]', count: 2, kind: 'array' });
    // Folding an open one.
    const shut = jsonRows(BOARD_TREE, new Set([idOf(P('data'))]), NO, { zone: ROME });
    expect(head(shut, P('data'))).toMatchObject({ folded: true, text: '{…}' });
    expect(shut.filter((r) => r.path[0] === 'data')).toHaveLength(1);
    expect(jsonRows(BOARD_TREE, NO, NO, { foldDepth: 1 }).filter((r) => r.folded).map((r) => r.key)).toEqual(['data', 'request']);
  });

  test('keys, commas, depths and line roles read as the source; an empty container is one leaf', () => {
    const rows = jsonRows(tree('{"a": 1, "b": [], "c": {}, "d": [true, null]}'), NO, NO);
    expect(rows.map((r) => [r.role, r.depth, r.key, r.text, r.comma])).toEqual([
      ['open', 0, null, '{', false],
      ['leaf', 1, 'a', '1', true],
      ['leaf', 1, 'b', '[]', true],
      ['leaf', 1, 'c', '{}', true],
      ['open', 1, 'd', '[', false],
      ['leaf', 2, 0, 'true', true],
      ['leaf', 2, 1, 'null', false],
      ['close', 1, null, ']', false],
      ['close', 0, null, '}', false]
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['object', 'number', 'array', 'object', 'array', 'boolean', 'null', 'array', 'object']);
  });

  test('an array over 50 items shows 50 and "… N more"; `shown` takes it further in place; objects past 1,000 keys too', () => {
    const big = tree(`[${Array.from({ length: 120 }, (_, i) => i).join(',')}]`);
    const rows = jsonRows(big, NO, NO);
    expect(rows.filter((r) => r.role === 'leaf')).toHaveLength(50);
    const more = rows.find((r) => r.role === 'more')!;
    expect(more).toMatchObject({ depth: 1, count: 70, path: [] });
    expect(rows[rows.length - 2]).toBe(more);
    // The last item shown keeps its comma: more follow.
    expect(row(rows, P(49))?.comma).toBe(true);
    const further = jsonRows(big, NO, NO, { shown: new Map([[idOf([]), 100]]) });
    expect(further.filter((r) => r.role === 'leaf')).toHaveLength(100);
    expect(further.find((r) => r.role === 'more')?.count).toBe(20);
    expect(jsonRows(big, NO, NO, { maxItems: 10 }).find((r) => r.role === 'more')?.count).toBe(110);
    const wide = tree(`{${Array.from({ length: 1200 }, (_, i) => `"k${i}": ${i}`).join(',')}}`);
    const w = jsonRows(wide, NO, NO);
    expect(w.filter((r) => r.role === 'leaf')).toHaveLength(1000);
    expect(w.find((r) => r.role === 'more')?.count).toBe(200);
  });

  test('every number exactly as written: big integers, decimals, exponents', () => {
    const rows = jsonRows(tree('{"id": 12345678901234567890, "price": 248.00, "e": -1.5E+400, "f": 0.1000000000000000055511151231257827}'), NO, NO);
    expect(rows.filter((r) => r.role === 'leaf').map((r) => r.text)).toEqual(['12345678901234567890', '248.00', '-1.5E+400', '0.1000000000000000055511151231257827']);
  });

  test('unix time under a time-like key: "2026-11-04 18:28 · unix time" in their zone (Settings › Times)', () => {
    const rows = jsonRows(BOARD_TREE, NO, NO, { zone: ROME });
    expect(row(rows, P('created'))?.hint).toBe('2026-11-04 18:28 · unix time');
    expect(row(rows, P('data', 'object', 'amount_due'))?.hint).toBeNull();
    expect(row(jsonRows(BOARD_TREE, NO, NO, { zone: { times: 'utc' } }), P('created'))?.hint).toBe('2026-11-04 17:28 · unix time');
    expect(unixHint(1793813327, ROME)).toBe('2026-11-04 18:28 · unix time');
  });

  test('an open array says how many items; a folded container previews what it holds', () => {
    const rows = jsonRows(BOARD_TREE, new Set([idOf(P('data', 'object', 'lines')), idOf(P('data', 'object', 'lines', 'data'))]), NO);
    expect(head(rows, P('data', 'object', 'lines', 'data'))?.hint).toBe('2 items');
    // Items at depth 5 fold: their keys and their first string.
    expect(head(rows, P('data', 'object', 'lines', 'data', 1))?.hint).toBe('3 keys · il_1Q8f2BK9');
    const one = jsonRows(tree('{"a": {"b": {"c": {"interval": "month"}}}}'), NO, NO);
    expect(head(one, P('a', 'b', 'c'))?.hint).toBe('interval: "month"');
  });

  test('URLs (http and https only) are links with their real target; strings holding JSON offer Parse', () => {
    const rows = jsonRows(BOARD_TREE, new Set([idOf(P('data', 'object', 'metadata'))]), NO);
    expect(row(rows, P('data', 'object', 'invoice_pdf'))?.url).toBe('https://pay.example.com/in_1Q8f29K9/pdf');
    expect(row(rows, P('data', 'object', 'status'))?.url).toBeNull();
    const odd = jsonRows(tree('{"a": "javascript:alert(1)", "b": "https://x y", "c": "file:///etc/passwd"}'), NO, NO);
    expect(odd.filter((r) => r.url !== null)).toEqual([]);
    expect(row(rows, NOTES)).toMatchObject({ jsonString: true, parsed: false, parsedFromString: false, kind: 'string' });
    expect(row(rows, P('data', 'object', 'metadata', 'order_id'))?.jsonString).toBe(false);
  });

  test('a URL\'s link is its normalized target: what the browser gets, punycode for a name in another script', () => {
    expect(urlOf('https://a\\@b')).toBe('https://a/@b');
    expect(urlOf('https://bücher.example/a b'.replace(' ', ''))).toBe('https://xn--bcher-kva.example/ab');
    expect(urlOf('HTTPS://Pay.Example.com/x')).toBe('https://pay.example.com/x');
    const rows = jsonRows(tree('{"u": "https://bücher.example"}'), NO, NO);
    expect(row(rows, P('u'))).toMatchObject({ url: 'https://xn--bcher-kva.example/', text: '"https://bücher.example"' });
  });

  test('urlOf is shared/links.ts\'s isSafeUrl (main\'s openUrl checks it again) for whole-token URLs', () => {
    const corpus = [
      'http://x.io', 'https://x.io/a?b=1#c', 'HTTP://X.IO', 'HtTpS://x.io', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///etc/passwd',
      'data:text/html,<b>x</b>', 'https://x y', 'https://a\\@b', 'https://bücher.example', 'https://例え.テスト/パス', 'ftp://x.io', 'mailto:a@x.test',
      'https://', 'https:x.io', '//x.io', 'x.io', ' https://x.io', 'https://x.io ', 'https://[::1]:8080/', 'http://127.0.0.1:3000',
      // C0 controls the URL parser strips at either end, or keeps inside (percent-encoded); a NUL; DEL isn't C0.
      '\u0001https://x.io', 'https://x.io\u0001', '\u0000\u001fhttp://x.io/a', '\u001fhttps://x.io\u0000', '\u0001javascript:alert(1)',
      '\u0001file:///etc/passwd', 'https://x.io/a\u0007b', '\u0001', '\u007fhttps://x.io', '\u0001\u0002', '\u0001https:', '\u0001HTTPS://X.IO'
    ];
    for (const s of corpus) {
      // Whitespace anywhere: never a link (a value is one token); otherwise exactly what isSafeUrl takes.
      expect(urlOf(s) !== null, s).toBe(!/\s/.test(s) && isSafeUrl(s));
    }
    // What isSafeUrl takes that the row doesn't link: a URL with spaces in it, an over-long one.
    expect(isSafeUrl('https://x.io/a b')).toBe(true);
    expect(urlOf('https://x.io/a b')).toBeNull();
    expect(urlOf(`https://x.io/${'a'.repeat(9000)}`)).toBeNull();
  });

  test('a row budget: past it, "… N more" at each level still open, nothing more drawn', () => {
    const wide = tree(`{${Array.from({ length: 900 }, (_, i) => `"k${i}": {${Array.from({ length: 900 }, (_, j) => `"j${j}": ${j}`).join(', ')}}`).join(', ')}}`);
    const rows = jsonRows(wide, NO, NO, { all: true, budget: 2000 });
    expect(rows.length).toBeLessThanOrEqual(2000 + 4);
    const mores = rows.filter((r) => r.role === 'more');
    // The level that ran over (an object of 900) and the root, each with what it didn't show.
    expect(mores.length).toBe(2);
    expect(mores[mores.length - 1]).toMatchObject({ depth: 1, path: [] });
    expect(rows[rows.length - 1]).toMatchObject({ role: 'close', depth: 0 });
    // The default budget: 50,000 lines.
    expect(jsonRows(wide, NO, NO, { all: true }).length).toBeLessThanOrEqual(50_004);
  });

  test('budgetHidden: a node past the lines is the budget\'s only when every container on its way is open and it is within their "N more"', () => {
    const wide = tree(`{${Array.from({ length: 900 }, (_, i) => `"k${i}": {${Array.from({ length: 900 }, (_, j) => `"j${j}": ${j}`).join(', ')}}`).join(', ')}}`);
    const all = { folds: NO, shown: new Map<string, number>(), parsed: NO, all: true };
    // Expand all, a key past the first 2,000 lines: only a bigger budget shows it.
    expect(budgetHidden(wide, P('k3', 'j1'), { ...all, shown: new Map([['$', 900]]) })).toBe(true);
    // Past its level's "… N more" (50 items of an array at first): a bigger budget would show nothing more — no doubling.
    const long = tree(`{"arr": [${Array.from({ length: 900 }, (_, i) => i).join(', ')}]}`);
    expect(budgetHidden(long, P('arr', 700), all)).toBe(false);
    expect(budgetHidden(long, P('arr', 7), all)).toBe(true);
    expect(budgetHidden(long, P('arr', 700), { ...all, shown: new Map([[idOf(P('arr')), 750]]) })).toBe(true);
    // Under a container folded at depth 3 (not all): opening it is what shows it, not more lines.
    const deep = tree('{"a": {"b": {"c": {"d": 1}}}}');
    expect(budgetHidden(deep, P('a', 'b', 'c', 'd'), { folds: NO, shown: new Map(), parsed: NO })).toBe(false);
    expect(budgetHidden(deep, P('a', 'b', 'c', 'd'), { folds: new Set([idOf(P('a', 'b', 'c'))]), shown: new Map(), parsed: NO })).toBe(true);
  });

  test('budgetOf: the budget grown for one value goes back to the first one when another value shows', () => {
    const a = tree('{"a": 1}');
    const b = tree('{"a": 1}');
    expect(budgetOf({ tree: a, n: 200_000 }, a)).toBe(200_000);
    expect(budgetOf({ tree: a, n: 200_000 }, b)).toBe(ROW_BUDGET);
  });

  test('visiblePath: under Mask values the selection stops at its first masked key — its key is shown, nothing under it', () => {
    const t = tree('{"user": {"password": {"hash": "x", "salt": "y"}, "name": "Mara"}, "token": null, "api_key": ""}');
    expect(visiblePath(t, P('user', 'password', 'hash'), NO, secret)).toEqual(['user', 'password']);
    expect(visiblePath(t, P('user', 'name'), NO, secret)).toEqual(['user', 'name']);
    // Without the mask: the whole path.
    expect(visiblePath(t, P('user', 'password', 'hash'), NO, null)).toEqual(['user', 'password', 'hash']);
    // A secret key whose value is null or "" isn't masked (the tree shows those as they are).
    expect(visiblePath(t, P('token'), NO, secret)).toEqual(['token']);
    expect(visiblePath(t, P('api_key'), NO, secret)).toEqual(['api_key']);
    // Inside a parsed string too.
    const s = tree('{"meta": "{\\"secret\\": {\\"k\\": 1}}"}');
    expect(visiblePath(s, P('meta', 'secret', 'k'), new Set([idOf(P('meta'))]), secret)).toEqual(['meta', 'secret']);
  });

  test('a string parsed in place: its subtree marked, read losslessly, its paths going on through it', () => {
    const folds = new Set([idOf(P('data', 'object', 'metadata'))]);
    const rows = jsonRows(BOARD_TREE, folds, new Set([idOf(NOTES)]));
    expect(head(rows, NOTES)).toMatchObject({ role: 'open', parsed: true, parsedFromString: true, folded: false, text: '{', kind: 'object' });
    expect(row(rows, [...NOTES, 'gift'])).toMatchObject({ text: 'true', parsedFromString: true, depth: 5 });
    expect(row(rows, [...NOTES, 'n'])?.text).toBe('12345678901234567890');
    expect(row(rows, [...NOTES, 'msg'])?.text).toBe('"Happy birthday"');
    // Everything outside keeps its mark off.
    expect(row(rows, P('data', 'object', 'metadata', 'order_id'))?.parsedFromString).toBe(false);
    // A string that isn't whole JSON stays a string, unmarked.
    const bad = tree('{"s": "{nope"}');
    expect(row(jsonRows(bad, NO, new Set([idOf(P('s'))])), P('s'))).toMatchObject({ kind: 'string', parsed: false, parsedFromString: false });
  });

  test('Mask values on: a secret key\'s value is dots, its subtree with it; null and "" stay (jsonMaskText\'s rule)', () => {
    const t = tree('{"email": "mara@x.test", "api_key": {"id": 1, "v": "s"}, "token": null, "password": "", "plain": "ok", "deep": {"hash": 12345678901234567890}}');
    const rows = jsonRows(t, NO, NO, { secret });
    expect(row(rows, P('email'))).toMatchObject({ text: JSON.stringify(MASK), masked: true, url: null, jsonString: false });
    expect(row(rows, P('api_key'))).toMatchObject({ role: 'leaf', text: JSON.stringify(MASK), masked: true });
    expect(row(rows, P('api_key', 'id'))).toBeUndefined();
    expect(row(rows, P('token'))).toMatchObject({ text: 'null', masked: false });
    expect(row(rows, P('password'))).toMatchObject({ text: '""', masked: false });
    expect(row(rows, P('plain'))).toMatchObject({ text: '"ok"', masked: false });
    expect(row(rows, P('deep', 'hash'))).toMatchObject({ masked: true, hint: null });
    // Off: as is.
    expect(row(jsonRows(t, NO, NO), P('email'))?.text).toBe('"mara@x.test"');
    // Inside a parsed string too.
    const inner = tree('{"note": "{\\"secret\\": 1, \\"ok\\": 2}"}');
    const parsed = jsonRows(inner, NO, new Set([idOf(P('note'))]), { secret });
    expect(row(parsed, P('note', 'secret'))?.masked).toBe(true);
    expect(row(parsed, P('note', 'ok'))?.text).toBe('2');
  });

  test('a long string shows its start in the row; the whole one is copied', () => {
    const long = 'x'.repeat(5000);
    const rows = jsonRows(tree(JSON.stringify({ s: long })), NO, NO);
    expect(row(rows, P('s'))!.text.length).toBeLessThan(700);
    expect(nodeCopy(nodeAt(tree(JSON.stringify({ s: long })), P('s'), NO))).toBe(long);
  });

  test('big documents stay bounded: arrays capped, expand all too; deep nesting never overflows the stack', () => {
    const items = Array.from({ length: 100_000 }, (_, i) => `{"id": ${i}, "p": {"q": {"r": ${i}}}}`).join(',');
    const big = tree(`[${items}]`);
    // 50 items of six lines (open, id, p open, q folded, p close, close), the "… N more", the root's two lines.
    expect(jsonRows(big, NO, NO)).toHaveLength(50 * 6 + 3);
    const all = jsonRows(big, NO, NO, { all: true });
    expect(all.length).toBeLessThan(50 * 10 + 4);
    expect(all.filter((r) => r.folded)).toEqual([]);
    // A recursive walk overflows before 5,000 levels, so 6,000 catches one. Not more: each line carries its whole path,
    // so a fully open nest grows with the square of its depth — 6,000 levels are ~200 MB, 20,000 were 2.3 GB, past the
    // CI runner's 2 GB heap (the parser's own tests go deeper: json-text.test.ts).
    const deep = tree(`${'['.repeat(6_000)}1${']'.repeat(6_000)}`);
    let open: JsonRow[] = [];
    expect(() => { open = jsonRows(deep, NO, NO, { all: true }); }).not.toThrow();
    expect(open).toHaveLength(12_001);
  });
});

describe('findHits', () => {
  const rows = jsonRows(tree('{"status": "paid", "type": "invoice.PAID", "unit_amount": 4900, "n": null, "ok": true, "list": [1, 2]}'), NO, NO);
  test('keys and values, any case; close rows never; in order', () => {
    expect(findHits(rows, 'paid').map((i) => rows[i]!.key)).toEqual(['status', 'type']);
    expect(findHits(rows, 'UNIT').map((i) => rows[i]!.key)).toEqual(['unit_amount']);
    expect(findHits(rows, '4900').map((i) => rows[i]!.key)).toEqual(['unit_amount']);
    expect(findHits(rows, 'null').map((i) => rows[i]!.key)).toEqual(['n']);
    expect(findHits(rows, ']')).toEqual([]);
    expect(findHits(rows, '  ')).toEqual([]);
    expect(findHits(rows, '')).toEqual([]);
  });
  test('a masked value is never found by what it hides, only by its key', () => {
    const m = jsonRows(tree('{"email": "mara@x.test"}'), NO, NO, { secret });
    expect(findHits(m, 'mara')).toEqual([]);
    expect(findHits(m, 'email')).toHaveLength(1);
  });
});

describe('find over the tree (not the rows): folded and unshown nodes found, step by step', () => {
  test('hits in document order, inside folded containers and parsed strings, masks respected', () => {
    const f = startFind(BOARD_TREE, 'unit_amount', new Set(), null);
    while (!f.step(10_000));
    expect(f.hits).toEqual([P('data', 'object', 'lines', 'data', 0, 'price', 'unit_amount'), P('data', 'object', 'lines', 'data', 1, 'price', 'unit_amount')]);
    const g = startFind(BOARD_TREE, 'birthday', new Set([idOf(NOTES)]), null);
    while (!g.step(10_000));
    expect(g.hits).toEqual([[...NOTES, 'msg']]);
    // Not parsed: the string itself holds it.
    const h = startFind(BOARD_TREE, 'birthday', new Set(), null);
    while (!h.step(10_000));
    expect(h.hits).toEqual([NOTES]);
    const m = startFind(BOARD_TREE, 'mara', new Set(), secret);
    while (!m.step(10_000));
    expect(m.hits).toEqual([]);
  });

  test('incremental: a budget per step, the same hits as one go; capped at 5,000 hits', () => {
    const big = tree(`[${Array.from({ length: 20_000 }, (_, i) => `{"k": "v${i % 7}"}`).join(',')}]`);
    const once = startFind(big, 'v3', NO, null);
    expect(once.step(1e9)).toBe(true);
    const slow = startFind(big, 'v3', NO, null);
    let steps = 0;
    while (!slow.step(1000)) steps++;
    expect(steps).toBeGreaterThan(10);
    expect(slow.hits).toEqual(once.hits);
    const many = startFind(big, 'v', NO, null);
    while (!many.step(1e9));
    expect(many.hits).toHaveLength(5000);
    expect(many.capped).toBe(true);
  });

  test('revealPath opens its ancestors and shows far items, so the hit has a row', () => {
    const path = P('data', 'object', 'lines', 'data', 1, 'price', 'unit_amount');
    expect(head(jsonRows(BOARD_TREE, NO, NO), path)).toBeUndefined();
    const r = revealPath(BOARD_TREE, path, { folds: NO, shown: new Map(), parsed: NO });
    expect(head(jsonRows(BOARD_TREE, r.folds, NO, { shown: r.shown }), path)).toBeDefined();
    // A default-open ancestor the user folded opens again.
    const r2 = revealPath(BOARD_TREE, P('data', 'object', 'status'), { folds: new Set([idOf(P('data'))]), shown: new Map(), parsed: NO });
    expect(head(jsonRows(BOARD_TREE, r2.folds, NO), P('data', 'object', 'status'))).toBeDefined();
    const big = tree(`[${Array.from({ length: 3000 }, (_, i) => i).join(',')}]`);
    const r3 = revealPath(big, P(2500), { folds: NO, shown: new Map(), parsed: NO });
    expect(head(jsonRows(big, r3.folds, NO, { shown: r3.shown }), P(2500))).toBeDefined();
  });
});

describe('tableOf', () => {
  test('an array of objects: the union of keys in order of appearance, a missing key undefined', () => {
    const t = tableOf(tree('[{"a": 1, "b": 2}, {"b": 3, "c": 12345678901234567890}]'))!;
    expect(t.columns).toEqual(['a', 'b', 'c']);
    expect(t.rows.map((r) => r.map((v) => (v instanceof JsonNum ? v.text : v)))).toEqual([['1', '2', undefined], [undefined, '3', '12345678901234567890']]);
  });
  test('Mask values on: a table under a secret key is refused — the nearest one outside it is taken —, a cell on a secret path is dots', () => {
    const t = tree('{"api_keys": [{"name": "prod", "key": "sk_live_1"}], "teams": [{"name": "a", "api_keys": [{"key": "sk_live_2"}]}]}');
    expect(tableTargetOf(t, P('api_keys', 0, 'name'), NO, null)).toEqual(['api_keys']);
    expect(tableTargetOf(t, P('api_keys', 0, 'name'), NO, secret)).toBe('masked');
    expect(tableTargetOf(t, P('teams', 0, 'api_keys', 0), NO, secret)).toEqual(['teams']);
    expect(tableTargetOf(t, P('teams', 0), NO, secret)).toEqual(['teams']);
    expect(tableTargetOf(t, [], NO, secret)).toBeNull();
    // A cell: masked when its column's key or any key above it names a secret; null and "" stay.
    expect(tableCell('sk_live_1', P('api_keys', 0, 'key'), secret)).toEqual({ text: MASK, cls: 'is-mask' });
    expect(tableCell('x', P('teams', 0, 'token'), secret)).toEqual({ text: MASK, cls: 'is-mask' });
    expect(tableCell(null, P('teams', 0, 'token'), secret)).toEqual({ text: 'null', cls: 'is-l' });
    expect(tableCell('a', P('teams', 0, 'name'), secret)).toEqual({ text: 'a', cls: 'is-s' });
    expect(tableCell('a', P('teams', 0, 'name'), null)).toEqual({ text: 'a', cls: 'is-s' });
    expect(tableCell(new JsonNum('12345678901234567890'), P('t', 0, 'n'), secret)).toEqual({ text: '12345678901234567890', cls: 'is-n' });
    expect(tableCell(tree('[1, 2]'), P('t', 0, 'l'), null)).toEqual({ text: '[…2]', cls: 'is-fo' });
    expect(tableCell(undefined, P('t', 0, 'l'), null)).toEqual({ text: '', cls: 'is-none' });
  });
  test('anything else: null', () => {
    expect(tableOf(tree('[]'))).toBeNull();
    expect(tableOf(tree('[{"a": 1}, 2]'))).toBeNull();
    expect(tableOf(tree('[[1]]'))).toBeNull();
    expect(tableOf(tree('{"a": [{"b": 1}]}'))).toBeNull();
    expect(tableOf(tree('"x"'))).toBeNull();
  });
});

describe('paths, SQL, filters and JSON columns of a node', () => {
  const UNIT = P('data', 'object', 'lines', 'data', 0, 'price', 'unit_amount');
  const parsed = new Set([idOf(NOTES)]);
  test('Path and SQL, from the column: a JSON column\'s base path first', () => {
    expect(jsonPathText([], UNIT, NO)).toBe('data.object.lines.data[0].price.unit_amount');
    expect(jsonPathSql('payload', [], UNIT, NO)).toBe(`"payload" #>> '{data,object,lines,data,0,price,unit_amount}'`);
    expect(jsonPathText([], [], NO)).toBe('');
    expect(jsonPathSql('payload', [], [], NO)).toBe('"payload"');
    expect(jsonPathText(P('data', 'object'), P('status'), NO)).toBe('data.object.status');
    expect(jsonPathSql('payload', P('data', 'object'), [], NO)).toBe(`"payload" #>> '{data,object}'`);
    expect(jsonPathSql('payload', P('data', 'object'), P('status'), NO)).toBe(`"payload" #>> '{data,object,status}'`);
  });
  test('inside a parsed string: the string read as jsonb, then the path in it', () => {
    expect(jsonPathText([], [...NOTES, 'gift'], parsed)).toBe('JSON.parse(data.object.metadata.notes_json).gift');
    expect(jsonPathSql('payload', [], [...NOTES, 'gift'], parsed)).toBe(`("payload" #>> '{data,object,metadata,notes_json}')::jsonb #>> '{gift}'`);
    expect(jsonPathText([], NOTES, parsed)).toBe('JSON.parse(data.object.metadata.notes_json)');
    expect(jsonPathSql('payload', [], NOTES, parsed)).toBe(`("payload" #>> '{data,object,metadata,notes_json}')::jsonb`);
    // A root string parsed (a JSON column whose value is a string of JSON).
    expect(jsonPathSql('raw', [], P(0), new Set([idOf([])]))).toBe(`("raw" #>> '{}')::jsonb #>> '{0}'`);
    expect(jsonPathText([], P(0), new Set([idOf([])]))).toBe('JSON.parse($)[0]');
  });
  test('Filter: rows where this path equals this value (as #>> prints it); null: is JSON null; containers: the path exists', () => {
    const t = tree('{"s": "paid", "n": 12345678901234567890, "b": false, "z": null, "o": {"a": 1}, "l": [1]}');
    expect(nodeFilter('meta', [], P('s'), nodeAt(t, P('s'), NO), NO)).toEqual({ column: 'meta', path: ['s'], op: 'pathEq', values: ['paid'] });
    expect(nodeFilter('meta', [], P('n'), nodeAt(t, P('n'), NO), NO)).toEqual({ column: 'meta', path: ['n'], op: 'pathEq', values: ['12345678901234567890'] });
    expect(nodeFilter('meta', [], P('b'), nodeAt(t, P('b'), NO), NO)).toEqual({ column: 'meta', path: ['b'], op: 'pathEq', values: ['false'] });
    expect(nodeFilter('meta', [], P('z'), null, NO)).toEqual({ column: 'meta', path: ['z'], op: 'pathNull', values: [] });
    expect(nodeFilter('meta', [], P('o'), nodeAt(t, P('o'), NO), NO)).toEqual({ column: 'meta', path: ['o'], op: 'pathExists', values: [] });
    expect(nodeFilter('meta', P('x'), P(0), nodeAt(t, P('l', 0), NO), NO)).toEqual({ column: 'meta', path: ['x', 0], op: 'pathEq', values: ['1'] });
    // Never: the whole value, a path inside a parsed string, past main's bounds.
    expect(nodeFilter('meta', [], [], t, NO)).toBeNull();
    expect(nodeFilter('payload', [], [...NOTES, 'gift'], true, parsed)).toBeNull();
    expect(nodeFilter('meta', [], Array.from({ length: 17 }, (_, i) => `k${i}`), 'x', NO)).toBeNull();
    expect(nodeFilter('meta', [], P('s'), 'x'.repeat(10_001), NO)).toBeNull();
    expect(nodeFilter('meta', [], P('s'), 'a\0b', NO)).toBeNull();
  });
  test('+ Column: its column and the whole path; never the whole value or inside a parsed string', () => {
    expect(nodeDerived('payload', [], UNIT, NO)).toEqual({ column: 'payload', path: UNIT });
    expect(nodeDerived('payload', P('data'), P('object'), NO)).toEqual({ column: 'payload', path: ['data', 'object'] });
    expect(nodeDerived('payload', [], [], NO)).toBeNull();
    expect(nodeDerived('payload', [], [...NOTES, 'gift'], parsed)).toBeNull();
    expect(nodeDerived('payload', [], Array.from({ length: 17 }, (_, i) => `k${i}`), NO)).toBeNull();
  });
  test('the breadcrumb: keys and [indexes]', () => {
    expect(crumbs(UNIT)).toEqual(['data', 'object', 'lines', 'data', '[0]', 'price', 'unit_amount']);
  });
  test('nodeAt goes through parsed strings; a path that isn\'t there is undefined', () => {
    expect(nodeAt(BOARD_TREE, [...NOTES, 'gift'], parsed)).toBe(true);
    expect((nodeAt(BOARD_TREE, [...NOTES, 'n'], parsed) as JsonNum).text).toBe('12345678901234567890');
    expect(nodeAt(BOARD_TREE, [...NOTES, 'gift'], NO)).toBeUndefined();
    expect(nodeAt(BOARD_TREE, P('nope', 0), NO)).toBeUndefined();
  });
});

describe('copies', () => {
  const t = tree('{"s": "paid", "n": 12345678901234567890, "o": {"price": 248.00, "token": "abc", "l": [1, -1.5E+400], "z": null}}');
  test('a string its text; a number as written; a container pretty-printed (2 spaces), numbers exact', () => {
    expect(nodeCopy(nodeAt(t, P('s'), NO))).toBe('paid');
    expect(nodeCopy(nodeAt(t, P('n'), NO))).toBe('12345678901234567890');
    expect(nodeCopy(null)).toBe('null');
    expect(nodeCopy(nodeAt(t, P('o'), NO))).toBe('{\n  "price": 248.00,\n  "token": "abc",\n  "l": [\n    1,\n    -1.5E+400\n  ],\n  "z": null\n}');
  });
  test('masked: the secret keys\' values as dots, a masked node itself as dots', () => {
    expect(nodeCopy(nodeAt(t, P('o'), NO), secret)).toContain(`"token": ${JSON.stringify(MASK)}`);
    expect(nodeCopy(nodeAt(t, P('o'), NO), secret)).not.toContain('abc');
    expect(nodeCopy('abc', secret, true)).toBe(MASK);
  });
  test('prettyJson stops at a budget and says it did', () => {
    const big = tree(`[${Array.from({ length: 10_000 }, (_, i) => i).join(',')}]`);
    const p = prettyJson(big, { max: 1000 });
    expect(p.cut).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(1100);
    expect(prettyJson(tree('[1]'), { max: 1000 })).toEqual({ text: '[\n  1\n]', cut: false });
  });
});

describe('the tree\'s keys', () => {
  const rows = jsonRows(tree('{"a": {"b": 1}, "u": "https://x.io/a", "l": [1, 2, 3, 4]}'), NO, NO, { maxItems: 2 });
  const at = (pred: (r: JsonRow) => boolean) => rows.findIndex(pred);
  const A = at((r) => r.key === 'a' && r.role === 'open');
  test('↓/↑ move over every row but closing ones; Home and End', () => {
    const B = at((r) => r.key === 'b');
    expect(treeKey('ArrowDown', rows, A)).toEqual({ kind: 'move', to: B });
    // Past b comes a's closing brace: skipped.
    expect(treeKey('ArrowDown', rows, B)).toEqual({ kind: 'move', to: at((r) => r.key === 'u') });
    expect(treeKey('ArrowUp', rows, at((r) => r.key === 'u'))).toEqual({ kind: 'move', to: B });
    expect(treeKey('Home', rows, B)).toEqual({ kind: 'move', to: 0 });
    expect(treeKey('End', rows, 0)).toEqual({ kind: 'move', to: at((r) => r.role === 'more') });
    expect(treeKey('ArrowUp', rows, 0)).toBeNull();
    expect(treeKey('ArrowDown', rows, -1)).toEqual({ kind: 'move', to: 0 });
  });
  test('← folds an open container, else goes to its parent; → unfolds, then goes in', () => {
    expect(treeKey('ArrowLeft', rows, A)).toEqual({ kind: 'toggle', id: idOf(['a']) });
    expect(treeKey('ArrowLeft', rows, at((r) => r.key === 'b'))).toEqual({ kind: 'move', to: A });
    expect(treeKey('ArrowRight', rows, A)).toEqual({ kind: 'move', to: at((r) => r.key === 'b') });
    const folded = jsonRows(tree('{"a": {"b": 1}}'), new Set([idOf(['a'])]), NO);
    expect(treeKey('ArrowRight', folded, 1)).toEqual({ kind: 'toggle', id: idOf(['a']) });
    expect(treeKey('ArrowRight', rows, at((r) => r.key === 'u'))).toBeNull();
  });
  test('Enter opens a URL in the browser, toggles a container, shows more items', () => {
    expect(treeKey('Enter', rows, at((r) => r.key === 'u'))).toEqual({ kind: 'url', url: 'https://x.io/a' });
    expect(treeKey('Enter', rows, A)).toEqual({ kind: 'toggle', id: idOf(['a']) });
    expect(treeKey('Enter', rows, at((r) => r.role === 'more'))).toEqual({ kind: 'more', id: idOf(['l']) });
    expect(treeKey('Enter', rows, at((r) => r.key === 'b'))).toBeNull();
  });
});

describe('Copy Column as JSON Lines', () => {
  test('a line per row: the value as Postgres printed it (numbers exact), NULL as null, a multi-line json value on one line', () => {
    const r = columnJsonLines([{ v: '{"a": 12345678901234567890}' }, { v: null }, { v: '{\n  "b": "x\\ny",\n  "c": [1, 2]\n}' }], { masked: false, column: false });
    expect(r).toEqual({ text: '{"a": 12345678901234567890}\nnull\n{"b":"x\\ny","c":[1,2]}', cut: 0 });
  });
  test('masks: secret keys\' values as dots, a masked column\'s every value; values cut at 64 KB counted', () => {
    const m = columnJsonLines([{ v: '{"email": "a@x.test", "ok": 1}' }, { v: '{"cut": "x', cut: 70_000 }], { masked: true, column: false });
    expect(m.text).toBe(`{"email": ${JSON.stringify(MASK)}, "ok": 1}\n${JSON.stringify(MASK)}`);
    expect(m.cut).toBe(1);
    expect(columnJsonLines([{ v: '{"a": 1}' }, { v: null }], { masked: true, column: true }).text).toBe(`${JSON.stringify(MASK)}\nnull`);
  });
  test('oneLine leaves strings alone and drops only the whitespace between tokens', () => {
    expect(oneLine('{ "a b" : [ 1 ,\t2 ] }')).toBe('{ "a b" : [ 1 ,\t2 ] }');
    expect(oneLine('{\n "a b" : "c\\"\\n d"\n}')).toBe('{"a b":"c\\"\\n d"}');
  });
  test('utf8Bytes: a value\'s size as Postgres stores its text', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('日本')).toBe(6);
    expect(utf8Bytes('😀')).toBe(4);
  });
});

describe('lineMenu: a tree line\'s right-click menu (Shift+F10), its hover actions as Title Case items', () => {
  const rows = jsonRows(tree('{"s": "https://x.io", "n": null, "o": {"a": 1}, "j": "{\\"k\\": 1}"}'), NO, NO);
  const ids = (items: ReturnType<typeof lineMenu>) => items.map((i) => (i === 'sep' ? '-' : `${i.id}${i.disabled ? '!' : ''}${i.checked ? '✓' : ''}`));
  const ok = { hasPath: true, reach: true, shown: false };
  test('Copy Value, Copy Path, Copy SQL; Filter (equals, or exists for null and containers), Add as Column; a URL\'s Open Link; Parse', () => {
    const s = lineMenu(row(rows, P('s'))!, ok);
    expect(ids(s)).toEqual(['copy', 'path', 'sql', '-', 'filter', 'column', '-', 'url']);
    expect(s.map((i) => (i === 'sep' ? '-' : i.label))).toEqual(['Copy Value', 'Copy Path', 'Copy SQL', '-', 'Filter by This Value', 'Add as Column', '-', 'Open Link']);
    // A JSON null is a value like any other (is JSON null); a container's filter says what it does.
    expect(lineMenu(row(rows, P('n'))!, ok).find((i) => i !== 'sep' && i.id === 'filter')).toMatchObject({ label: 'Filter by This Value' });
    expect(lineMenu(head(rows, P('o'))!, ok).find((i) => i !== 'sep' && i.id === 'filter')).toMatchObject({ label: 'Filter Where This Path Exists' });
    expect(ids(lineMenu(row(rows, P('j'))!, ok))).toEqual(['copy', 'path', 'sql', '-', 'filter', 'column', '-', 'parse']);
  });
  test('off, with why: the whole value has no path; a column already, checked; out of reach (inside a parsed string)', () => {
    expect(ids(lineMenu(rows[0]!, { hasPath: false, reach: false, shown: false }))).toEqual(['copy', 'path!', 'sql', '-', 'filter!', 'column!']);
    expect(ids(lineMenu(row(rows, P('s'))!, { ...ok, shown: true }))).toContain('column!✓');
    const inner = jsonRows(tree('{"j": "{\\"k\\": 1}"}'), NO, new Set([idOf(P('j'))]));
    const k = lineMenu(row(inner, P('j', 'k'))!, { hasPath: true, reach: false, shown: false });
    expect(k.find((i) => i !== 'sep' && i.id === 'filter')).toMatchObject({ disabled: true, tip: 'Inside a parsed string: a filter or a column can’t reach it' });
    expect(ids(lineMenu(head(inner, P('j'))!, ok))).toContain('unparse');
  });
  test('a masked URL is no link', () => {
    const m = jsonRows(tree('{"token": "https://x.io/?t=secret"}'), NO, NO, { secret });
    expect(ids(lineMenu(row(m, P('token'))!, ok))).not.toContain('url');
  });
});

describe('the views\' own keys (6)', () => {
  test('a scroller\'s keys stay in it (Table, Raw: ↑/↓ scroll there, never the inspector\'s rows)', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']) expect(scrollKey(k), k).toBe(true);
    for (const k of ['Escape', 'Tab', 'Enter', 'a']) expect(scrollKey(k), k).toBe(false);
  });
  test('Esc clears the find first only where the find shows (the Tree) and holds something', () => {
    expect(escClearsFind('tree', 'paid')).toBe(true);
    expect(escClearsFind('tree', '')).toBe(false);
    expect(escClearsFind('table', 'paid')).toBe(false);
    expect(escClearsFind('raw', 'paid')).toBe(false);
  });
});

describe('colMenuItems: the column menu\'s items', () => {
  test('a JSON column: its key profile first (the view\'s), then Filter by Key…, Sort by Key…, the sorts, Hide, the copies, Wrap Cells', () => {
    expect(colMenuItems({ json: true, derived: false })).toEqual(['filter-key', 'sort-key', 'sep', 'sort-asc', 'sort-desc', 'sep', 'hide', 'copy-name', 'copy-lines', 'sep', 'wrap']);
  });
  test('any other column: Sort Ascending, Sort Descending, Filter…, Hide Column, Copy Column Name; a JSON column (derived) Remove Column', () => {
    expect(colMenuItems({ json: false, derived: false })).toEqual(['sort-asc', 'sort-desc', 'filter', 'sep', 'hide', 'copy-name', 'sep', 'wrap']);
    expect(colMenuItems({ json: false, derived: true })).toEqual(['sort-asc', 'sort-desc', 'filter', 'sep', 'remove', 'copy-name', 'sep', 'wrap']);
  });
});

describe('columnProfile: "Keys in these N rows"', () => {
  const vals = [
    '{"id": "e1", "created": 1793813327, "big": 12345678901234567890, "customer": {"email": "a@x.test", "name": "A"}, "api_key": {"v": 1}}',
    '{"id": "e2", "created": 1793813400, "big": 2, "customer": {"email": "b@x.test"}}',
    null,
    '"just a string"',
    '{"cut": "this value was cut at 64 K'
  ];
  test('over the objects read losslessly: kinds (unix time, numbers), presence, how many rows were read', () => {
    const p = columnProfile(vals, false);
    expect(p.read).toBe(5);
    expect(p.objects).toBe(2);
    const by = (path: string) => p.stats.find((s) => s.path.join('.') === path);
    expect(by('created')).toMatchObject({ kind: 'unix', present: 2 });
    expect(by('big')).toMatchObject({ kind: 'number', present: 2 });
    expect(by('customer.email')).toMatchObject({ kind: 'string', present: 2 });
    expect(by('customer.name')).toMatchObject({ kind: 'string', present: 1 });
    expect(by('api_key.v')).toMatchObject({ kind: 'number', present: 1 });
  });
  test('Mask values on: a secret key says masked, its subtree isn\'t walked', () => {
    const p = columnProfile(vals, true);
    const by = (path: string) => p.stats.find((s) => s.path.join('.') === path);
    expect(by('customer.email')?.kind).toBe('masked');
    expect(by('api_key')?.kind).toBe('masked');
    expect(by('api_key.v')).toBeUndefined();
  });
  test('labels: pathText\'s segments, the prefix dim — a key "a.b" is not the path a.b', () => {
    expect(profileLabel(['data', 'object', 'status'])).toEqual({ pre: 'data.object.', leaf: 'status' });
    expect(profileLabel(['a.b'])).toEqual({ pre: '', leaf: '["a.b"]' });
    expect(profileLabel(['a', 'b'])).toEqual({ pre: 'a.', leaf: 'b' });
    expect(profileLabel(['x y', 'z'])).toEqual({ pre: '["x y"].', leaf: 'z' });
    expect(profileLabel(['a', 'b c'])).toEqual({ pre: 'a', leaf: '["b c"]' });
  });

  test('reads at most so many rows and characters (a page of big values stays quick)', () => {
    const many = Array.from({ length: 50 }, (_, i) => `{"k${i}": 1}`);
    expect(columnProfile(many, false, { maxRows: 10 }).read).toBe(10);
    expect(columnProfile(many, false, { maxChars: 30 }).read).toBeLessThan(5);
  });
});
