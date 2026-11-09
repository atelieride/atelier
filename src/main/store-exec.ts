import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { StoreRun, StoreRunner } from './store-updates';

// Runs atelier-store.exe (native/atelier-store.cpp): app binary, fixed argv
// (`check` or `update`), no shell, no window, stdout only, a timeout and an output cap; stopped when either is hit.

const MAX_OUT = 64 * 1024;
const CHECK_MS = 60_000;
const UPDATE_MS = 20 * 60_000;

/** One run; `onLine` gets each complete line as it arrives. Never rejects: a run that can't start has code null. */
export function runStore(file: string, args: readonly string[], timeoutMs: number, onLine?: (line: string) => void): Promise<StoreRun> {
  return new Promise((resolve) => {
    let out = '';
    let pending = '';
    let stopped = false;
    let child: ChildProcessByStdio<null, Readable, null>;
    // spawn can throw on the spot (a path it refuses, a launch policy): a run without answer, like one that can't start.
    try { child = spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve({ code: null, out: '' }); return; }
    const stop = () => { stopped = true; child.kill(); };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stopped) return;
      if (out.length + d.length > MAX_OUT) { stop(); return; }
      out += d;
      if (!onLine) return;
      pending += d;
      for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
        onLine(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: stopped ? null : code, out }); });
  });
}

/** The real helper, at its path in the app (resources\bin) or in vendor\bin for dev runs. */
export function helperRunner(exe: string): StoreRunner {
  return {
    check: () => runStore(exe, ['check'], CHECK_MS),
    update: (onLine) => runStore(exe, ['update'], UPDATE_MS, onLine)
  };
}

interface FakeScript { checks: string[]; update?: { lines: string[]; code?: number; intervalMs?: number } }

/**
 * Tests only (ATELIER_TEST_STORE through devEnv, inert when packaged): a JSON script in place of the Store. Each check
 * answers the next of `checks` (the last one repeats); an update prints `lines`, one every `intervalMs`.
 */
export function fakeRunner(file: string): StoreRunner {
  let n = 0;
  const script = () => JSON.parse(readFileSync(file, 'utf8')) as FakeScript;
  return {
    check: async () => {
      const checks = script().checks;
      const out = checks[Math.min(n++, checks.length - 1)] ?? '';
      return { code: /^error /m.test(out) ? 1 : 0, out };
    },
    update: async (onLine) => {
      const u = script().update ?? { lines: ['done none'] };
      let out = '';
      for (const l of u.lines) {
        await new Promise((r) => setTimeout(r, u.intervalMs ?? 100));
        out += `${l}\n`;
        onLine(l);
      }
      return { code: u.code ?? 0, out };
    }
  };
}
