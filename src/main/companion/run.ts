import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { within, parseStreamLine, type StreamItem } from '@shared/companion/stream';
import type { CompanionErrorKind, LimitWindow } from '@shared/companion/types';
import { pathStyle, type PathStyle } from '@shared/platform';
import { childOptions, signalTree } from '../proc-tree';
import { toOut } from '../cpath';
import { polishEnv } from '../dictation/polish';

// The only place Ask spawns its isolated read-only `claude -p`: the question on stdin,
// stream-json parsed line by line into items, its own process group so Stop, a timeout and quit kill it whole.

export const COMPANION_TIMEOUT_MS = {
  question: { haiku: 90_000, sonnet: 120_000, opus: 180_000 },
  catchup: { haiku: 150_000, sonnet: 180_000, opus: 240_000 }
};
// stream-json echoes every tool result, so one run can legitimately pass 1 MiB: a line and the whole run have caps.
export const RUN_LINE_MAX = 8 * 1024 * 1024;
export const RUN_OUTPUT_MAX = 32 * 1024 * 1024;

export type RunOutcome =
  | { ok: true; text: string; structured: unknown; costUsd: number | null; read: string[] }
  | { ok: false; kind: CompanionErrorKind; message: string; resetsAt?: number; window?: LimitWindow };

const firstLine = (s: string) => s.trim().split('\n', 1)[0]!.trim().slice(0, 200);

/** A folder as given and by its real path (symlinks resolved): Claude reports paths by either. */
function spellings(p: string): string[] {
  let real = p;
  try { real = toOut(realpathSync(p)); } catch { /* as given */ }
  return real === p ? [p] : [p, real];
}

/**
 * The project file a Read names (relative to the root, `/`-separated), or null: outside the project, or one of the
 * thread's own files. Windows: the model's C:\… against roots spelled either way, any case.
 */
export function projectRead(file: string, roots: { thread: string[]; project: string[] }, style: PathStyle = pathStyle()): string | null {
  if (roots.thread.some((r) => within(r, file, style) !== null)) return null;
  for (const r of roots.project) {
    const rel = within(r, file, style);
    if (rel !== null) return rel;
  }
  return null;
}

export function runCompanion(o: {
  claudeBin: string; args: string[]; cwd: string; projectRoot: string; configDir?: string; input: string;
  onItem: (i: StreamItem) => void; signal?: AbortSignal; timeoutMs: number;
}): Promise<RunOutcome> {
  if (o.signal?.aborted) return Promise.resolve({ ok: false, kind: 'stopped', message: 'Stopped' });
  return new Promise((resolve) => {
    let settled = false;
    let out = 0;
    let pending = '';
    let stderr = '';
    let result: Extract<StreamItem, { t: 'result' }> | null = null;
    let rate: Extract<StreamItem, { t: 'rate' }> | null = null;
    const read: string[] = [];
    const roots = { thread: spellings(o.cwd), project: spellings(o.projectRoot) };
    const env = { ...polishEnv(o.claudeBin, process.env, o.configDir), CLAUDE_CODE_ENTRYPOINT: 'atelier-ask' };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(o.claudeBin, o.args, { cwd: o.cwd, env, ...childOptions(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve(e.code === 'ENOENT' ? { ok: false, kind: 'not-found', message: 'Claude Code was not found' } : { ok: false, kind: 'exit', message: e.message });
      return;
    }
    const finish = (r: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const stop = (kind: CompanionErrorKind, message: string) => { signalTree(child, 'SIGKILL'); finish({ ok: false, kind, message }); };
    const onAbort = () => stop('stopped', 'Stopped');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout', "Claude didn't answer in time"), o.timeoutMs);

    const take = (line: string) => {
      for (const item of parseStreamLine(line)) {
        if (item.t === 'result') result = item;
        else if (item.t === 'rate') rate = item;
        else if (item.t === 'tool' && item.name === 'Read' && typeof item.input === 'object' && item.input !== null) {
          const file = (item.input as { file_path?: unknown }).file_path;
          const rel = typeof file === 'string' ? projectRead(file, roots) : null;
          if (rel !== null && !read.includes(rel)) read.push(rel);
        }
        o.onItem(item);
      }
    };

    child.stdin.on('error', () => { /* claude exited before reading it all: its exit tells */ });
    child.stdin.end(o.input);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s: string) => {
      if (settled) return;
      out += Buffer.byteLength(s);
      if (out > RUN_OUTPUT_MAX) { stop('exit', 'Claude wrote too much'); return; }
      pending += s;
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line) take(line);
      }
      if (pending.length > RUN_LINE_MAX) stop('exit', 'Claude wrote too much');
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s: string) => { if (stderr.length < 8192) stderr += s; });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') finish({ ok: false, kind: 'not-found', message: 'Claude Code was not found' });
      else finish({ ok: false, kind: 'exit', message: err.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (pending) take(pending);
      pending = '';
      const res = result as Extract<StreamItem, { t: 'result' }> | null;
      const lim = rate as Extract<StreamItem, { t: 'rate' }> | null;
      if (res && !res.isError) { finish({ ok: true, text: res.text, structured: res.structured, costUsd: res.costUsd, read }); return; }
      const failed = code !== 0 || (res?.isError ?? false);
      if (failed && (res?.apiStatus === 429 || (lim !== null && lim.status !== 'allowed' && lim.status !== 'allowed_warning'))) {
        finish({ ok: false, kind: 'limit', message: 'Usage limit reached', ...(lim?.resetsAt != null ? { resetsAt: lim.resetsAt } : {}), ...(lim?.window ? { window: lim.window } : {}) });
        return;
      }
      if (code !== 0) { finish({ ok: false, kind: 'exit', message: firstLine(stderr) || (res?.isError ? firstLine(res.text) : '') || `claude exited with ${code ?? signal}` }); return; }
      if (!res) { finish({ ok: false, kind: 'exit', message: 'Claude ended without an answer' }); return; }
      finish({ ok: false, kind: 'exit', message: firstLine(res.text) || 'Claude ended without an answer' });
    });
  });
}
