import globalTempRoot from './global-temp-root';
import { checkoutRoot, lockFile, releaseLock, takeLock, type LockInfo } from './e2e-lock';

// Playwright's global setup (both configs; vitest uses global-temp-root.ts without the lock): one e2e run at a time on this Mac,
//then the run's own temp root. The teardown cleans the temp root first (its atelierds and
// launchd jobs) so the next run starts on a quiet machine, then releases the lock.

interface Deps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  pid: number;
  argv: string[];
  now: () => number;
  log: (line: string) => void;
  lockFile: (cwd: string) => string | null;
  takeLock: (path: string, info: LockInfo, o: { root?: string }) => Promise<void>;
  releaseLock: (path: string, pid: number) => boolean;
  tempRoot: () => () => void;
  onExit: (f: () => void) => void;
}

const real: Deps = {
  env: process.env,
  cwd: process.cwd(),
  pid: process.pid,
  argv: process.argv,
  now: Date.now,
  log: (l) => console.log(l),
  lockFile,
  takeLock: (p, i, o) => takeLock(p, i, o),
  releaseLock,
  tempRoot: globalTempRoot,
  onExit: (f) => process.once('exit', f)
};

export function makeGlobalE2e(d: Deps = real): () => Promise<() => Promise<void>> {
  return async () => {
    let lock: string | null = null;
    if (d.env.ATELIER_E2E_NO_LOCK === '1') d.log('e2e lock skipped (ATELIER_E2E_NO_LOCK=1).');
    else {
      lock = d.lockFile(d.cwd);
      if (!lock) d.log('Not in a git checkout: no e2e lock.');
      else {
        const what = d.argv.slice(1).map((a) => a.replace(/^.*\/node_modules\/(\.bin\/)?/, '')).join(' ');
        await d.takeLock(lock, { pid: d.pid, startedAt: d.now(), cwd: d.cwd, what }, { root: checkoutRoot(lock) });
        const held = lock;
        d.onExit(() => d.releaseLock(held, d.pid));
      }
    }
    const tempTeardown = d.tempRoot();
    return async () => {
      try {
        tempTeardown();
      } finally {
        if (lock) d.releaseLock(lock, d.pid);
      }
    };
  };
}

export default makeGlobalE2e();
