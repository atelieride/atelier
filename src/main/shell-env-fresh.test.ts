import { expect, test } from 'vitest';
import { posixTest } from '../../tests/support/platform';
import { ShellEnvFreshness, checkApplies, checkedFiles, zshStartupFiles, type FileStamp } from './shell-env-fresh';

/** A fake file system: path → stamp (absent = missing), and a reload that records its calls. */
function setup(files: Record<string, FileStamp>, capturedAt: number) {
  const fs = { ...files };
  const env = { capturedAt: capturedAt as number | undefined, reloads: 0, fail: null as string | null, onReload: () => {} };
  const events: string[] = [];
  const fresh = new ShellEnvFreshness({
    stat: (p) => fs[p] ?? null,
    reload: async () => {
      env.reloads++;
      env.onReload();
      if (env.fail) throw new Error(env.fail);
      env.capturedAt = (env.capturedAt ?? 0) + 1000;
    },
    capturedAt: () => env.capturedAt
  });
  const ensure = (list = Object.keys(files)) => fresh.ensure(list, {
    reloading: (changed) => events.push(`reloading ${changed.join(',')}`),
    failed: (error) => events.push(`failed ${error}`)
  });
  return { fs, env, events, ensure };
}

const stamp = (mtimeMs: number, size = 10, ino = 1): FileStamp => ({ mtimeMs, size, ino });

// POSIX: zsh's startup files.
posixTest('zsh startup files: the four files zsh reads, in ZDOTDIR when set, else in the home folder', () => {
  expect(zshStartupFiles('/Users/u', undefined)).toEqual(['/Users/u/.zshenv', '/Users/u/.zprofile', '/Users/u/.zshrc', '/Users/u/.zlogin']);
  expect(zshStartupFiles('/Users/u', '/Users/u/.config/zsh')).toEqual(['/Users/u/.config/zsh/.zshenv', '/Users/u/.config/zsh/.zprofile', '/Users/u/.config/zsh/.zshrc', '/Users/u/.config/zsh/.zlogin']);
  expect(zshStartupFiles('/Users/u', '')).toEqual(zshStartupFiles('/Users/u', undefined));
  expect(checkedFiles(['/a', '/b'], ['/b', '/c'])).toEqual(['/a', '/b', '/c']);
});

test('first check: a file newer than the capture reloads first, naming it; older files leave it alone', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000), '/h/.zshenv': stamp(100) }, 2000);
  await s.ensure();
  expect(s.env.reloads).toBe(1);
  expect(s.events).toEqual(['reloading /h/.zshrc']);

  const old = setup({ '/h/.zshrc': stamp(1000) }, 2000);
  await old.ensure();
  expect(old.env.reloads).toBe(0);
  expect(old.events).toEqual([]);
});

test('after a reload: unchanged files never reload again, whatever their mtime says (a future mtime included)', async () => {
  const s = setup({ '/h/.zshrc': stamp(99_999_999) }, 2000);
  await s.ensure();
  await s.ensure();
  await s.ensure();
  expect(s.env.reloads).toBe(1);
});

test('after a reload: any change of a file reloads again (mtime, size, inode, created, deleted)', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000), '/h/.zlogin': stamp(5000) }, 2000);
  await s.ensure();
  const changes: (() => void)[] = [
    () => { s.fs['/h/.zshrc'] = stamp(5000, 11); },
    () => { s.fs['/h/.zshrc'] = stamp(5000, 11, 2); },
    () => { s.fs['/h/.zshrc'] = stamp(1, 11, 2); },
    () => { delete s.fs['/h/.zlogin']; },
    () => { s.fs['/h/.zlogin'] = stamp(1); }
  ];
  for (const [i, change] of changes.entries()) {
    change();
    await s.ensure();
    expect(s.env.reloads, `change ${i}`).toBe(i + 2);
  }
  expect(s.events.at(-2)).toBe('reloading /h/.zlogin');
});

test('a save that lands during the reload makes the next check stale again', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000) }, 2000);
  s.env.onReload = () => { s.fs['/h/.zshrc'] = stamp(5500, 12); };
  await s.ensure();
  s.env.onReload = () => {};
  await s.ensure();
  expect(s.env.reloads).toBe(2);
});

test('a capture taken elsewhere (manual Reload, atelierd restart) drops the baseline: back to comparing with it', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000) }, 2000);
  await s.ensure();
  expect(s.env.reloads).toBe(1);
  // Manual Reload: a newer capture; the file didn't change since. No reload.
  s.env.capturedAt = 9000;
  await s.ensure();
  expect(s.env.reloads).toBe(1);
  // Edited after that capture: reload.
  s.fs['/h/.zshrc'] = stamp(9500, 12);
  await s.ensure();
  expect(s.env.reloads).toBe(2);
});

test('a file added to the list later counts only if newer than the capture', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000), '/x/aliases.zsh': stamp(100) }, 2000);
  await s.ensure(['/h/.zshrc']);
  expect(s.env.reloads).toBe(1);
  await s.ensure(['/h/.zshrc', '/x/aliases.zsh']);
  expect(s.env.reloads).toBe(1);
  s.fs['/y/new.zsh'] = stamp(99_999);
  await s.ensure(['/h/.zshrc', '/x/aliases.zsh', '/y/new.zsh']);
  expect(s.env.reloads).toBe(2);
});

test('a failed reload: the terminal still opens, no retry until a file changes again', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000) }, 2000);
  s.env.fail = 'parse error near `}`';
  await expect(s.ensure()).resolves.toBeUndefined();
  await s.ensure();
  expect(s.env.reloads).toBe(1);
  expect(s.events).toEqual(['reloading /h/.zshrc', 'failed parse error near `}`']);
  s.env.fail = null;
  s.fs['/h/.zshrc'] = stamp(6000, 11);
  await s.ensure();
  expect(s.env.reloads).toBe(2);
});

test('terminals opened during a reload wait for the same one', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000) }, 2000);
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const fresh = new ShellEnvFreshness({
    stat: (p) => s.fs[p] ?? null,
    reload: async () => { s.env.reloads++; await gate; s.env.capturedAt = 9000; },
    capturedAt: () => s.env.capturedAt
  });
  const told: string[] = [];
  const window = (name: string) => ({ reloading: (f: string[]) => told.push(`${name} ${f.join(',')}`), failed: () => {} });
  let done = 0;
  const a = fresh.ensure(['/h/.zshrc'], window('A')).then(() => done++);
  await new Promise((r) => setTimeout(r, 0));
  const b = fresh.ensure(['/h/.zshrc'], window('B')).then(() => done++);
  await new Promise((r) => setTimeout(r, 0));
  expect(done).toBe(0);
  // The window that joins is told too: it waits as long as the first one.
  expect(told).toEqual(['A /h/.zshrc', 'B /h/.zshrc']);
  release();
  await Promise.all([a, b]);
  expect(s.env.reloads).toBe(1);
});

test('no capture yet (first one still running, or capture off): nothing to compare, nothing done', async () => {
  const s = setup({ '/h/.zshrc': stamp(5000) }, 0);
  s.env.capturedAt = undefined;
  await s.ensure();
  expect(s.env.reloads).toBe(0);
});


test('checked only for the Atelier profile, with the setting on and atelierd connected', () => {
  expect(checkApplies('atelier', true, true)).toBe(true);
  expect(checkApplies('user', true, true)).toBe(false);
  expect(checkApplies({ shell: '/bin/bash' }, true, true)).toBe(false);
  // No profile: an atelierd older than profiles (its terminals never use a capture).
  expect(checkApplies(undefined, true, true)).toBe(false);
  expect(checkApplies('atelier', false, true)).toBe(false);
  expect(checkApplies('atelier', true, false)).toBe(false);
});

test('a failed reload is reported to every window waiting for it', async () => {
  let fail = (_e: Error) => {};
  const fresh = new ShellEnvFreshness({
    stat: () => stamp(5000),
    reload: () => new Promise<void>((_r, j) => { fail = j; }),
    capturedAt: () => 2000
  });
  const failed: string[] = [];
  const window = (name: string) => ({ reloading: () => {}, failed: (e: string) => failed.push(`${name} ${e}`) });
  const a = fresh.ensure(['/h/.zshrc'], window('A'));
  await new Promise((r) => setTimeout(r, 0));
  const b = fresh.ensure(['/h/.zshrc'], window('B'));
  fail(new Error('timed out'));
  await Promise.all([a, b]);
  expect(failed).toEqual(['A timed out', 'B timed out']);
});
