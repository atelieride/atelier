import { describe, expect, test } from 'vitest';
import { IPC } from '@shared/api';
import type { AdoptRequest } from '@shared/popout';
import type { DbScope } from '@shared/databases';
import { ADOPT_TIMEOUT_MS, ADOPT_WINDOW_MS, TabMover, type MoverDeps } from './tab-mover';

// Moving a file or a plain terminal to another project's window.

const A = { wcId: 1, root: '/a', popout: false };
const POP = { wcId: 7, root: '/a', popout: true };

function setup(o: Partial<MoverDeps> = {}, grants: Record<string, 'edit' | 'read'> = { '/a /out/granted.ts': 'edit', '/a /out/img.png': 'read' }) {
  const log: string[] = [];
  const asked: AdoptRequest[] = [];
  const timers: (() => void)[] = [];
  const terms: Record<string, { projectRoot: string; session: unknown }> = { t1: { projectRoot: '/a', session: null }, s1: { projectRoot: '/a', session: { sessionId: 'x' } } };
  const b = { id: 2, send: (ch: string, p?: unknown) => { log.push(`send ${ch}`); if (ch === IPC.evAdopt) asked.push(p as AdoptRequest); }, reveal: () => log.push('reveal b') };
  const deps: MoverDeps = {
    projectWindow: (root) => (root === '/b' ? b : null),
    inside: (root, p) => p.startsWith(`${root}/`),
    grantMode: (root, p) => grants[`${root} ${p}`] ?? null,
    grant: (root, p, mode) => { log.push(`grant ${root} ${p} ${mode}`); return true; },
    revoke: (root, p) => log.push(`revoke ${root} ${p}`),
    relOf: (root, p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p),
    terminal: (id) => terms[id] ?? null,
    rehome: (id, from, to) => { log.push(`rehome ${id} ${from} ${to}`); terms[id] = { ...terms[id]!, projectRoot: to }; },
    popoutKey: (wcId) => (wcId === 7 ? 'f:/a/x.ts' : null),
    closePopout: (wcId) => log.push(`close popout ${wcId}`),
    holdPopout: (wcId, on) => log.push(`hold ${wcId} ${on}`),
    poppedOut: () => false,
    setTimer: (fn) => { timers.push(fn); return { clear: () => {} }; },
    ...o
  };
  const mover = new TabMover(deps);
  /** B answers the last adopt request. */
  const answer = (ok: boolean, reason?: 'open-there', from = 2) => mover.adopted(from, { id: asked.at(-1)!.id, ok, ...(reason ? { reason } : {}) });
  return { mover, log, asked, timers, answer };
}

describe('files', () => {
  test('a project file: B is asked to adopt it (rel to B, its view mode, buffer, drop point, a deadline); once B says yes, B comes forward', async () => {
    const t = setup();
    const handoff = { path: '/a/x.ts', state: { doc: 'x', selection: null }, saved: null, stamp: null, eol: 'lf' as const, scrollTop: 0 };
    const before = Date.now();
    const p = t.mover.move(A, { to: '/b', key: 'f:/a/x.ts', payload: { kind: 'file', rel: 'x.ts', mode: 'diff' }, handoff, at: { x: 5, y: 6 } });
    await Promise.resolve();
    expect(t.asked).toEqual([{ id: expect.any(Number), key: 'f:/a/x.ts', payload: { kind: 'file', rel: '/a/x.ts', mode: 'diff' }, handoff, at: { x: 5, y: 6 }, deadline: expect.any(Number) }]);
    // B may take it only while A still waits for it (no buffer adopted after A gave up).
    expect(t.asked[0]!.deadline).toBeGreaterThanOrEqual(before + ADOPT_WINDOW_MS);
    expect(t.asked[0]!.deadline).toBeLessThan(Date.now() + ADOPT_TIMEOUT_MS);
    // Outside B: granted for B (edit, as A has it as a project file) before B is asked.
    expect(t.log.slice(0, 2)).toEqual(['grant /b /a/x.ts edit', `send ${IPC.evAdopt}`]);
    t.answer(true);
    expect(await p).toEqual({ ok: true });
    expect(t.log.at(-1)).toBe('reveal b');
  });
  test('a file A only has read-only (a Claude temp image) stays read-only in B', async () => {
    const t = setup();
    const p = t.mover.move(A, { to: '/b', key: 'f:/out/img.png' });
    await Promise.resolve();
    expect(t.log[0]).toBe('grant /b /out/img.png read');
    t.answer(true);
    await p;
  });
  test('a file A may edit that B holds only read-only (a link opened it there) becomes editable in B; refused, B keeps its read grant', async () => {
    const tmp = '/tmp/claude-501/p/s/scratchpad/draft.md';
    const t = setup({}, { [`/a ${tmp}`]: 'edit', [`/b ${tmp}`]: 'read' });
    const p = t.mover.move(A, { to: '/b', key: `f:${tmp}` });
    await Promise.resolve();
    expect(t.log[0]).toBe(`grant /b ${tmp} edit`);
    t.answer(true);
    expect(await p).toEqual({ ok: true });
    const q = t.mover.move(A, { to: '/b', key: `f:${tmp}` });
    await Promise.resolve();
    t.answer(false, 'open-there');
    await q;
    expect(t.log.slice(-2)).toEqual([`revoke /b ${tmp}`, `grant /b ${tmp} read`]);
    // The other way, A read-only and B editable: nothing to grant.
    const u = setup({}, { [`/a ${tmp}`]: 'read', [`/b ${tmp}`]: 'edit' });
    const r = u.mover.move(A, { to: '/b', key: `f:${tmp}` });
    await Promise.resolve();
    u.answer(true);
    await r;
    expect(u.log.some((l) => l.startsWith('grant') || l.startsWith('revoke'))).toBe(false);
  });

  test('a file inside B, or one B has granted already, needs no grant; its rel is B\'s', async () => {
    const t = setup({}, { '/a /b/y.ts': 'edit', '/a /out/granted.ts': 'edit', '/b /out/granted.ts': 'edit' });
    const p = t.mover.move(A, { to: '/b', key: 'f:/b/y.ts' });
    await Promise.resolve();
    expect(t.asked[0]!.payload).toEqual({ kind: 'file', rel: 'y.ts', mode: 'margin' });
    t.answer(true);
    expect(await p).toEqual({ ok: true });
    const q = t.mover.move(A, { to: '/b', key: 'f:/out/granted.ts' });
    await Promise.resolve();
    t.answer(false, 'open-there');
    await q;
    expect(t.log.some((l) => l.startsWith('grant') || l.startsWith('revoke'))).toBe(false);
  });
  test('B refuses (it shows that file, the buffer has changes): A keeps everything, the grant made for the move goes', async () => {
    const t = setup();
    const p = t.mover.move(A, { to: '/b', key: 'f:/a/x.ts' });
    await Promise.resolve();
    t.answer(false, 'open-there');
    expect(await p).toEqual({ ok: false, reason: 'refused' });
    expect(t.log).toContain('revoke /b /a/x.ts');
    expect(t.log).not.toContain('reveal b');
  });
  test('B never answers: the move fails after the timeout (the grant goes too); a late or foreign answer changes nothing', async () => {
    const t = setup();
    const p = t.mover.move(A, { to: '/b', key: 'f:/a/x.ts' });
    await Promise.resolve();
    t.answer(true, undefined, 99);
    t.timers[0]!();
    expect(await p).toEqual({ ok: false, reason: 'failed' });
    expect(t.log).toContain('revoke /b /a/x.ts');
    t.answer(true);
    expect(ADOPT_TIMEOUT_MS).toBe(3000);
  });
  test('refused before asking: an untitled buffer, a file A may not read, a grant B can\'t get, its own window, no such window', async () => {
    const t = setup({ grant: () => false });
    expect(await t.mover.move(A, { to: '/b', key: 'f:untitled-1' })).toEqual({ ok: false, reason: 'failed' });
    expect(await t.mover.move(A, { to: '/b', key: 'f:/etc/passwd' })).toEqual({ ok: false, reason: 'failed' });
    expect(await t.mover.move(A, { to: '/b', key: 'f:/out/granted.ts' })).toEqual({ ok: false, reason: 'failed' });
    expect(await t.mover.move(A, { to: '/a', key: 'f:/a/x.ts' })).toEqual({ ok: false, reason: 'failed' });
    expect(await t.mover.move(A, { to: '/c', key: 'f:/a/x.ts' })).toEqual({ ok: false, reason: 'failed' });
    expect(await t.mover.move(A, { to: '/b', key: 'services' })).toEqual({ ok: false, reason: 'failed' });
    expect(t.asked).toEqual([]);
  });
  test('from the project window, a tab that lives in one of its pop-outs never moves (its buffer is there)', async () => {
    const t = setup({ poppedOut: (root, key) => root === '/a' && key === 'f:/a/x.ts' });
    expect(await t.mover.move(A, { to: '/b', key: 'f:/a/x.ts' })).toEqual({ ok: false, reason: 'failed' });
    expect(t.mover.canMove('/a', 'f:/a/x.ts', '/b')).toBe(true);
    const p = t.mover.move(POP, { to: '/b', key: 'f:/a/x.ts' });
    await Promise.resolve();
    t.answer(true);
    expect(await p).toEqual({ ok: true });
  });
});

describe('terminals', () => {
  test('a plain terminal: its home first (lists go out), then B adopts it where it was dropped; B comes forward', async () => {
    const t = setup();
    const p = t.mover.move(A, { to: '/b', key: 't:t1', at: { x: 1, y: 2 } });
    await Promise.resolve();
    expect(t.log).toEqual(['rehome t1 /a /b', `send ${IPC.evAdopt}`]);
    expect(t.asked[0]).toEqual({ id: expect.any(Number), key: 't:t1', at: { x: 1, y: 2 }, deadline: expect.any(Number) });
    t.answer(true);
    expect(await p).toEqual({ ok: true });
    expect(t.log.at(-1)).toBe('reveal b');
  });
  test('B didn\'t take it (it never listed it, or no answer): it goes back home, the move fails', async () => {
    const t = setup();
    const p = t.mover.move(A, { to: '/b', key: 't:t1' });
    await Promise.resolve();
    t.answer(false);
    expect(await p).toEqual({ ok: false, reason: 'failed' });
    expect(t.log).toEqual(['rehome t1 /a /b', `send ${IPC.evAdopt}`, 'rehome t1 /b /a']);
  });
  test('a session never moves; nor a terminal of another project, nor one atelierd doesn\'t list', async () => {
    const t = setup();
    expect(await t.mover.move(A, { to: '/b', key: 't:s1' })).toEqual({ ok: false, reason: 'session' });
    expect(await t.mover.move({ ...A, root: '/z' }, { to: '/b', key: 't:t1' })).toEqual({ ok: false, reason: 'failed' });
    expect(await t.mover.move(A, { to: '/b', key: 't:gone' })).toEqual({ ok: false, reason: 'failed' });
    expect(t.log).toEqual([]);
  });
});

describe('from a pop-out', () => {
  test('its own tab only; held while B decides (no Move Back or drag meanwhile); once B says yes the pop-out closes for good', async () => {
    const t = setup();
    expect(await t.mover.move(POP, { to: '/b', key: 'f:/a/other.ts' })).toEqual({ ok: false, reason: 'failed' });
    const p = t.mover.move(POP, { to: '/b', key: 'f:/a/x.ts' });
    await Promise.resolve();
    expect(t.log).toContain('hold 7 true');
    t.answer(true);
    expect(await p).toEqual({ ok: true });
    expect(t.log.slice(-3)).toEqual(['hold 7 false', 'close popout 7', 'reveal b']);
  });
  test('refused: the pop-out stays, let go', async () => {
    const t = setup();
    const p = t.mover.move(POP, { to: '/b', key: 'f:/a/x.ts' });
    await Promise.resolve();
    t.answer(false, 'open-there');
    await p;
    expect(t.log).not.toContain('close popout 7');
    expect(t.log).toContain('hold 7 false');
  });
});

describe('table tabs', () => {
  const ORDERS = 'db:c0123456789ab/public/orders';
  const PAYLOAD = { kind: 'db' as const, connId: 'c0123456789ab', schema: 'public', name: 'orders', view: 'structure' as const, rel: 'view' as const };
  const scopes: Record<string, DbScope> = { c0123456789ab: { kind: 'all' }, c00000000000a: { kind: 'project', root: '/a' }, c00000000000b: { kind: 'project', root: '/b' } };
  const dbScope = (id: string) => scopes[id] ?? null;
  test('a connection shown in every project: B adopts the tab with its payload; nothing granted, nothing rehomed, B comes forward', async () => {
    const t = setup({ dbScope });
    const p = t.mover.move(A, { to: '/b', key: ORDERS, payload: PAYLOAD, at: { x: 1, y: 2 } });
    await Promise.resolve();
    expect(t.asked).toEqual([{ id: expect.any(Number), key: ORDERS, payload: PAYLOAD, at: { x: 1, y: 2 }, deadline: expect.any(Number) }]);
    t.answer(true);
    expect(await p).toEqual({ ok: true });
    expect(t.log).toEqual([`send ${IPC.evAdopt}`, 'reveal b']);
  });
  test('B didn\'t take it: the move fails, A keeps it', async () => {
    const t = setup({ dbScope });
    const p = t.mover.move(A, { to: '/b', key: ORDERS, payload: PAYLOAD });
    await Promise.resolve();
    t.answer(false);
    expect(await p).toEqual({ ok: false, reason: 'failed' });
  });
  test('refused, B never asked: a connection of one project (A\'s, even B\'s), one main doesn\'t know, a malformed key, no way to know', async () => {
    const t = setup({ dbScope });
    for (const key of ['db:c00000000000a/public/orders', 'db:c00000000000b/public/orders', 'db:c00000000000f/public/orders', 'db:c0123456789ab/public', 'db:nope']) {
      expect(t.mover.canMove('/a', key, '/b'), key).toBe(false);
      expect(await t.mover.move(A, { to: '/b', key, payload: PAYLOAD }), key).toEqual({ ok: false, reason: 'failed' });
    }
    expect(setup().mover.canMove('/a', ORDERS, '/b')).toBe(false);
    expect(t.asked).toEqual([]);
    expect(t.mover.canMove('/a', ORDERS, '/b')).toBe(true);
    expect(t.mover.canMove('/a', 'db:c0123456789ab', '/b')).toBe(true);
  });
  test('a table tab moves with its own payload only: none (B would have nothing to show), or another kind, is refused', async () => {
    const t = setup({ dbScope });
    expect(await t.mover.move(A, { to: '/b', key: ORDERS })).toEqual({ ok: false, reason: 'failed' });
    expect(await t.mover.move(A, { to: '/b', key: ORDERS, payload: { kind: 'file', rel: 'x', mode: 'margin' } })).toEqual({ ok: false, reason: 'failed' });
    expect(t.asked).toEqual([]);
  });
});

test('canMove: what a drag may offer to another window (the same rules, nothing asked)', () => {
  const t = setup();
  expect(t.mover.canMove('/a', 'f:/a/x.ts', '/b')).toBe(true);
  expect(t.mover.canMove('/a', 't:t1', '/b')).toBe(true);
  expect(t.mover.canMove('/a', 't:s1', '/b')).toBe(false);
  expect(t.mover.canMove('/a', 'f:untitled-1', '/b')).toBe(false);
  expect(t.mover.canMove('/a', 'review', '/b')).toBe(false);
  expect(t.mover.canMove('/a', 'f:/a/x.ts', '/a')).toBe(false);
  expect(t.mover.canMove('/a', 'f:/a/x.ts', '/c')).toBe(false);
  expect(t.log).toEqual([]);
});
