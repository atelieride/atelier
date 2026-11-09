import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { compileWorld } from '../compile/index';
import { createClock } from '../engine/clock';
import { createDemo } from './index';
import { notInDemo } from './not-in-demo';

vi.mock('./not-in-demo', () => ({ notInDemo: vi.fn(), NOT_IN_DEMO_EVENT: 'atelier-demo:not-in-demo' }));

// git.* and scm.* in the demo: one repository on main with origin, the world's
// history, and fetches that succeed after 600 ms with the events main sends.

const compiled = compileWorld();
const root = compiled.project.root;
const common = `${root}/.git`;
let now = compiled.t0;
const make = () => createDemo(compiled, { version: '0.0.0-test', now: () => now, clock: createClock() });

beforeEach(() => { vi.useFakeTimers(); now = compiled.t0; vi.mocked(notInDemo).mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('scm', () => {
  test('refs: main tracking origin/main, both at HEAD; a remote, so Fetch is offered; fetched 25 min ago', async () => {
    const { api } = make();
    const refs = await api.scm.refs(root);
    expect(refs.refs.map((r) => [r.name, r.kind, r.oid, r.upstream, r.current])).toEqual([
      ['refs/heads/main', 'head', compiled.headOid, 'refs/remotes/origin/main', true],
      ['refs/remotes/origin/main', 'remote', compiled.headOid, null, false]
    ]);
    expect(refs).toMatchObject({ head: { branch: 'main', oid: compiled.headOid }, remotes: ['origin'], hasRemote: true, fetchedAt: now - 25 * 60_000 });
    expect(refs.refs[0]!.date).toBe(compiled.scm.commits[0]!.committerAt);
    const [entry] = await api.scm.repos();
    expect(entry!.status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 });
  });

  test('log, commit and file come from the compiled history', async () => {
    const { api } = make();
    const page = await api.scm.log(root, { kind: 'refs', refs: 'all', firstParent: false }, 0, 400);
    expect(page.commits.map((c) => c.subject)).toEqual(['Test invoice totals', 'Add sessions, invoices and the welcome page', 'Start the Acme store']);
    const d = await api.scm.commit(root, compiled.headOid);
    expect(d.files.map((f) => f.rel)).toEqual(['tests/billing.test.ts']);
    expect(await api.scm.file(root, compiled.headOid, 'README.md')).toMatchObject({ kind: 'text', text: compiled.head['README.md'] });
    expect(await api.scm.resolve(root, compiled.headOid.slice(0, 7))).toBe(compiled.headOid);
    expect(await api.scm.locate(root, { kind: 'refs', refs: 'all', firstParent: false }, compiled.commits[0]!.oid)).toBe(2);
    expect(await api.scm.aheadBehind(root, 'refs/heads/main', 'refs/remotes/origin/main')).toEqual({ ahead: 0, behind: 0 });
  });

  test('a manual fetch: running, then after 600 ms ok, the fetch event and a fresh fetchedAt', async () => {
    const { api, events } = make();
    const seen: string[] = [];
    events.on.scmFetch((s) => seen.push(`fetch running=${s.running} last=${s.last?.outcome ?? '-'}`));
    events.on.scm((e) => seen.push(`scm ${e.what} ${e.common}`));
    const p = api.scm.fetchRepo(root, 'manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['fetch running=true last=-']);
    expect(await api.scm.fetchStates()).toEqual([{ common, running: true, last: null }]);
    now += 600;
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toEqual({ state: { common, running: false, last: { outcome: 'ok', at: now } }, outcome: 'ok' });
    expect(seen).toEqual(['fetch running=true last=-', 'fetch running=false last=ok', `scm fetch ${common}`]);
    expect((await api.scm.refs(root)).fetchedAt).toBe(now);
  });

  test('a view fetch runs only past the 10-minute gate; a manual one joins a running fetch', async () => {
    const { api } = make();
    const first = api.scm.fetchRepo(root, 'view');
    const joined = api.scm.fetchRepo(root, 'manual');
    await vi.advanceTimersByTimeAsync(600);
    expect((await first).outcome).toBe('ok');
    expect((await joined).outcome).toBe('ok');
    expect(await api.scm.fetchRepo(root, 'view')).toMatchObject({ outcome: null, state: { running: false } });
    const all = api.scm.fetchAll();
    await vi.advanceTimersByTimeAsync(600);
    expect(await all).toEqual(['ok']);
  });
});

test('git: HEAD and base contents, compare says the demo is on its default branch', async () => {
  const { api } = make();
  expect(await api.git.head(`${root}/README.md`)).toEqual({ original: compiled.head['README.md'] });
  expect(await api.git.base(`${root}/tests/billing.test.ts`, compiled.commits[0]!.oid)).toEqual({ original: null });
  expect(await api.git.base(`${root}/README.md`, compiled.commits[0]!.oid)).toEqual({ original: compiled.head['README.md'] });
  expect(await api.git.compare()).toEqual([{ root, ok: false, reason: 'on-default' }]);
});

const stages = async (api: ReturnType<typeof make>['api']) =>
  Object.fromEntries((await api.git.status())[0]!.changes.map((c) => [c.rel, c.stage]));

describe('staging: the fictional index follows the checkboxes and the menus', () => {
  test('stage one file: it is staged in the status main would send, and Changes hears it; nothing asks to download', async () => {
    const { api, events, context } = make();
    const files = { ...context.state.files };
    const heard: string[][] = [];
    const checked: number[] = [];
    events.on.git((list) => { heard.push(list[0]!.changes.filter((c) => c.stage !== 'none').map((c) => `${c.rel}:${c.stage}`)); checked.push(list[0]!.checkedAt); });
    expect(Object.values(await stages(api)).every((s) => s === 'none')).toBe(true);
    // `at`: the status it sent shows it (on the demo's clock), so the checkbox's click settles on it (stage-intents.ts).
    expect(await api.git.stage(root, ['src/auth/session.ts'])).toEqual({ outcome: 'ok', at: checked[0] });
    expect(await api.git.unstage(root, ['src/auth/session.ts'])).toEqual({ outcome: 'ok', at: checked[1] });
    await api.git.stage(root, ['src/auth/session.ts']);
    expect(await stages(api)).toEqual({ 'README.md': 'none', 'src/auth/session.ts': 'all', 'src/pages/welcome.tsx': 'none', 'tests/billing.test.ts': 'none' });
    expect(heard).toEqual([['src/auth/session.ts:all'], [], ['src/auth/session.ts:all']]);
    expect((await api.scm.status(root))!.changes.find((c) => c.rel === 'src/auth/session.ts')!.stage).toBe('all');
    // The working tree never changes, and staging is no write to block.
    expect(context.state.files).toEqual(files);
    expect(notInDemo).not.toHaveBeenCalled();
  });

  test('a staged file a session edits again is partial; staging it again makes it all', async () => {
    const { api, context } = make();
    await api.git.stage(root, ['src/auth/session.ts']);
    context.worktree.write('src/auth/session.ts', `${context.state.files['src/auth/session.ts']}// more\n`);
    expect((await stages(api))['src/auth/session.ts']).toBe('partial');
    await api.git.stage(root, ['src/auth/session.ts']);
    expect((await stages(api))['src/auth/session.ts']).toBe('all');
  });

  test("all: every change; unstage one, then all; a path that isn't a change stages nothing", async () => {
    const { api } = make();
    await api.git.stage(root, 'all');
    expect(Object.values(await stages(api))).toEqual(['all', 'all', 'all', 'all']);
    await api.git.unstage(root, ['README.md']);
    expect((await stages(api))['README.md']).toBe('none');
    expect((await stages(api))['tests/billing.test.ts']).toBe('all');
    await api.git.unstage(root, 'all');
    expect(Object.values(await stages(api)).every((s) => s === 'none')).toBe(true);
    await api.git.stage(root, ['package.json']);
    expect(Object.values(await stages(api)).every((s) => s === 'none')).toBe(true);
    expect(notInDemo).not.toHaveBeenCalled();
  });
});

describe('git writes in the demo: never a commit; each asks to download, and the app stays quiet', () => {
  test('every write that would change git calls notInDemo with its feature and answers cancelled (no toast, no failure kept)', async () => {
    const { api, context } = make();
    await api.git.stage(root, ['src/auth/session.ts']);
    const files = { ...context.state.files };
    const before = await api.git.status();
    const blocked: [string, () => Promise<unknown>][] = [
      ['Committing', () => api.git.commit({ root, message: 'feat: x', amend: false, coAuthor: true, noVerify: false })],
      ['Committing', () => api.git.commit({ root, message: 'feat: x', amend: true, coAuthor: false, noVerify: false, expectHead: compiled.headOid })],
      ['Committing', () => api.git.undoCommit(root, compiled.headOid)],
      ['Pushing', () => api.git.push({ root })],
      ['Pulling', () => api.git.pull({ root, rebase: false })],
      ['Syncing', () => api.git.sync({ root, rebase: false })],
      ['Branches', () => api.git.switchTo({ root, ref: 'refs/heads/main', carry: 'none' })],
      ['Branches', () => api.git.branchCreate({ root, name: 'feat/x', switch: true })],
      ['Branches', () => api.git.branchRename({ root, ref: 'refs/heads/main', name: 'trunk' })],
      ['Branches', () => api.git.branchDelete({ root, ref: 'refs/heads/main', force: false })],
      ['Branches', () => api.git.branchRestore({ root, name: 'x', oid: compiled.headOid })],
      ['Worktrees', () => api.git.worktreeAdd({ root, path: `${root}/.claude/worktrees/x`, newName: 'x' })],
      ['Stashes', () => api.git.stashPush({ root, message: 'wip', untracked: true, staged: false })],
      ['Stashes', () => api.git.stashApply({ root, index: 0, oid: compiled.headOid, pop: true })],
      ['Stashes', () => api.git.stashDrop({ root, index: 0, oid: compiled.headOid })],
      ['Stashes', () => api.git.stashRestore({ root, oid: compiled.headOid, message: 'wip' })]
    ];
    for (const [what, op] of blocked) {
      vi.mocked(notInDemo).mockClear();
      expect(await op(), what).toEqual({ outcome: 'cancelled', message: expect.any(String) });
      expect(vi.mocked(notInDemo).mock.calls, what).toEqual([[what]]);
    }
    expect(context.state.files).toEqual(files);
    expect(await api.git.status()).toEqual(before);
    expect((await api.scm.refs(root)).head.oid).toBe(compiled.headOid);
  });

  test("discard: asks to download; ok with the demo's own words, so the app's one toast is an info one; nothing discarded", async () => {
    const { api, context } = make();
    const files = { ...context.state.files };
    expect(await api.git.discard(root, ['README.md'])).toEqual({ outcome: 'ok', message: expect.stringMatching(/^Nothing discarded/) });
    expect(vi.mocked(notInDemo).mock.calls).toEqual([['Discarding changes']]);
    expect(context.state.files).toEqual(files);
  });

  test('Sync All: asks to download; no repository to sync (the app says every one is in sync)', async () => {
    const { api } = make();
    expect(await api.git.syncAll()).toEqual([]);
    expect(await api.git.syncAll({ skip: [root] })).toEqual([]);
    expect(vi.mocked(notInDemo).mock.calls).toEqual([['Syncing'], ['Syncing']]);
  });

  test('the reads and checks answer without asking', async () => {
    const { api } = make();
    expect(await api.git.running()).toEqual([]);
    expect(await api.git.incoming(root)).toEqual([]);
    expect(await api.git.remoteCommits(root, 3)).toEqual({ commits: [], remoteOid: null, total: 0 });
    expect(await api.git.checkBranchName(root, 'feat/x')).toBe(true);
    expect(await api.git.worktreeCheck(root, `${root}/.claude/worktrees/x`)).toEqual({ inside: true, exists: false, ignored: true });
    await expect(api.git.cancel('op')).resolves.toBeUndefined();
    expect(notInDemo).not.toHaveBeenCalled();
  });

  test('facts: a clean repository on main, pushed, with an identity; none for another root', async () => {
    const { api } = make();
    expect(await api.git.facts(root)).toMatchObject({
      root, identity: true, state: null, detached: false, branch: 'main', head: compiled.headOid, upstream: 'origin/main', headPushed: true,
      headIsMerge: false, headHasParent: true, headMessage: 'Test invoice totals', signs: false, undo: null, remotes: ['origin'],
      hooks: { preCommit: false, commitMsg: false, prePush: false }, gpgProgram: null
    });
    expect(await api.git.facts('/elsewhere')).toBeNull();
  });

  test("✦ writes for what is staged: auth-refactor's file, the docs, several sessions' work; Subject only keeps the subject", async () => {
    const { api, events } = make();
    const texts: string[] = [];
    events.on.scmMessage((e) => { if ('done' in e) texts.push(e.done.text); });
    const write = async (tweak?: { kind: 'shorter' | 'detail' | 'subject'; current: string }) => {
      await api.git.message({ root, ...(tweak ? { tweak } : {}) });
      await vi.advanceTimersByTimeAsync(2000);
      return texts.at(-1)!;
    };
    await api.git.stage(root, ['src/auth/session.ts']);
    const auth = await write();
    expect(auth).toMatch(/^refactor\(auth\): /);
    expect(auth.split('\n')[0]!.length).toBeLessThanOrEqual(72);
    expect(auth).toContain('\n\n');
    expect(await write({ kind: 'subject', current: auth })).toBe(auth.split('\n')[0]);
    await api.git.unstage(root, 'all');
    await api.git.stage(root, ['README.md']);
    expect(await write()).toMatch(/^docs: /);
    await api.git.stage(root, ['src/auth/session.ts', 'tests/billing.test.ts']);
    const several = await write();
    // One subject; the body names each piece of work.
    expect(several.split('\n')[0]).toMatch(/^\w+(\([\w-]+\))?: /);
    expect(several).toMatch(/token store/i);
    expect(several).toMatch(/rounding/i);
    expect(several).toMatch(/checkout/i);
  });

  test('✦: an id, then the canned message in three chunks and done, on the clock; cancel stops it', async () => {
    const { api, events } = make();
    const seen: string[] = [];
    events.on.scmMessage((e) => seen.push('chunk' in e ? `chunk:${e.chunk}` : 'done' in e ? `done:${e.done.text}` : `error:${e.error}`));
    const answer = await api.git.message({ root });
    expect(answer).toMatchObject({ id: expect.any(String) });
    const id = (answer as { id: string }).id;
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    const chunks = seen.filter((s) => s.startsWith('chunk:')).map((s) => s.slice(6));
    expect(chunks).toHaveLength(3);
    expect(seen.at(-1)).toBe(`done:${chunks.join('')}`);
    expect(chunks.join('')).toMatch(/^feat\(/);
    // A second run cancelled after its first chunk: nothing more.
    seen.length = 0;
    const second = await api.git.message({ root, tweak: { kind: 'shorter', current: chunks.join('') } }) as { id: string };
    expect(second.id).not.toBe(id);
    await vi.advanceTimersByTimeAsync(450);
    await api.git.messageCancel(second.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toHaveLength(1);
  });
});
