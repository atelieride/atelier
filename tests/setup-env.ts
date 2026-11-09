import { setTestDefaultPlatform } from '../src/shared/platform';

// Unit tests describe the macOS behaviour unless they say otherwise: the app's platform switch
// reads darwin on any machine, so a test with POSIX paths holds on Windows too. A test of the Windows behaviour forces
// win32 and resets afterwards; a test on real files with native paths runs as the machine (useMachinePlatform in
// tests/support/platform.ts).
setTestDefaultPlatform('darwin');
// No test runs the user's real status line: it has effects outside Atelier (e.g. the rate-limit cache).
process.env.ATELIER_USER_CLAUDE_SETTINGS = '/nonexistent/atelier-test-settings.json';
// No test reads the user's Claude Code history (~/.claude/projects): tests that need one pass their own folder.
process.env.ATELIER_TEST_CLAUDE_PROJECTS = '/nonexistent/atelier-test-claude-projects';
// Nor Claude Code's temp root (/tmp/claude-<uid>, background task outputs): tests that need one pass their own folder.
process.env.ATELIER_TEST_CLAUDE_TMP = '/nonexistent/atelier-test-claude-tmp';
// Nor its config (~/.claude, ~/.claude.json, CLAUDE_CONFIG_DIR) for the Session panel: tests pass their own roots.
process.env.ATELIER_TEST_CLAUDE_HOME = '/nonexistent/atelier-test-claude-home';
// Never the real ClickUp: clickupEndpoint() without an argument gets a closed loopback port, as in e2eEnv (tests that
// need ClickUp pass their fake's URL).
process.env.ATELIER_TEST_CLICKUP_URL = 'http://127.0.0.1:9';
// Test repos do not read the user's git configuration (global hooks, commit signing, ...).
// '/dev/null', not os.devNull: Git for Windows maps /dev/null itself and refuses NUL's device path.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// runGit and the git writes drop inherited GIT_* variables: this makes them read no global or system config either.
process.env.ATELIER_TEST_GIT_ISOLATED = '1';
