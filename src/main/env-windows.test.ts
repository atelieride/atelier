import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { polishEnv } from './dictation/polish';
import { fetchEnv } from './git/fetch';
import { gitEnv } from './git/exec';
import { fallbackEnv } from './git/user-env';
import { writeEnv } from './git/write-env';
import { findGh, ghEnv } from './github/exec';
import { findTmux } from './tmux/exec';

// The child environments on Windows: variable names in any case, `;` lists. The macOS
// behaviour of each function stays pinned by its own test file.

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

/** Keys git would read as GIT_*: Windows compares names in any case. */
const gitKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).filter((k) => k.toUpperCase().startsWith('GIT_') && k !== k.toUpperCase());

describe('no inherited git variable in any spelling', () => {
  const base = { Path: 'C:\\bin', git_dir: 'C:\\elsewhere\\.git', Git_Work_Tree: 'C:\\elsewhere', GIT_INDEX_FILE: 'C:\\x' };

  test('gitEnv, fetchEnv, writeEnv and ghEnv', () => {
    for (const env of [gitEnv(base), fetchEnv(base, false), writeEnv(base, { isolated: false }), ghEnv(base)]) {
      expect(gitKeys(env)).toEqual([]);
      expect(env.GIT_INDEX_FILE).toBeUndefined();
      expect(env.Path).toBe('C:\\bin');
    }
  });

  test("ghEnv drops gh's repo and debug variables in any spelling", () => {
    const env = ghEnv({ gh_repo: 'evil/repo', Gh_Debug: '1', debug: '1', GH_TOKEN: 't' });
    expect(Object.keys(env).filter((k) => ['GH_REPO', 'GH_DEBUG', 'DEBUG'].includes(k.toUpperCase()))).toEqual([]);
    expect(env.GH_TOKEN).toBe('t');
  });
});

describe('PATH lists', () => {
  test("polishEnv: one PATH key, ';'-separated, the app's Path kept, no Homebrew folders", () => {
    const env = polishEnv('C:\\Users\\x\\.local\\bin\\claude.exe', { Path: 'C:\\Windows;C:\\bin', HOME: 'C:\\Users\\x' });
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(env.PATH!.split(';')).toContain('C:\\bin');
    expect(env.PATH).not.toContain('/opt/homebrew');
  });

  test("fallbackEnv: the app's Path as PATH, no Homebrew folders", () => {
    expect(fallbackEnv({ Path: 'C:\\a;C:\\b', X: '1' })).toEqual({ X: '1', PATH: 'C:\\a;C:\\b' });
  });

  test("findGh and findTmux split PATH on ';' and take drive paths as absolute", () => {
    const seen: string[] = [];
    findGh('C:\\a;relative;D:\\b', (p) => { seen.push(p); return false; }, undefined);
    expect(seen.slice(0, 2).map((p) => p.replace(/[\\/]gh\.exe$/, ''))).toEqual(['C:\\a', 'D:\\b']);
    const tmux: string[] = [];
    findTmux('C:\\a;D:\\b', (p) => { tmux.push(p); return false; });
    expect(tmux.slice(0, 2).map((p) => p.replace(/[\\/]tmux$/, ''))).toEqual(['C:\\a', 'D:\\b']);
  });
});
