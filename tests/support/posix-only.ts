// Test files that need POSIX as a whole: vitest leaves them out on Windows only
// (vitest.config.ts); macOS and Linux run them as always. Each says why. A file that only partly needs POSIX tags those
// tests with posixOnly/posixTest instead (tests/support/platform.ts). A file moves out of here once its Windows
// counterpart arrives (named in the reason).

const D = 'src/daemon/';
const I = 'tests/integration/';

export const POSIX_ONLY_FILES: Record<string, string> = {
  // atelierd on POSIX: unix sockets, launchd jobs, the native pty host, zsh (Windows: pipes, ConPTY, PowerShell).
  [`${D}pty-host-native.test.ts`]: 'the native pty host is built with clang and runs POSIX ptys',
  [`${D}pty-host-server.test.ts`]: 'unix socket server',
  [`${D}session-pty.test.ts`]: 'launchd jobs and the native pty host',
  [`${D}shell-env.test.ts`]: "the user's zsh",
  [`${D}launchd.test.ts`]: 'launchd',
  [`${D}install.test.ts`]: 'zsh and sh wrappers, nc -U bridges',
  [`${D}profiles.test.ts`]: '/etc/shells',
  'src/shared/paths.node.test.ts': "macOS's Application Support home and unix socket paths",
  'src/main/daemon-launcher.test.ts': 'launchd and /bin/ps',
  [`${I}bridges.test.ts`]: 'unix socket bridges (sh + nc -U)',
  [`${I}daemon.test.ts`]: 'atelierd over a unix socket',
  [`${I}daemon-client.test.ts`]: 'atelierd over a unix socket',
  [`${I}flood.test.ts`]: 'atelierd over a unix socket',
  [`${I}profiles.test.ts`]: 'atelierd over a unix socket, zsh and bash profiles',
  [`${I}session-names.test.ts`]: 'atelierd over a unix socket',
  [`${I}sessions.test.ts`]: 'atelierd over a unix socket',
  [`${I}snapshot.test.ts`]: 'atelierd over a unix socket',
  [`${I}terminals.test.ts`]: 'POSIX shells in ptys',
  [`${I}zsh.test.ts`]: "zsh and atelierd's zsh integration",
  [`${I}isolation.test.ts`]: 'launchd jobs and the native pty host',
  // macOS-only features.
  [`${I}tmux.test.ts`]: 'tmux (the Services view is hidden on Windows)',
  [`${I}docker-engine.test.ts`]: "a fake Docker engine on a unix socket (Windows: the docker_engine pipe)",
  [`${I}docker-hub.test.ts`]: "a fake Docker engine on a unix socket",
  'src/main/docker/detect.test.ts': 'Docker unix sockets and contexts (Windows: npipe)',
  [`${I}ports.test.ts`]: 'lsof and ps (Windows: netstat and the process tree)',
  [`${I}work-scan.test.ts`]: 'ps',
  'src/main/git/trace2.test.ts': "git trace2 over af_unix sockets (Windows: a trace file)",
  'src/main/updates.test.ts': "macOS's app swap (the Store updates the app on Windows)",
  [`${I}auto-update.test.ts`]: 'codesign, ditto and .app bundles',
  [`${I}sign-app.test.ts`]: 'codesign and Mach-O',
  [`${I}atelier-cli.test.ts`]: "the sh 'atelier' command",
  'src/main/dictation/engine.test.ts': 'a #! fake whisper started directly (Windows: atelier-whisper.exe)',
  'src/main/fs/claude-images.test.ts': "Claude Code's /tmp/claude-<uid> folder and its owner checks",
  'src/main/git/write.integration.test.ts': 'sh hooks and file names Windows forbids (:(glob)*) in a real repo',
  'src/main/companion/run.test.ts': 'a #! fake claude started directly (Windows: claude.exe)',
  'src/main/companion/service.test.ts': "native temp project roots (C:\\…) while the suite runs as darwin, which companionArgs refuses (its Windows forms: args.test.ts), and symlinks",
  'src/main/companion/ipc.test.ts': "native temp project paths through the IPC path schemas the suite runs posix-style, and symlinks",
  'src/main/scm/message.test.ts': 'a #! fake claude started directly (Windows: claude.exe)',
  [`${I}db-ssh.test.ts`]: "a #! fake ssh started directly as the tunnel's binary (Windows: OpenSSH's ssh.exe)",
  // Build tooling that runs on the Mac (the site deploys from it).
  [`${I}demo-build.test.ts`]: "the website demo's build (vite worker paths), run on macOS where the site deploys from"
};

/** The files vitest leaves out on this machine. */
export const posixOnlyExcludes = (platform: string): string[] => (platform === 'win32' ? Object.keys(POSIX_ONLY_FILES) : []);
