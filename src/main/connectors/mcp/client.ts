// A minimal MCP client for a connector's official server: streamable HTTP, JSON-RPC,
// protocol 2025-06-18, no session id needed (one is echoed back if the server sends one). initialize →
// notifications/initialized once per client, then tools/list and tools/call. Replies come as application/json or as
// text/event-stream. One client per connector, parameterized by that connector's ToolSet (mcp/toolset.ts).
//
// READ-ONLY: the tokens these servers issue can write (ClickUp ignores scope=read), so
// the allowlist is the barrier, and it has two parts: `callTool` refuses every name the client's `tools.isAllowed`
// does not accept (an exact string match against a Set private to the ToolSet) before it touches the arguments or
// builds a request, and each connector's tools.ts holds the only copy of its names. There is no other way to send
// tools/call: no generic "call tool" IPC, and tests/integration/connectors-readonly.test.ts keeps `tools/call` in this
// file only and every connector's tool names inside its own directory.
//
// Every failure is a typed ConnectorError (errors.ts) whose message is ours: the token never reaches one.
import { z } from 'zod';
import { redactSecrets } from '@shared/session';
import { redactCredentials } from '../../app-log';
import { Aborted, NotAllowed, Forbidden, RateLimited, SchemaChanged, ToolError, Unauthorized, Unreachable } from '../errors';
import { requestText, type TextResponse, type Transport } from '../http';
import type { AnyToolSet, ToolArgs, ToolName, ToolReply } from './toolset';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** A non-core field: missing or malformed → undefined (never fails the reply). */
const opt = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);
/** An array whose malformed items are skipped instead of failing the whole reply. */
const lenientArray = <T extends z.ZodType>(item: T) => z.array(z.unknown()).transform((items) =>
  items.flatMap((i) => { const r = item.safeParse(i); return r.success ? [r.data as z.output<T>] : []; }));

// ── Rate limits ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;
/** A reset already past (clocks apart) would retry at once, again and again, keeping the token rate-limited. */
export const MIN_RATE_LIMIT_WAIT_MS = 5_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
/** Below this (2001-09-09 in unix seconds) `x-ratelimit-reset` is a number of seconds from now, as some servers send. */
const EPOCH_FLOOR_S = 1e9;

/**
 * `x-ratelimit-reset` (unix seconds, or seconds from now when small) → ms since the epoch, between now + 5 s and
 * now + 5 min; without it, `Retry-After` (seconds from now, Atlassian) within the same bounds; missing/garbage → 1 min.
 */
export function rateLimitResetAt(header: string | undefined, now: number, retryAfter?: string): number {
  const num = (h: string | undefined) => (h === undefined || h.trim() === '' ? NaN : Number(h));
  const clamp = (at: number) => Math.min(Math.max(at, now + MIN_RATE_LIMIT_WAIT_MS), now + MAX_RATE_LIMIT_WAIT_MS);
  const s = num(header);
  if (Number.isFinite(s)) return clamp(s < EPOCH_FLOOR_S ? now + Math.round(s * 1000) : Math.round(s * 1000));
  const after = num(retryAfter);
  if (Number.isFinite(after) && after >= 0) return clamp(now + Math.round(after * 1000));
  return now + DEFAULT_RATE_LIMIT_WAIT_MS;
}

// ── The client ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface McpClientOptions {
  /** `${base}/mcp` (config.ts). */
  mcpUrl: string;
  /** The one allowed origin (config.ts), checked per request and per redirect. */
  allow(u: URL): boolean;
  transport: Transport;
  /** The Bearer token, or with `basicUser` the API token. Sent only in the Authorization header; never in an error. */
  token: string;
  /** An API-token connection: `Basic base64(basicUser:token)` instead of Bearer. */
  basicUser?: string;
  /** Per HTTP request (default 20 s). */
  timeoutMs?: number;
  /** Per reply (default 4 MB). */
  maxBytes?: number;
  clientVersion?: string;
  now?: () => number;
}

export interface CallOptions { signal?: AbortSignal }

export interface McpClient<T extends AnyToolSet = AnyToolSet> {
  /** Calls one allowlisted tool and parses its data. Anything else → NotAllowed, before any request. */
  callTool<N extends ToolName<T>>(name: N, args: ToolArgs<T, N>, o?: CallOptions): Promise<ToolReply<T, N>>;
  /** The server's tool names (for missingTools → `unavailable`). */
  listTools(o?: CallOptions): Promise<string[]>;
}

const MAX_TOOL_ERROR = 200;
const MAX_TOOL_PAGES = 10;
const SESSION_ID = /^[\x21-\x7e]{1,256}$/;

const rpcMessage = z.object({
  id: z.union([z.number(), z.string()]).nullable().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.number() }).loose().optional()
});

function sseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r\n\r\n|\n\n|\r\r/)) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (line === '' || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (event !== 'message' || data.length === 0) continue;
    try { out.push(JSON.parse(data.join('\n'))); } catch { /* not ours to read */ }
  }
  return out;
}

/** A tool error's scrubbed text, uncut: one line, no control characters, no credentials, ≤ 4000 characters. */
function scrubFull(text: string, secrets: readonly string[]): string {
  let s = text.slice(0, 16_000).replace(/[\t\n\r]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  for (const secret of secrets) if (secret) s = s.split(secret).join('…');
  return redactSecrets(redactCredentials(s)).trim().slice(0, 4000);
}

/** The server's own error text for a ToolError: one line, no control characters, no credentials, ≤ 200 characters. */
function scrubToolText(text: string, secrets: readonly string[]): string {
  const s = scrubFull(text, secrets);
  if (s.length <= MAX_TOOL_ERROR) return s;
  let cut = s.slice(0, MAX_TOOL_ERROR - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Internal: the server forgot our session. Never escapes the client (retried once, then SchemaChanged). */
class SessionEnded extends Error {}

const toolResult = z.object({ content: opt(z.array(z.unknown())), isError: opt(z.boolean()), structuredContent: opt(z.unknown()) });
const textItem = z.object({ type: z.literal('text'), text: z.string() });
const toolsList = z.object({ tools: lenientArray(z.object({ name: z.string() })), nextCursor: opt(z.string()) });

export function createMcpClient<T extends AnyToolSet>(o: McpClientOptions & { tools: T }): McpClient<T> {
  const now = o.now ?? Date.now;
  let nextId = 1;
  let sessionId: string | undefined;
  let ready: Promise<void> | null = null;

  const basic = o.basicUser === undefined ? null : Buffer.from(`${o.basicUser}:${o.token}`).toString('base64');
  const authorization = basic === null ? `Bearer ${o.token}` : `Basic ${basic}`;
  const secrets = basic === null ? [o.token] : [basic, o.token];

  async function post(message: object, signal: AbortSignal | undefined): Promise<TextResponse> {
    const headers: Record<string, string> = {
      authorization,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await requestText(o.transport, { method: 'POST', url: o.mcpUrl, headers, body: JSON.stringify(message) },
      { allow: o.allow, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, signal });
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status === 401) throw new Unauthorized();
    if (res.status === 403) throw new Forbidden();
    if (res.status === 429) throw new RateLimited(rateLimitResetAt(res.headers['x-ratelimit-reset'], now(), res.headers['retry-after']));
    if (res.status >= 500) throw new Unreachable('server', res.status);
    // A 404 to a request carrying a session id: that session ended (MCP spec); the caller starts a new one, once.
    if (res.status === 404 && headers['mcp-session-id']) { sessionId = undefined; ready = null; throw new SessionEnded(); }
    throw new SchemaChanged(`HTTP ${res.status} from the MCP endpoint`);
  }

  /** One JSON-RPC request; resolves with its `result` object and the HTTP response (headers). */
  async function request(method: string, params: object, signal: AbortSignal | undefined): Promise<{ result: Record<string, unknown>; res: TextResponse }> {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params }, signal);
    let messages: unknown[];
    if ((res.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream')) {
      messages = sseMessages(res.text);
    } else {
      let body: unknown;
      try { body = JSON.parse(res.text); } catch { throw new SchemaChanged(`${method}: the reply is not JSON`); }
      messages = Array.isArray(body) ? body : [body];
    }
    for (const m of messages) {
      const r = rpcMessage.safeParse(m);
      if (!r.success || r.data.id !== id) continue;
      if (r.data.error) throw new SchemaChanged(`${method}: JSON-RPC error ${r.data.error.code}`);
      if (r.data.result) return { result: r.data.result, res };
    }
    throw new SchemaChanged(`${method}: no reply`);
  }

  /**
   * The shared handshake. It runs with no caller's signal (each request has its own timeout): concurrent callers share
   * it, so one caller's Cancel must not fail the others. Each caller waits for it through untilReady(signal).
   */
  function ensureReady(): Promise<void> {
    if (ready) return ready;
    const p = (async () => {
      sessionId = undefined;
      const { result, res } = await request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Atelier', version: o.clientVersion ?? '0' }
      }, undefined);
      if (result.protocolVersion !== MCP_PROTOCOL_VERSION) throw new SchemaChanged('unsupported MCP protocol version');
      const sid = res.headers['mcp-session-id'];
      if (sid !== undefined) {
        if (!SESSION_ID.test(sid)) throw new SchemaChanged('malformed MCP session id');
        sessionId = sid;
      }
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, undefined);
    })();
    ready = p;
    p.catch(() => { if (ready === p) { ready = null; sessionId = undefined; } });
    return p;
  }

  /** Waits for the shared handshake; this caller's signal rejects only this caller (Aborted). */
  function untilReady(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Aborted());
    const p = ensureReady();
    if (!signal) return p;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Aborted());
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** Runs `fn` in an initialized session; if the server says the session ended, starts a new one and retries once. */
  async function inSession<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        await untilReady(signal);
        return await fn();
      } catch (e) {
        if (!(e instanceof SessionEnded)) throw e;
        if (attempt > 0) throw new SchemaChanged('the MCP session keeps ending');
      }
    }
  }

  return {
    async callTool(name, args, opts = {}) {
      // The allowlist comes first: nothing about a refused call is read, built or sent.
      if (!o.tools.isAllowed(name)) throw new NotAllowed();
      const parsedArgs = o.tools.parseArgs(name, args);
      const { result } = await inSession(opts.signal, () => request('tools/call', { name, arguments: parsedArgs }, opts.signal));
      const r = toolResult.safeParse(result);
      if (!r.success) throw new SchemaChanged(`unexpected ${name} result`);
      const texts = (r.data.content ?? []).flatMap((c) => { const t = textItem.safeParse(c); return t.success ? [t.data.text] : []; });
      if (r.data.isError) throw new ToolError(name, scrubToolText(texts.join(' '), secrets), scrubFull(texts.join(' '), secrets));
      let data: unknown;
      if (texts.length > 0) {
        try { data = JSON.parse(texts[0]!); } catch { throw new SchemaChanged(`${name}: the data is not JSON`); }
      } else if (r.data.structuredContent && typeof r.data.structuredContent === 'object') {
        data = r.data.structuredContent;
      } else {
        throw new SchemaChanged(`${name}: no data`);
      }
      return o.tools.parseReply(name, data);
    },

    listTools(opts = {}) {
      return inSession(opts.signal, async () => {
        const names: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          const { result } = await request('tools/list', cursor ? { cursor } : {}, opts.signal);
          const r = toolsList.safeParse(result);
          if (!r.success) throw new SchemaChanged('unexpected tools/list result');
          names.push(...r.data.tools.map((t) => t.name));
          cursor = r.data.nextCursor;
          if (!cursor) break;
        }
        return names;
      });
    }
  };
}
