import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/**
 * Environment of every e2e test: no user file is read or written.
 * - temporary ATELIER_HOME (service, socket, Chromium data), like every temp dir, inside the run's own temp root
 *   (TMPDIR = atl-run-*, set by the global setup, tests/support/temp-root.ts) that is removed when the run ends
 * - empty ZDOTDIR: the shell does not load the user's zsh configuration and history stays there
 * - nonexistent ATELIER_USER_CLAUDE_SETTINGS: the user's real status line never runs with fake data
 * - ATELIER_TEST_CLAUDE_PROJECTS: Claude's conversation history is read from a test folder, never ~/.claude/projects
 * - ATELIER_TEST_CLAUDE_TMP: background task outputs are read from a test folder, never /tmp/claude-<uid>
 * - ATELIER_TEST_CLAUDE_HOME: Claude Code's config (Session panel) from a fake home, never ~/.claude or ~/.claude.json
 * - no CLAUDE_CONFIG_DIR: never the Claude account of the session that runs the tests
 * - ATELIER_TEST_BACKGROUND: windows are never shown, focused or raised (src/main/hidden-windows.ts), yet render: the
 *   tests never cover the work of whoever is using the Mac
 * - ATELIER_TEST_NOTIFY_LOG / ATELIER_TEST_CLIPBOARD_LOG: OS banners and copies are written to logs in the temporary
 *   home (one JSON value per line), never shown on the user's screen nor put on the real clipboard
 * - ATELIER_TEST_TRAY_LOG: the session icons (menu bar, notification area) are never made; what they would show goes
 *   to a log in the temporary home, one JSON value per change
 * - never the user's real Claude Code: ATELIER_E2E makes Atelier's `claude` function refuse anything but the fake one
 *   (ATELIER_CLAUDE_BIN), and tests/fixtures/no-real-claude stays first on PATH for a bare `command claude`, also after
 *   /etc/zprofile's path_helper (the empty ZDOTDIR's .zprofile puts it back in front)
 * - never the user's real GitHub CLI: the same guard folder has a `gh` that refuses (REAL-GH-BLOCKED, exit 97); a test
 *   that needs gh puts its own fake in front of it; the app's own gh (ATELIER_TEST_GH, PR chips) is that guard too
 *   unless a test passes its fake (tests/e2e/fake-gh.mjs); so is Ask's `claude -p` (ATELIER_TEST_COMPANION_CLAUDE)
 *   unless a test passes tests/e2e/fake-claude-ask.mjs, and Context usage's (ATELIER_TEST_CONTEXT_CLAUDE) unless a
 *   test passes tests/e2e/fake-claude-context.mjs
 * - never the real ClickUp: ATELIER_TEST_CLICKUP_URL is a closed loopback port unless a test passes its fake ClickUp
 * - never the real Notion: ATELIER_TEST_NOTION_URL is a closed loopback port unless a test passes its fake Notion
 * - never the real Atlassian: ATELIER_TEST_JIRA_URL and ATELIER_TEST_JIRA_AUTH_URL likewise, unless a test passes its fake Jira
 * - never the user's desktop apps: ATELIER_TEST_APP_SCHEMES says no app handles task links ("none") unless a test
 *   names the schemes; opened links go to ATELIER_TEST_URL_LOG when a test sets it
 * - never the real Keychain: ATELIER_TEST_FAKE_SAFE_STORAGE swaps safeStorage for a stand-in (always on); a test that
 *   connects a connector (ClickUp, Notion) also sets ATELIER_TEST_FOLLOW_AUTH=1 (main follows the authorize page; no browser opens)
 * - never the user's git credentials: ATELIER_TEST_FETCH_ISOLATED (always on) runs Source Control's fetches without
 *   credential helpers and without global or system git config; ATELIER_TEST_GIT_ISOLATED (always on) does the same
 *   for every other git read and write
 * - never the user's Trash: ATELIER_TEST_TRASH_DIR is a fresh temp folder unless a test passes its own
 * - ATELIER_TEST_MUTED: every page is muted, so the chime and the dictation tones run but are never heard (always on)
 * - never the user's Docker engine: ATELIER_TEST_DOCKER_SOCKET is a missing socket unless a test passes a fake engine's
 * - never the user's Redis: ATELIER_TEST_REDIS_PORTS are the only ports the app contacts (a closed one by default)
 * - never the user's Postgres: the Databases view looks for nothing and contacts only the connections a
 *   test saves
 * - never the user's ssh: ATELIER_TEST_SSH_BIN (the Databases view's SSH tunnels) is the guard's refusing ssh unless a
 *   test passes tests/support/fake-ssh.mjs; the guard on PATH refuses a bare `ssh` in an e2e terminal too
 * - ATELIER_TEST_CLOSE_SESSIONS=keep: closing a window or quitting keeps the sessions running, as before that setting
 *   existed; that feature's own specs pass '' (the setting decides) or a mode
 */
/**
 * preferences.json in a test's ATELIER_HOME before launch: e.g. the views that are off by default since 2026-11-02
 * (`{ showServices: true }`, `{ automationsEnabled: true }`).
 */
export function writePrefs(home: string, prefs: Record<string, unknown>): void {
  writeFileSync(join(home, 'preferences.json'), JSON.stringify(prefs), { mode: 0o600 });
}

export function e2eEnv(extra: Record<string, string> = {}): { env: Record<string, string>; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'atl-e2e-'));
  const zdot = mkdtempSync(join(tmpdir(), 'atl-e2e-zsh-'));
  const guard = resolve('tests/fixtures/no-real-claude');
  if (process.platform !== 'win32') writeFileSync(join(zdot, '.zprofile'), `path=('${guard.replace(/'/g, "'\\''")}' $path)\n`);
  // The "sessions stay active" notice on quit would block closing the app in tests.
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [], quitInfoShown: true }));
  // No modal dialog may block a test: with unsaved files on close the answer is "Don't Save" (unless overridden).
  const env = { ...process.env, ATELIER_HOME: home, ZDOTDIR: zdot, ATELIER_USER_CLAUDE_SETTINGS: '/nonexistent/atelier-e2e-settings.json', ATELIER_TEST_CLAUDE_PROJECTS: join(home, 'no-claude-projects'), ATELIER_TEST_CLAUDE_TMP: join(home, 'no-claude-tmp'), ATELIER_TEST_UNSAVED_ANSWER: 'discard', ATELIER_TEST_CLOSE_SESSIONS: 'keep', ATELIER_TEST_BACKGROUND: '1', ATELIER_E2E: '1', PATH: `${guard}${delimiter}${process.env.PATH ?? ''}`, ...extra } as Record<string, string>;
  // Windows reads Path and PATH as one variable: keep only the spelling set here.
  if (process.platform === 'win32') for (const k of Object.keys(env)) if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete env[k];
  // Never the Claude account of whoever runs the tests: a Claude session started as another account exports its
  // CLAUDE_CONFIG_DIR to everything it runs, the app and its terminals included.
  if (!extra.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
  // Always on: a test may point them elsewhere, never switch them off.
  if (!env.ATELIER_TEST_NOTIFY_LOG) env.ATELIER_TEST_NOTIFY_LOG = join(home, 'test-notifications.log');
  if (!env.ATELIER_TEST_CLIPBOARD_LOG) env.ATELIER_TEST_CLIPBOARD_LOG = join(home, 'test-clipboard.log');
  if (!env.ATELIER_TEST_TRAY_LOG) env.ATELIER_TEST_TRAY_LOG = join(home, 'test-tray.log');
  // The app's own gh (PR chips) runs from main, outside any shell: the guard too, unless a test's fake.
  if (!env.ATELIER_TEST_GH) env.ATELIER_TEST_GH = join(guard, 'gh');
  // Ask's own `claude -p` runs from main too: the guard's claude (it refuses) unless a test
  // passes tests/e2e/fake-claude-ask.mjs.
  if (!env.ATELIER_TEST_COMPANION_CLAUDE) env.ATELIER_TEST_COMPANION_CLAUDE = join(guard, 'claude');
  // Context usage's private copy of a session too: the guard's claude unless a test
  // passes tests/e2e/fake-claude-context.mjs.
  if (!env.ATELIER_TEST_CONTEXT_CLAUDE) env.ATELIER_TEST_CONTEXT_CLAUDE = join(guard, 'claude');
  // The Databases view's SSH tunnels start ssh from main: the guard's ssh (it
  // refuses) unless a test passes tests/support/fake-ssh.mjs. Never the user's ssh, keys, agent or ~/.ssh/config.
  if (!env.ATELIER_TEST_SSH_BIN) env.ATELIER_TEST_SSH_BIN = join(guard, 'ssh');
  // Never the real ClickUp: a closed loopback port unless a test passes its fake's URL
  // (tests/fixtures/fake-clickup.mjs).
  if (!env.ATELIER_TEST_CLICKUP_URL) env.ATELIER_TEST_CLICKUP_URL = 'http://127.0.0.1:9';
  // Never the real Notion: same closed loopback port unless a test passes tests/fixtures/fake-notion.mjs.
  if (!env.ATELIER_TEST_NOTION_URL) env.ATELIER_TEST_NOTION_URL = 'http://127.0.0.1:9';
  // Never the real Atlassian: both of Jira's origins, the MCP host and the authorization
  // server, are the closed port unless a test passes tests/fixtures/fake-jira.mjs's two.
  if (!env.ATELIER_TEST_JIRA_URL) env.ATELIER_TEST_JIRA_URL = 'http://127.0.0.1:9';
  if (!env.ATELIER_TEST_JIRA_AUTH_URL) env.ATELIER_TEST_JIRA_AUTH_URL = env.ATELIER_TEST_JIRA_URL;
  // Never the user's Claude Code config (Session panel): a fake home with nothing in it unless a test
  // passes its fixture (whatever the environment the tests run in says).
  env.ATELIER_TEST_CLAUDE_HOME = extra.ATELIER_TEST_CLAUDE_HOME || join(home, 'no-claude-home');
  // A linked task opens in its desktop app when one handles the scheme: never decided by the Mac running the tests (the
  // user's has ClickUp), so no app unless a test names the schemes ("clickup").
  if (!env.ATELIER_TEST_APP_SCHEMES) env.ATELIER_TEST_APP_SCHEMES = 'none';
  // Never the real Keychain (connector secrets): safeStorage is always the test stand-in.
  env.ATELIER_TEST_FAKE_SAFE_STORAGE = '1';
  // Source Control fetches on its own: never with the user's credential helpers (Keychain, gh) or
  // global/system git config.
  env.ATELIER_TEST_FETCH_ISOLATED = '1';
  // Git reads and writes: never the user's global or system git config, nor its credential
  // helpers (repos built by tests carry their own identity).
  env.ATELIER_TEST_GIT_ISOLATED = '1';
  // Discard and Move to Trash: never the user's Trash. A fresh folder unless a test passes its own.
  if (!env.ATELIER_TEST_TRASH_DIR) env.ATELIER_TEST_TRASH_DIR = mkdtempSync(join(tmpdir(), 'atl-trash-'));
  // Sounds (chime, dictation tones) still play, muted: whoever is at the Mac never hears a test run.
  env.ATELIER_TEST_MUTED = '1';
  // Docker: never the user's engine. A socket that doesn't exist unless a test passes its fake
  // engine's (tests/support/fake-docker.ts): the app then probes only that path.
  if (!env.ATELIER_TEST_DOCKER_SOCKET) env.ATELIER_TEST_DOCKER_SOCKET = join(home, 'no-docker.sock');
  // Redis: never the user's Redis. Only these ports are ever contacted (a closed one unless a test
  // passes its fake's, tests/support/fake-redis.ts), whatever .env, Docker or terminals point at; no Homebrew hint.
  if (!env.ATELIER_TEST_REDIS_PORTS) env.ATELIER_TEST_REDIS_PORTS = '9';
  if (!env.ATELIER_TEST_REDIS_BREW) env.ATELIER_TEST_REDIS_BREW = '0';
  // Main's questions fall back to the native dialog when a hung page doesn't take them within 2 s: a busy test machine
  // must never get that dialog (it would appear on screen and block the test).
  if (!env.ATELIER_TEST_ASK_SHOWN_MS) env.ATELIER_TEST_ASK_SHOWN_MS = '30000';
  return { env, home };
}
