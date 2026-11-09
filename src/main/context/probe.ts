import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { controlLine, parseMcpStatus, type ContextErrorKind, type McpServerStatus } from '@shared/context-usage';
import { currentPlatform, type Platform } from '@shared/platform';
import { childOptions, signalTree } from '../proc-tree';

// The only place Context usage spawns Claude Code: a private copy of the session
// (`contextArgs`: stream-json, --fork-session, --no-session-persistence, the user's hooks off), argv only, no shell, its
// own process group so a timeout, a stop and quitting kill it with the MCP servers it started. It is asked
// `initialize`, then `mcp_status` until no server is pending (at most mcpWaitMs), then `get_context_usage`; nothing is
// ever sent to the model.

export const PROBE_TIMEOUT_MS = 45_000;
export const MCP_WAIT_MS = 20_000;
const POLL_MS = 300;
const LINE_MAX = 4 * 1024 * 1024;
const OUTPUT_MAX = 8 * 1024 * 1024;

export type ProbeSpawn = (bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; windowsHide: true; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;
export type ProbeOutcome = { ok: true; usage: unknown; status: McpServerStatus[] } | { ok: false; kind: ContextErrorKind; message: string };
export type ProbePhase = { phase: 'start' } | { phase: 'mcp'; connected: number; total: number } | { phase: 'count' };

const firstLine = (s: string) => s.trim().split('\n', 1)[0]!.trim().slice(0, 200);

export function runProbe(o: {
  claudeBin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  onProgress?: (p: ProbePhase) => void; signal?: AbortSignal;
  timeoutMs?: number; mcpWaitMs?: number; pollMs?: number; lineMax?: number; graceMs?: number; platform?: Platform;
  spawn?: ProbeSpawn; kill?: (child: ChildProcessWithoutNullStreams, sig: 'SIGTERM' | 'SIGKILL') => void;
}): Promise<ProbeOutcome> {
  if (o.signal?.aborted) return Promise.resolve({ ok: false, kind: 'exit', message: 'Stopped' });
  const kill = o.kill ?? ((c, sig) => signalTree(c, sig));
  const lineMax = o.lineMax ?? LINE_MAX;
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (o.spawn ?? (nodeSpawn as unknown as ProbeSpawn))(o.claudeBin, o.args, { cwd: o.cwd, env: o.env, ...childOptions(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve(e.code === 'ENOENT' ? { ok: false, kind: 'not-found', message: 'Claude Code was not found' } : { ok: false, kind: 'exit', message: e.message });
      return;
    }
    let settled = false;
    let out = 0;
    let pending = '';
    let stderr = '';
    let status: McpServerStatus[] = [];
    let polls = 0;
    let poller: ReturnType<typeof setTimeout> | null = null;
    // The MCP wait counts from initialize's answer: a slow start (a big transcript) doesn't eat it.
    let mcpFrom = Date.now();
    const send = (id: string, subtype: 'initialize' | 'mcp_status' | 'get_context_usage') => {
      if (!settled && child.stdin.writable) child.stdin.write(controlLine(id, subtype));
    };
    const finish = (r: ProbeOutcome, sig: 'SIGTERM' | 'SIGKILL') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poller) clearTimeout(poller);
      o.signal?.removeEventListener('abort', onAbort);
      try { child.stdin.end(); } catch { /* already gone */ }
      kill(child, sig);
      // A moment later the whole group gets SIGKILL: an MCP server that ignores SIGTERM outlives claude itself. On
      // Windows taskkill /T /F already took the tree; only a claude still there is killed again.
      if (sig === 'SIGTERM') {
        const win = (o.platform ?? currentPlatform()) === 'win32';
        setTimeout(() => { if (!win || ((child.exitCode ?? null) === null && (child.signalCode ?? null) === null)) kill(child, 'SIGKILL'); }, o.graceMs ?? 2_000).unref?.();
      }
      resolve(r);
    };
    const onAbort = () => finish({ ok: false, kind: 'exit', message: 'Stopped' }, 'SIGKILL');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish({ ok: false, kind: 'timeout', message: "Claude Code didn't answer in time" }, 'SIGKILL'), o.timeoutMs ?? PROBE_TIMEOUT_MS);

    const askUsage = () => { o.onProgress?.({ phase: 'count' }); send('usage', 'get_context_usage'); };
    const poll = () => { poller = null; send(`status-${++polls}`, 'mcp_status'); };
    const take = (line: string) => {
      let m: unknown;
      try { m = JSON.parse(line); } catch { return; }
      if (!m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'control_response') return;
      const r = (m as { response?: { request_id?: unknown; subtype?: unknown; response?: unknown; error?: unknown } }).response;
      if (!r || typeof r.request_id !== 'string') return;
      const failed = r.subtype !== 'success';
      if (r.request_id === 'init') { mcpFrom = Date.now(); poll(); return; }
      if (r.request_id.startsWith('status-')) {
        if (failed) { askUsage(); return; }
        status = parseMcpStatus(r.response);
        // Servers that need a sign-in, failed or are off never connect here: counted apart by the view, not waited for.
        const connecting = status.filter((s) => s.status === 'connected' || s.status === 'pending');
        o.onProgress?.({ phase: 'mcp', connected: connecting.filter((s) => s.status === 'connected').length, total: connecting.length });
        const waiting = status.some((s) => s.status === 'pending');
        if (waiting && Date.now() - mcpFrom < (o.mcpWaitMs ?? MCP_WAIT_MS)) poller = setTimeout(poll, o.pollMs ?? POLL_MS);
        else askUsage();
        return;
      }
      if (r.request_id === 'usage') {
        if (failed) finish({ ok: false, kind: 'unsupported', message: typeof r.error === 'string' ? firstLine(r.error) : 'Claude Code did not report its context' }, 'SIGTERM');
        else finish({ ok: true, usage: r.response, status }, 'SIGTERM');
      }
    };

    child.stdin.on('error', () => { /* claude exited before reading it all: its exit tells */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s: string) => {
      if (settled) return;
      out += Buffer.byteLength(s);
      pending += s;
      if (out > OUTPUT_MAX || (pending.indexOf('\n') < 0 && pending.length > lineMax)) { finish({ ok: false, kind: 'exit', message: 'Claude Code wrote too much' }, 'SIGKILL'); return; }
      let nl: number;
      while (!settled && (nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.length > lineMax) { finish({ ok: false, kind: 'exit', message: 'Claude Code wrote too much' }, 'SIGKILL'); return; }
        if (line) take(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s: string) => { if (stderr.length < 8192) stderr += s; });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? { ok: false, kind: 'not-found', message: 'Claude Code was not found' } : { ok: false, kind: 'exit', message: err.message }, 'SIGKILL');
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      // Claude Code's own warnings (a sign-in about to expire) come first: the line that says why it stopped is the
      // first one that isn't a warning.
      const why = stderr.split('\n').map((l) => l.trim()).find((l) => l && !/^warning\b/i.test(l));
      finish({ ok: false, kind: 'exit', message: (why ? firstLine(why) : '') || `claude exited with ${code ?? signal}` }, 'SIGKILL');
    });

    o.onProgress?.({ phase: 'start' });
    send('init', 'initialize');
  });
}
