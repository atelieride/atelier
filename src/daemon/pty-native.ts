import { createRequire } from 'node:module';

/**
 * node-pty's native primitives (the same pty.node its spawn uses): open a PTY pair, resize it, read the name of its
 * foreground process. Isolated terminals open the PTY here and let a launchd job start the
 * shell on its slave. Loaded once, through node-pty's own loader (build/, then prebuilds/, unpacked from the asar).
 */
export interface PtyNative {
  open(cols: number, rows: number): { master: number; slave: number; pty: string };
  resize(fd: number, cols: number, rows: number): void;
  process(fd: number): string | undefined;
}

// pty.node's open() leaves both fds without FD_CLOEXEC. Safe because every spawn on macOS goes through posix_spawn with
// POSIX_SPAWN_CLOEXEC_DEFAULT (libuv, node-pty): a fork-based spawn added to atelierd would leak them into children
// (and a leaked master keeps shells from getting SIGHUP when atelierd dies).
let loaded: PtyNative | null = null;

export function ptyNative(): PtyNative {
  if (!loaded) {
    const req = createRequire(__filename);
    const utils = req('node-pty/lib/utils') as { loadNativeModule(name: string): { module: PtyNative } };
    loaded = utils.loadNativeModule('pty').module;
  }
  return loaded;
}
