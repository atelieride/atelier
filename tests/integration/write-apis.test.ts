import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// In the main process only fs/write.ts writes to the project.
const mainDir = join(__dirname, '../../src/main');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
});
const WRITE_API = /\b(writeFile(Sync)?|rename(Sync)?|mkdir(Sync)?|copyFile(Sync)?|cp(Sync)?|rm(Sync)?|rmdir(Sync)?|unlink(Sync)?|chmod(Sync)?|truncate(Sync)?|trashItem|writeFileAtomic|ensureDir)\s*\(/;
// Exceptions outside the project, with folders fixed by the main process (never by the renderer):
// - clipboard-image.ts: images pasted into the terminal, private pngs in the user's temp dir (ATELIER_HOME on Windows)
// - only in ATELIER_HOME: the folder and logs (index, daemon-launcher; also atelierd's launchd job plist, 0600 in run/,
//   removed at once, through daemon/launchd.ts), ui-state.json (projects), preferences.json
//   (settings-store; an unreadable one renamed aside, never overwritten), the updates folder (updates-ipc; also removes the `.Atelier-previous.app` rollback copy that its
//   swap helper leaves next to the app, once the new version has started before: updates.ts previousAppToDrop), the dictation model in ATELIER_HOME/models (dictation/model),
//   bash-attributions.json (bash-attributions: the app-side "via Bash" attributions, 0600, bounded), logs/app.log
//   (app-log: the app's error log, 0600, one rotated backup, messages and stacks only), ATELIER_HOME/updates (auto-update:
//   the in-app updater's download folder, the staged Atelier.app, update.json and state.json; nothing else),
//   ATELIER_HOME/connectors/<id>.bin (connectors/secret-store: connector token encrypted with safeStorage,
//   0600, atomic, deleted on Disconnect), ATELIER_HOME/tabs.json (tabs-store: each project's tab paths and order across
//   restarts; 0600, atomic, at most 50 projects), ATELIER_HOME/redis.json (redis/picks: the Redis
//   instance each project picked, endpoint keys only, 0600, atomic), ATELIER_HOME/databases.json (databases/store: saved
//   database connections and each project's pick, no passwords, 0600, atomic, at most 64 connections), ATELIER_HOME/runtime (runtime-copy, Windows only:
//   atelierd's copy of the app folder per daemon fingerprint, made in a .tmp-<pid> folder then renamed; copies no daemon
//   runs from are moved aside, then removed)
// - shell-command-exec.ts: only /usr/local/bin/atelier, only a link to the app's own Resources/bin/atelier, only on the
//   user's Install / Uninstall 'atelier' Command; never replaces anything that isn't a link to an Atelier.app script
// - git/trace2.ts: its private 0700 folder <tmpdir>/atelier-<pid> (tests: the run's temp root or
//   ATELIER_TEST_TRACE2_DIR), made once (mkdir, chmod 0700), and the per-op Unix socket files inside it, removed when the
//   op ends; the folder itself removed at quit only when empty. No regular file, nothing in any project.
//   Windows (no af_unix for git): instead of the socket, the op's own empty `<n>.trace2` file that git appends
//   its events to, in the same folder, removed when the op ends
// - automations/guard.ts: ATELIER_HOME/automations/guard only: the git hooks of automated
//   sessions, fixed content, 0700, written at start when they differ; on Windows bin/git.exe, a copy of the app's own
//   atelier-git.exe instead of the sh script; nothing in any project
// - automations/store.ts: ATELIER_HOME/automations only: automations.json, <id>.runs.json,
//   <id>.seen.json, 0600, atomic; an unreadable automations.json renamed aside (never overwritten); a deleted
//   automation's two files removed
// - automations/launcher.ts: ATELIER_HOME/automations/runs/<run> only: launch.sh (launch.ps1
//   on Windows), system.md and prompt.md (0600, folder 0700), removed — those and the empty folder — once Claude has
//   read them (on Windows when the run ends)
// - app-icon-exec.ts: ATELIER_HOME/app-icon.json only: per installed bundle, the custom icon
//   Atelier left there and its print, 0600, atomic, removed with the last one. The icon itself is written by osascript
//   (NSWorkspace.setIcon) on the installed bundle only: see no-child-process.test.ts
const ALLOWED = new Set(['fs/write.ts', 'clipboard-image.ts', 'index.ts', 'daemon-launcher.ts', 'projects.ts', 'settings-store.ts', 'updates-ipc.ts', 'dictation/model.ts', 'bash-attributions.ts', 'app-log.ts', 'auto-update.ts', 'connectors/secret-store.ts', 'tabs-store.ts', 'shell-command-exec.ts', 'redis/picks.ts', 'databases/store.ts', 'git/trace2.ts', 'runtime-copy.ts', 'automations/guard.ts', 'automations/store.ts', 'automations/launcher.ts',
  // ATELIER_HOME/companion only: thread.json, rules.md, chat.md, facts.md, 0700/0600, atomic; whole session dir removed by retention
  'companion/store.ts', 'app-icon-exec.ts']);

test('the app icon writes only its marks, ATELIER_HOME/app-icon.json, atomically (0600 by default), or removes them', () => {
  const src = readFileSync(join(mainDir, 'app-icon-exec.ts'), 'utf8');
  expect(src).toContain("const marksFile = join(host.atelierHome, 'app-icon.json');");
  expect([...src.matchAll(/\b(writeFile(Sync)?|appendFile(Sync)?|writeFileAtomic|rm(Sync)?|unlink(Sync)?|rename(Sync)?|mkdir(Sync)?|copyFile(Sync)?|cp(Sync)?)\s*\(([^,)]*)/g)].map((m) => `${m[1]}(${m[10]}`))
    .toEqual(['rmSync(marksFile', 'writeFileAtomic(marksFile']);
  expect(src).not.toMatch(/writeFileAtomic\([^)]*,\s*0o/);
});

test('the Redis picks write only ATELIER_HOME/redis.json, atomically, 0600', () => {
  const src = readFileSync(join(mainDir, 'redis/picks.ts'), 'utf8');
  expect([...src.matchAll(/join\([^)]*\)/g)].map((m) => m[0])).toEqual(["join(home, 'redis.json')"]);
  expect([...src.matchAll(/\b(writeFile(Sync)?|appendFile(Sync)?|writeFileAtomic)\s*\(/g)].map((m) => m[0])).toEqual(['writeFileAtomic(']);
  expect(src).toContain('0o600');
});

test('the database connections write only ATELIER_HOME/databases.json, atomically, 0600', () => {
  const src = readFileSync(join(mainDir, 'databases/store.ts'), 'utf8');
  expect([...src.matchAll(/join\([^)]*\)/g)].map((m) => m[0])).toEqual(["join(home, 'databases.json')"]);
  expect([...src.matchAll(/\b(writeFile(Sync)?|appendFile(Sync)?|writeFileAtomic)\s*\(/g)].map((m) => m[0])).toEqual(['writeFileAtomic(']);
  // The one other write: an unreadable file, another version or dropped entries are renamed aside (databases.json.bad-<ts>) once,
  // before the first save would overwrite them.
  expect([...src.matchAll(/\b(renameSync|rmSync|unlinkSync)\s*\(/g)].map((m) => m[0])).toEqual(['renameSync(']);
  expect(src).toContain('0o600');
});

test('the connector secret store writes only ATELIER_HOME/connectors/<id>.bin, atomically, encrypted', () => {
  const src = readFileSync(join(mainDir, 'connectors/secret-store.ts'), 'utf8');
  expect([...src.matchAll(/join\([^)]*\)/g)].map((m) => m[0])).toEqual(["join(home, 'connectors')", 'join(dir, `${id}.bin`)']);
  expect(src).not.toMatch(/\b(homedir|tmpdir)\s*\(/);
  // The only file write is the atomic one, of the encrypted blob.
  expect([...src.matchAll(/\b(writeFile(Sync)?|appendFile(Sync)?|writeFileAtomic)\s*\(/g)].map((m) => m[0])).toEqual(['writeFileAtomic(']);
  expect(src).toContain('writeFileAtomic(file, blob, 0o600)');
  expect(src).toContain('blob = safe.encryptString(value)');
});

test('trace2 writes only its private folder and the op sockets (Windows: the op files) inside it', () => {
  const src = readFileSync(join(mainDir, 'git/trace2.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  expect([...src.matchAll(/join\((?:[^()]|\([^()]*\))*\)/g)].map((m) => m[0])).toEqual(['join(tmpdir(), `atelier-${process.pid}`)', 'join(trace2Dir(), `${++seq}.sock`)', "join(trace2Dir('win32'), `${++seq}.trace2`)"]);
  // Unlinked: only an op's socket or file path (or the live ones at quit).
  expect([...src.matchAll(/\bunlinkSync\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['path', 'path', 'path', 'p']);
  // The one regular file: the Windows op file, created empty at that path.
  expect([...src.matchAll(/\bwriteFileSync\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["path, ''"]);
  expect(src).not.toMatch(/\b(appendFile(Sync)?|writeFileAtomic|createWriteStream|rmSync|rm|copyFile(Sync)?|rename(Sync)?)\s*\(/);
  expect([...src.matchAll(/\b(mkdirSync|chmodSync|rmdirSync)\(([^,)]*)/g)].map((m) => `${m[1]}(${m[2]})`)).toEqual(['mkdirSync(d)', 'chmodSync(d)', 'rmdirSync(dir)']);
  expect(src).toContain('mode: 0o700');
});

test('the updater writes only under ATELIER_HOME/updates', () => {
  const src = readFileSync(join(mainDir, 'auto-update.ts'), 'utf8');
  // Every path it builds starts from its own folder: join(o.home, 'updates') and what derives from it.
  expect([...src.matchAll(/join\((?:this\.)?o\.home\b[^)]*\)/g)].map((m) => m[0])).toEqual(["join(o.home, 'updates')"]);
  expect(src).not.toMatch(/\b(homedir|tmpdir)\s*\(/);
});

test('write APIs only in fs/write.ts', () => {
  const offenders = files(mainDir).map((p) => posixRel(mainDir, p)).filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => WRITE_API.test(readFileSync(join(mainDir, rel), 'utf8').replace(/\/\/.*$/gm, '')));
  expect(offenders).toEqual([]);
});

test('the test really recognizes a write', () => {
  expect(WRITE_API.test('fs.writeFileSync(p, x)')).toBe(true);
  expect(WRITE_API.test('await shell.trashItem(p)')).toBe(true);
  expect(WRITE_API.test('readFileSync(p)')).toBe(false);
  // Also the write helpers shared with atelierd.
  expect(WRITE_API.test('writeFileAtomic(p, x, 0o600)')).toBe(true);
  expect(WRITE_API.test('ensureDir(dir, 0o700)')).toBe(true);
});

// atelierd writes only to its home (ATELIER_HOME): scripts and settings for Claude, socket, info, registry, logs.
// The captured shell environment is never written (shell-env.ts keeps it in memory).
const daemonDir = join(__dirname, '../../src/daemon');
// launchd.ts: the job plists, 0600 in ATELIER_HOME/run, removed once launchd holds the job.
// pty-host-server.ts: its own Unix socket (removes a stale one, chmod 0600, removes it on close).
// schedules.ts: ATELIER_HOME/schedules.json, 0600, atomic.
// signals.ts: ATELIER_HOME/claude-signals.json, 0600, atomic, content-free.
const DAEMON_ALLOWED = new Set(['fsutil.ts', 'install.ts', 'launchd.ts', 'log.ts', 'main.ts', 'pty-host-server.ts', 'registry.ts', 'schedules.ts', 'signals.ts']);

test('atelierd write APIs only in its home modules', () => {
  const offenders = files(daemonDir).map((p) => posixRel(daemonDir, p)).filter((rel) => !DAEMON_ALLOWED.has(rel))
    // A terminal's rename() method (changes the displayed name) is not a disk write.
    .filter((rel) => WRITE_API.test(readFileSync(join(daemonDir, rel), 'utf8').replace(/\/\/.*$/gm, '').replace(/\.rename\(|^\s+rename\(/gm, '')));
  expect(offenders).toEqual([]);
});

test('the Ask store writes only inside ATELIER_HOME/companion/<id>, atomically, 0700/0600', () => {
  const src = readFileSync(join(mainDir, 'companion/store.ts'), 'utf8');
  expect([...src.matchAll(/join\([^)]*\)/g)].map((m) => m[0])).toEqual(["join(this.root, sessionId)", "join(this.dirOf(sessionId)", "join(dir, 'thread.json')", "join(dir, 'rules.md')", "join(dir, 'chat.md')", "join(dir, 'facts.md')"]);
  expect([...src.matchAll(/\b(writeFile(Sync)?|appendFile(Sync)?|writeFileAtomic)\s*\(/g)].map((m) => m[0])).toEqual(['writeFileAtomic(', 'writeFileAtomic(', 'writeFileAtomic(', 'writeFileAtomic(']);
  expect(src).not.toMatch(/\b(homedir|tmpdir)\s*\(/);
  expect(src).toContain('0o700');
  expect(src).toContain('0o600');
});
