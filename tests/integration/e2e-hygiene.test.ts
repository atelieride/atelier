// Every e2e runs with banners and copies diverted to logs (devEnv-gated, inert in the packaged app): no test may post
// a real macOS notification or touch the real clipboard on the developer's machine.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test } from 'vitest';
import { posixTest } from '../support/platform';
import { e2eEnv } from '../e2e/env';

const e2eDir = join(__dirname, '../e2e');

test('e2eEnv diverts OS banners and clipboard writes to logs inside its temporary home', () => {
  const { env, home } = e2eEnv();
  expect(env.ATELIER_TEST_NOTIFY_LOG?.startsWith(home + sep)).toBe(true);
  expect(env.ATELIER_TEST_CLIPBOARD_LOG?.startsWith(home + sep)).toBe(true);
  // A test can point them elsewhere, never turn them off with an empty value.
  expect(e2eEnv({ ATELIER_TEST_CLIPBOARD_LOG: '/tmp/x.log' }).env.ATELIER_TEST_CLIPBOARD_LOG).toBe('/tmp/x.log');
  expect(e2eEnv({ ATELIER_TEST_NOTIFY_LOG: '' }).env.ATELIER_TEST_NOTIFY_LOG).not.toBe('');
});

// Session icons: no test puts a dot in the real menu bar.
test('e2eEnv diverts the session icons to a log; the manual runs where devEnv is inert or Claude is real turn them off', () => {
  const { env, home } = e2eEnv();
  expect(env.ATELIER_TEST_TRAY_LOG?.startsWith(home + sep)).toBe(true);
  expect(e2eEnv({ ATELIER_TEST_TRAY_LOG: '' }).env.ATELIER_TEST_TRAY_LOG).not.toBe('');
  // The packaged app ignores ATELIER_TEST_*; real-claude runs real sessions: both write the setting off.
  for (const f of ['packaged.manual.ts', 'real-claude.manual.ts']) expect(readFileSync(join(e2eDir, f), 'utf8'), f).toMatch(/trayIcons: false/);
});

// The packaged app ignores ATELIER_TEST_* (devEnv is inert there), so the test ports Redis and Postgres probe in an e2e
// don't reach it: left on, its Redis and Databases views would probe the machine's own 6379 and 5432 (the
// developer's servers). Every preferences file the packaged checks write turns both views off.
test('the packaged checks (mac and Windows) write Redis and Databases off in every preferences file', () => {
  for (const f of ['packaged.manual.ts', 'packaged-win.manual.ts']) {
    const src = readFileSync(join(e2eDir, f), 'utf8');
    const prefs = [...src.matchAll(/'preferences\.json'\),\s*JSON\.stringify\((\{[^}]*\})\)/g)].map((m) => m[1]!);
    expect(prefs.length, f).toBeGreaterThan(0);
    // Each write names both (no other way to write the file).
    expect(src.split("'preferences.json'").length - 1, f).toBe(prefs.length);
    for (const p of prefs) {
      expect(p, f).toContain("showRedis: 'never'");
      expect(p, f).toContain("showDatabases: 'never'");
    }
  }
});

// Discard and the file tree's Move to Trash: no e2e ever reaches the user's real Trash.
test('e2eEnv always gives the app a test Trash (a fresh temp folder) unless a test passes its own', () => {
  const a = e2eEnv().env.ATELIER_TEST_TRASH_DIR!;
  const b = e2eEnv().env.ATELIER_TEST_TRASH_DIR!;
  expect(a.startsWith(tmpdir())).toBe(true);
  expect(statSync(a).isDirectory()).toBe(true);
  expect(readdirSync(a)).toEqual([]);
  expect(a).not.toBe(b);
  expect(e2eEnv({ ATELIER_TEST_TRASH_DIR: '/x/trash' }).env.ATELIER_TEST_TRASH_DIR).toBe('/x/trash');
  expect(e2eEnv({ ATELIER_TEST_TRASH_DIR: '' }).env.ATELIER_TEST_TRASH_DIR).not.toBe('');
});

// The *.manual.ts runs (real Claude, packaged app) are launched by hand, on purpose with the real configuration.
test('every e2e spec that launches Atelier builds its environment with e2eEnv', () => {
  const specs = readdirSync(e2eDir).filter((n) => n.endsWith('.spec.ts'));
  const offenders = specs.filter((n) => {
    const src = readFileSync(join(e2eDir, n), 'utf8');
    return /electron\.launch\(/.test(src) && !/e2eEnv\(/.test(src);
  });
  expect(specs.length).toBeGreaterThan(10);
  expect(offenders).toEqual([]);
});

// An earlier repro ran the real GitHub CLI: like claude, a bare `gh` in an e2e terminal must hit a guard that refuses.
// POSIX: the guards are sh scripts, the zsh .zprofile puts them back (Windows guards come with its e2e).
posixTest('e2eEnv puts a guard first on PATH that blocks the real gh (and claude)', () => {
  const { env } = e2eEnv();
  const guard = env.PATH!.split(':')[0]!;
  expect(guard).toBe(resolve('tests/fixtures/no-real-claude'));
  // After /etc/zprofile's path_helper too: the empty ZDOTDIR's .zprofile puts the same folder back in front.
  expect(readFileSync(join(env.ZDOTDIR!, '.zprofile'), 'utf8')).toContain(guard);
  for (const [cmd, word] of [['gh', 'REAL-GH-BLOCKED'], ['claude', 'REAL-CLAUDE-BLOCKED']] as const) {
    const bin = join(guard, cmd);
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(r.status).toBe(97);
    expect(r.stderr).toContain(word);
  }
});

// The PR chip's gh runs from the main process, not a shell: by default it is pointed at the same guard,
// so an e2e never reaches the real GitHub CLI even when main would find it in PATH or Homebrew.
test('e2eEnv points the app\'s gh (ATELIER_TEST_GH) at the refusing guard unless a test gives its own fake', () => {
  expect(e2eEnv().env.ATELIER_TEST_GH).toBe(resolve('tests/fixtures/no-real-claude/gh'));
  expect(e2eEnv({ ATELIER_TEST_GH: '/x/fake-gh' }).env.ATELIER_TEST_GH).toBe('/x/fake-gh');
  expect(e2eEnv({ ATELIER_TEST_GH: '' }).env.ATELIER_TEST_GH).toBe(resolve('tests/fixtures/no-real-claude/gh'));
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_GH'");
});

// The Databases view's SSH tunnels: main starts ssh itself. By default an e2e
// points it at a guard that refuses, so no test ever runs the user's ssh with their keys, agent and ~/.ssh/config; a
// test
// that tunnels passes tests/support/fake-ssh.mjs.
test('e2eEnv points the app\'s ssh (ATELIER_TEST_SSH_BIN) at the refusing guard unless a test gives its own fake', () => {
  const guard = resolve('tests/fixtures/no-real-claude/ssh');
  expect(e2eEnv().env.ATELIER_TEST_SSH_BIN).toBe(guard);
  expect(e2eEnv({ ATELIER_TEST_SSH_BIN: '/x/fake-ssh' }).env.ATELIER_TEST_SSH_BIN).toBe('/x/fake-ssh');
  expect(e2eEnv({ ATELIER_TEST_SSH_BIN: '' }).env.ATELIER_TEST_SSH_BIN).toBe(guard);
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_SSH_BIN'");
});

posixTest('the ssh guard refuses: exit 255, "ssh is disabled in tests" on stderr', () => {
  const bin = resolve('tests/fixtures/no-real-claude/ssh');
  expect(statSync(bin).mode & 0o111).not.toBe(0);
  const r = spawnSync(bin, ['-N', '-L', '127.0.0.1:1:db:5432', '--', 'me@bastion'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(r.status).toBe(255);
  expect(r.stderr).toContain('ssh is disabled in tests');
});

// Tests talk only to the local fake ClickUp. Unless a test passes its fake's URL, the app's ClickUp base is
// a closed loopback port, so a connector bug in an e2e fails ("offline") instead of reaching mcp.clickup.com.
test('e2eEnv points the app\'s ClickUp (ATELIER_TEST_CLICKUP_URL) at a dead loopback port unless a test gives its fake', () => {
  expect(e2eEnv().env.ATELIER_TEST_CLICKUP_URL).toBe('http://127.0.0.1:9');
  expect(e2eEnv({ ATELIER_TEST_CLICKUP_URL: 'http://127.0.0.1:4567' }).env.ATELIER_TEST_CLICKUP_URL).toBe('http://127.0.0.1:4567');
  expect(e2eEnv({ ATELIER_TEST_CLICKUP_URL: '' }).env.ATELIER_TEST_CLICKUP_URL).toBe('http://127.0.0.1:9');
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_CLICKUP_URL'");
});

// A linked task opens in its desktop app when one handles the scheme (links.ts openAppUrl). In e2e the answer never
// depends on the Mac running them: no app, unless a test names the schemes.
test('e2eEnv: no desktop app handles task links unless a test says so (never Launch Services)', () => {
  expect(e2eEnv().env.ATELIER_TEST_APP_SCHEMES).toBe('none');
  expect(e2eEnv({ ATELIER_TEST_APP_SCHEMES: '' }).env.ATELIER_TEST_APP_SCHEMES).toBe('none');
  expect(e2eEnv({ ATELIER_TEST_APP_SCHEMES: 'clickup' }).env.ATELIER_TEST_APP_SCHEMES).toBe('clickup');
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_APP_SCHEMES'");
});

// Connector secrets go through safeStorage, which in an unpackaged Electron creates a Keychain item in
// the user's login keychain and may prompt. Every e2e uses the stand-in (src/main/connectors/test-safe-storage.ts),
// whatever a test passes.
test('e2eEnv always swaps safeStorage for the test stand-in (never the real Keychain)', () => {
  expect(e2eEnv().env.ATELIER_TEST_FAKE_SAFE_STORAGE).toBe('1');
  expect(e2eEnv({ ATELIER_TEST_FAKE_SAFE_STORAGE: '' }).env.ATELIER_TEST_FAKE_SAFE_STORAGE).toBe('1');
  expect(e2eEnv({ ATELIER_TEST_FAKE_SAFE_STORAGE: '0' }).env.ATELIER_TEST_FAKE_SAFE_STORAGE).toBe('1');
  const devEnvText = readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8');
  expect(devEnvText).toContain("'ATELIER_TEST_FAKE_SAFE_STORAGE'");
  expect(devEnvText).toContain("'ATELIER_TEST_FOLLOW_AUTH'");
  // Every secret store main makes comes from secretStoreFor (src/main/hub-deps.ts), which swaps in the stand-in.
  expect(readFileSync(join(__dirname, '../../src/main/hub-deps.ts'), 'utf8'))
    .toContain("createSecretStore(home, devEnv('ATELIER_TEST_FAKE_SAFE_STORAGE') === '1' ? testSafeStorage() : safe)");
  const callers = readdirSync(join(__dirname, '../../src/main'), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .filter((f) => /\bcreateSecretStore\(/.test(readFileSync(join(__dirname, '../../src/main', f), 'utf8')))
    .map((f) => f.split('\\').join('/'));
  expect(callers.sort()).toEqual(['connectors/secret-store.ts', 'hub-deps.ts']);
});

// The Session panel reads Claude Code's config. In every e2e that is a fake home inside the
// temporary ATELIER_HOME (a test may pass its own fixture), never ~/.claude, ~/.claude.json or CLAUDE_CONFIG_DIR.
test('e2eEnv points Claude Code\'s config (ATELIER_TEST_CLAUDE_HOME) at a folder of its temporary home unless a test gives a fixture', () => {
  const { env, home } = e2eEnv();
  expect(env.ATELIER_TEST_CLAUDE_HOME?.startsWith(home + sep)).toBe(true);
  expect(e2eEnv({ ATELIER_TEST_CLAUDE_HOME: '/x/fixture' }).env.ATELIER_TEST_CLAUDE_HOME).toBe('/x/fixture');
  const off = e2eEnv({ ATELIER_TEST_CLAUDE_HOME: '' });
  expect(off.env.ATELIER_TEST_CLAUDE_HOME?.startsWith(off.home + sep)).toBe(true);
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_CLAUDE_HOME'");
});

test('ATELIER_TEST_NOTIFY_LOG is a devEnv variable (inert in the packaged app)', () => {
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_NOTIFY_LOG'");
});

// The chime and the dictation tones run in e2e like in the app, but nobody at the Mac hears them: always muted.
test('e2eEnv always mutes the app\'s pages', () => {
  expect(e2eEnv().env.ATELIER_TEST_MUTED).toBe('1');
  expect(e2eEnv({ ATELIER_TEST_MUTED: '' }).env.ATELIER_TEST_MUTED).toBe('1');
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_MUTED'");
  expect(readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')).toContain('muteTestAudio(app)');
});

// Source Control fetches on its own. In e2e no fetch may reach the user's Keychain, gh credentials or
// global git config: always isolated, whatever a test passes.
test('e2eEnv always isolates fetch from the user\'s credentials and git config', () => {
  expect(e2eEnv().env.ATELIER_TEST_FETCH_ISOLATED).toBe('1');
  expect(e2eEnv({ ATELIER_TEST_FETCH_ISOLATED: '0' }).env.ATELIER_TEST_FETCH_ISOLATED).toBe('1');
  expect(readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8')).toContain("'ATELIER_TEST_FETCH_ISOLATED'");
  expect(readFileSync(join(__dirname, '../../src/main/git/fetch.ts'), 'utf8')).toContain("devEnv('ATELIER_TEST_FETCH_ISOLATED') === '1'");
});

// The packaged app ignores ATELIER_TEST_FETCH_ISOLATED (devEnv is inert there), and Changes counts as viewing:
// a packaged launch on a real repository (this one) would
// fetch its remotes with the user's own credentials. Every preferences file a packaged-app test writes turns it off.
test('tests of the packaged app write preferences with Auto-fetch off', () => {
  const dir = join(__dirname, '../e2e');
  const packaged = readdirSync(dir).filter((f) => f.endsWith('.ts') && readFileSync(join(dir, f), 'utf8').includes('executablePath'));
  expect(packaged.length).toBeGreaterThan(0);
  const offenders = packaged.flatMap((f) => {
    const writes = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => /preferences\.json'|writePrefs\(home/.test(l));
    if (!writes.length) return [`${f}: no preferences written`];
    return writes.filter((l) => !/autoFetch: 'off'/.test(l)).map((l) => `${f}: ${l.trim()}`);
  });
  expect(offenders).toEqual([]);
});

// A screenshot saved for a person to look at goes through look() (tests/e2e/shots.ts), which takes it
// only with ATELIER_E2E_SHOTS=1; a normal run pays neither the shot nor the settle wait before it.
test('specs save screenshots only through look() or behind ATELIER_E2E_SHOTS', () => {
  const dir = join(__dirname, '../e2e');
  const offenders = readdirSync(dir).filter((f) => f.endsWith('.spec.ts')).flatMap((f) =>
    readFileSync(join(dir, f), 'utf8').split('\n').map((l, i) => [`${f}:${i + 1}`, l] as const)
      .filter(([, l]) => /\.screenshot\(\{[^)]*\bpath\b/.test(l) && !/^\s*if \(shots\)/.test(l)).map(([at]) => at));
  expect(offenders).toEqual([]);
});

// The e2e shorten a few production timings; only through devEnv (inert in the packaged app), each
// passed to its hub in index.ts.
test('test timings (ports poll, server threshold, missing output, outside-file grace) are devEnv variables wired in main', () => {
  const devEnvText = readFileSync(join(__dirname, '../../src/main/dev-env.ts'), 'utf8');
  const index = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
  for (const name of ['ATELIER_TEST_PORTS_POLL_MS', 'ATELIER_TEST_SERVER_LISTEN_MS', 'ATELIER_TEST_BG_MISSING_MS', 'ATELIER_TEST_OUTSIDE_GRACE_MS', 'ATELIER_TEST_DB_OVERVIEW_MS']) {
    expect(devEnvText).toContain(`'${name}'`);
    expect(index).toContain(`testMs('${name}')`);
  }
});
