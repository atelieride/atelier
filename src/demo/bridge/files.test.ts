import { describe, expect, test, vi } from 'vitest';
import type { Stamp } from '@shared/files';
import { compileWorld } from '../compile/index';
import { createClock } from '../engine/clock';
import { createDemo } from './index';

// files.* writes in the demo: main's fs/write.ts semantics on the in-memory tree — the
// conflict check on content, no file created by a plain save, names validated, "x copy.ts", folders that stay when
// emptied — and every change through the worktree (fsChanged, then git).

const compiled = compileWorld();
const root = compiled.project.root;
const abs = (rel: string) => `${root}/${rel}`;
const make = () => {
  let now = compiled.t0;
  const d = createDemo(compiled, { version: '0.0.0-test', now: () => now, clock: createClock() });
  return { ...d, tick: (ms: number) => { now += ms; } };
};
const stampOf = async (api: ReturnType<typeof make>['api'], rel: string): Promise<Stamp> => {
  const c = await api.files.read(abs(rel));
  if (c.kind !== 'text') throw new Error(c.kind);
  return { mtimeMs: c.mtimeMs, size: c.size, hash: c.hash };
};

describe('save', () => {
  test('against the stamp it was read with: written, a new stamp (read agrees), fsChanged then git with the change', async () => {
    const { api, events, tick } = make();
    const order: string[] = [];
    events.on.fsChanged((p) => order.push(`fs ${p.join(',')}`));
    events.on.git((r) => order.push(`git ${r[0]!.changes.map((c) => c.rel).join(',')}`));
    const base = await stampOf(api, 'README.md');
    tick(5000);
    const r = await api.files.save(abs('README.md'), '# acme\n', base, 'lf');
    expect(r).toEqual({ kind: 'saved', stamp: await stampOf(api, 'README.md') });
    expect(r.kind === 'saved' && r.stamp.mtimeMs).toBe(compiled.t0 + 5000);
    expect((await api.files.read(abs('README.md'))).kind === 'text' && (await api.files.read(abs('README.md')) as { text: string }).text).toBe('# acme\n');
    expect(order[0]).toBe(`fs ${abs('README.md')}`);
    expect(order[1]).toMatch(/^git .*README\.md/);
  });

  test('the file changed since (Claude wrote): a conflict with what is there now and its stamp; Keep Mine writes against it', async () => {
    const { api, context } = make();
    const base = await stampOf(api, 'src/billing/invoice.ts');
    context.worktree.write('src/billing/invoice.ts', 'claude was here\n');
    const r = await api.files.save(abs('src/billing/invoice.ts'), 'mine\n', base, 'lf');
    expect(r).toEqual({ kind: 'conflict', disk: 'claude was here\n', stamp: await stampOf(api, 'src/billing/invoice.ts') });
    expect(context.state.files['src/billing/invoice.ts']).toBe('claude was here\n');
    expect(await api.files.save(abs('src/billing/invoice.ts'), 'mine\n', base, 'lf', true)).toMatchObject({ kind: 'conflict' });
    if (r.kind === 'conflict') expect(await api.files.save(abs('src/billing/invoice.ts'), 'mine\n', r.stamp, 'lf')).toMatchObject({ kind: 'saved' });
    expect(context.state.files['src/billing/invoice.ts']).toBe('mine\n');
  });

  test('CRLF restored on save; a deleted file is not recreated unless forced; outside the project or in .git refused', async () => {
    const { api, context } = make();
    await api.files.save(abs('README.md'), 'a\nb\n', null, 'crlf');
    expect(context.state.files['README.md']).toBe('a\r\nb\r\n');
    context.worktree.write('README.md', null);
    expect(await api.files.save(abs('README.md'), 'x', null, 'lf')).toEqual({ kind: 'error', reason: 'missing' });
    expect(await api.files.save(abs('README.md'), 'x', null, 'lf', true)).toMatchObject({ kind: 'saved' });
    expect(await api.files.save('/etc/hosts', 'x', null, 'lf')).toEqual({ kind: 'error', reason: 'outside' });
    expect(await api.files.save(abs('.git/config'), 'x', null, 'lf', true)).toEqual({ kind: 'error', reason: 'outside' });
    expect(await api.files.save(abs('src'), 'x', null, 'lf')).toEqual({ kind: 'error', reason: 'not-a-file' });
  });
});

describe('create, save as', () => {
  test('a new empty file, listed and indexed; a name taken or invalid is refused', async () => {
    const { api, context } = make();
    const fs = vi.fn();
    context.events.on.fsChanged(fs);
    expect(await api.files.create(abs('src/auth'), 'roles.ts', 'file')).toEqual({ path: abs('src/auth/roles.ts') });
    expect(context.state.files['src/auth/roles.ts']).toBe('');
    expect(fs).toHaveBeenCalledWith([abs('src/auth/roles.ts')]);
    expect((await api.files.list(abs('src/auth'), false)).map((e) => e.name)).toContain('roles.ts');
    expect(await api.files.create(abs('src/auth'), 'roles.ts', 'file')).toEqual({ error: 'exists' });
    expect(await api.files.create(abs('src'), 'auth', 'folder')).toEqual({ error: 'exists' });
    for (const bad of ['', 'a/b', '..', '.git']) expect(await api.files.create(root, bad, 'file')).toEqual({ error: 'invalid-name' });
    expect(await api.files.create(abs('nope'), 'x.ts', 'file')).toEqual({ error: 'missing' });
  });

  test('an empty folder shows in the tree and can hold a new file', async () => {
    const { api } = make();
    expect(await api.files.create(root, 'docs', 'folder')).toEqual({ path: abs('docs') });
    expect((await api.files.list(root, false)).find((e) => e.name === 'docs')).toMatchObject({ dir: true, rel: 'docs' });
    expect(await api.files.list(abs('docs'), false)).toEqual([]);
    expect(await api.files.create(abs('docs'), 'notes.md', 'file')).toEqual({ path: abs('docs/notes.md') });
  });

  test('save as: a new file in an existing folder, never over one', async () => {
    const { api, context } = make();
    expect(await api.files.saveAs('src/todo.md', '- ship\n')).toEqual({ path: abs('src/todo.md') });
    expect(context.state.files['src/todo.md']).toBe('- ship\n');
    expect(await api.files.saveAs('src/todo.md', 'x')).toEqual({ error: 'exists' });
    expect(await api.files.saveAs('nope/todo.md', 'x')).toEqual({ error: 'missing-folder' });
    expect(await api.files.saveAs('/tmp/x', 'x')).toEqual({ error: 'absolute' });
    expect(await api.files.saveAs('../x', 'x')).toEqual({ error: 'outside' });
    expect(await api.files.saveAs('.git/x', 'x')).toEqual({ error: 'in-git' });
  });

  test('save as outside the project: no save panel in a browser — the page says so, nothing is written', async () => {
    const { api, context } = make();
    const before = { ...context.state.files };
    expect(await api.files.saveAsOutside('todo.md', 'x', [])).toEqual({ canceled: true });
    expect(context.state.files).toEqual(before);
  });
});

describe('rename, duplicate, trash', () => {
  test('rename a file in its folder; the old path is gone, the folder stays even when emptied', async () => {
    const { api, context } = make();
    const text = context.state.files['prisma/schema.prisma'];
    expect(await api.files.rename(abs('prisma/schema.prisma'), 'orders.prisma')).toEqual({ path: abs('prisma/orders.prisma') });
    expect(context.state.files['prisma/orders.prisma']).toBe(text);
    expect(context.state.files['prisma/schema.prisma']).toBeUndefined();
    expect(await api.files.rename(abs('prisma/orders.prisma'), 'orders.prisma')).toEqual({ path: abs('prisma/orders.prisma') });
    expect(await api.files.rename(abs('README.md'), 'package.json')).toEqual({ error: 'exists' });
    await api.files.trash(abs('prisma/orders.prisma'));
    expect((await api.files.list(root, false)).find((e) => e.name === 'prisma')).toMatchObject({ dir: true });
  });

  test('rename a folder moves everything under it', async () => {
    const { api, context } = make();
    expect(await api.files.rename(abs('src/auth'), 'identity')).toEqual({ path: abs('src/identity') });
    expect(Object.keys(context.state.files).filter((f) => f.startsWith('src/identity/')).sort()).toEqual(['src/identity/session.ts', 'src/identity/tokens.ts']);
    expect(Object.keys(context.state.files).some((f) => f.startsWith('src/auth/'))).toBe(false);
  });

  test('duplicate: "name copy.ext", then "name copy 2.ext"; folders are not duplicated', async () => {
    const { api, context } = make();
    expect(await api.files.duplicate(abs('src/billing/invoice.ts'))).toEqual({ path: abs('src/billing/invoice copy.ts') });
    expect(await api.files.duplicate(abs('src/billing/invoice.ts'))).toEqual({ path: abs('src/billing/invoice copy 2.ts') });
    expect(context.state.files['src/billing/invoice copy 2.ts']).toBe(context.state.files['src/billing/invoice.ts']);
    expect(await api.files.duplicate(abs('src'))).toEqual({ error: 'not-a-file' });
  });

  test('trash: a file or a folder and all inside (the page asked in its row); the deletion shows in Changes', async () => {
    const { api, context, events } = make();
    const git = vi.fn();
    events.on.git(git);
    // What the row's question says: a file, a folder with its files counted.
    expect(await api.files.trashInfo(abs('README.md'))).toEqual({ kind: 'file', files: 1 });
    const inSrc = Object.keys(context.state.files).filter((f) => f.startsWith('src/')).length;
    expect(inSrc).toBeGreaterThan(1);
    expect(await api.files.trashInfo(abs('src'))).toEqual({ kind: 'folder', files: inSrc });
    expect(await api.files.trashInfo(abs('nope'))).toEqual({ error: 'outside' });
    expect(await api.files.trash(abs('README.md'))).toEqual({ ok: true });
    expect(git.mock.calls.at(-1)![0][0].changes).toContainEqual(expect.objectContaining({ rel: 'README.md', kind: 'D' }));
    expect(await api.files.trash(abs('src'))).toEqual({ ok: true });
    expect(Object.keys(context.state.files).some((f) => f.startsWith('src/'))).toBe(false);
    expect((await api.files.list(root, false)).some((e) => e.name === 'src')).toBe(false);
    expect(await api.files.trash(abs('nope'))).toEqual({ error: 'outside' });
  });
});

