// The OAuth callback listener for every connector: Node's http server on 127.0.0.1 only, a free port the OS
// picks, one random path `/callback/<16 random bytes, hex>`. It takes exactly one callback on that path: the first one
// is checked (state, iss) and settles the flow; the browser repeating that same URL (a retry, a reload) gets the same
// page again, and any other later one is refused with a 400 page and aborts the flow (a different second callback means
// someone else is answering for the server). Other paths get a 404 and change nothing (a browser asks for
// /favicon.ico). A Client ID Metadata Document client (Jira) uses exactly `/callback` on
// one of the ports its document lists instead: state and PKCE still guard it. The pages are tiny, self-contained and Atelier-branded: no external resource, a CSP that allows only
// their own inline style, no referrer (the callback URL carries the code). The listener closes with the flow.
//
// This module only listens; it never makes a request. tests/integration/connectors-readonly.test.ts allows its http
// import for that reason and checks it binds 127.0.0.1 only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Aborted, AuthFailed } from '../errors';

export type CallbackResult = { kind: 'code'; code: string } | { kind: 'denied' } | { kind: 'error'; description: string };

export interface LoopbackOptions {
  /** The `state` sent with the authorize URL. */
  state: string;
  /** The connector's name in the pages' copy ("ClickUp", "Notion"). */
  connectorName: string;
  /** The `iss` the callback must carry (the authorization server's issuer). */
  issuer: string;
  /**
   * False when the server doesn't advertise `iss` on callbacks (RFC 9207, section 2.4; Atlassian): a callback without one is
   * taken, one with a different one is still refused. Default true (ClickUp, Notion).
   */
  issRequired?: boolean;
  /** A Client ID Metadata Document lists its redirects: exactly `/callback`, on one of `ports`. */
  fixedPath?: boolean;
  /** The ports to try, in order, one attempt each (0 = any); absent = any free port, `attempts` times. */
  ports?: readonly number[];
  /** A request broke the one-shot rule or failed the checks: the flow must stop. */
  onViolation(): void;
  /** Tests: how a server is bound (default: listenLoopback). */
  bind?: (server: Server, port: number) => Promise<void>;
  /** Tries before giving up (default 4: the first port and 3 retries). */
  attempts?: number;
}

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback/<hex>`. */
  redirectUri: string;
  /** The first callback on the path: a code or an OAuth error; rejects with AuthFailed('verify') or Aborted (closed). */
  result: Promise<CallbackResult>;
  /** The test follower (ATELIER_TEST_FOLLOW_AUTH): a callback URL through the same checks as an HTTP request. */
  deliver(url: string): void;
  close(): void;
}

const DEFAULT_ATTEMPTS = 4;
/** An OAuth code: printable ASCII without spaces, bounded (Atlassian's are JWTs of several KB; Node caps the request line at 16 KB). */
const CODE = /^[\x21-\x7e]{1,12288}$/;
const MAX_DESCRIPTION = 120;

/** Binds a server to 127.0.0.1 on `port` (0: a port the OS picks). */
export function listenLoopback(server: Server, port = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** The server's error_description for display: one line, no control characters, at most 120 characters. */
export function cleanDescription(s: string): string {
  const one = s.replace(/[\t\n\v\f\r]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (one.length <= MAX_DESCRIPTION) return one;
  let cut = one.slice(0, MAX_DESCRIPTION - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A callback's `state`. */
const q0 = (u: URL): string | null => u.searchParams.get('state');

function sameSecret(a: string | null, b: string): boolean {
  if (a === null) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.byteLength === y.byteLength && timingSafeEqual(x, y);
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// Aurora colors as literal values: this page is served to the user's browser, outside the renderer and its tokens.
const STYLE = [
  'html{color-scheme:dark}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08080F;color:#EEEDFF;',
  'font:14px/1.5 system-ui,-apple-system,sans-serif}',
  'main{max-width:380px;margin:24px;padding:32px 28px;border-radius:14px;background:#10101C;',
  'border:1px solid #1B1B2E;box-shadow:0 18px 48px rgba(0,0,0,.45);text-align:center}',
  '.mark{width:44px;height:44px;margin:0 auto 18px;border-radius:12px;display:grid;place-items:center;',
  'background:linear-gradient(135deg,#8B5CF6,#EC4899);color:#fff;font-weight:700;font-size:22px;',
  'box-shadow:0 0 24px rgba(139,92,246,.45)}',
  'h1{margin:0 0 8px;font-size:17px;font-weight:600}',
  '.error h1{color:#FB7185}',
  'p{margin:0;color:#C9C7E6}'
].join('');
const CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'; base-uri 'none'; form-action 'none'`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Page { status: number; html: string }

function page(status: number, title: string, text: string, tone: 'ok' | 'error'): Page {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + '<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>Atelier · ${escapeHtml(title)}</title><style>${STYLE}</style></head>`
    + `<body><main class="${tone}"><div class="mark" aria-hidden="true">Λ</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
  return { status, html };
}

const BACK = 'You can close this tab and go back to Atelier.';
const pages = (name: string) => ({
  // The code arrived, nothing more: the token exchange, the tools check and the account can still fail in Atelier.
  received: () => page(200, 'Finishing in Atelier…', `${name} access received. ${BACK}`, 'ok'),
  denied: () => page(200, 'Access not allowed', `You didn't allow access in ${name}. ${BACK}`, 'error'),
  error: (description: string) => page(200, `${name} couldn't connect`, `${name} said: ${description}. ${BACK}`, 'error'),
  refused: () => page(400, `Couldn't verify ${name}'s reply`, 'Go back to Atelier and try again.', 'error'),
  notFound: () => page(404, 'Not found', BACK, 'error')
});

// ── The listener ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function openLoopback(o: LoopbackOptions): Promise<Loopback> {
  const PAGES = pages(o.connectorName);
  const path = o.fixedPath ? '/callback' : `/callback/${randomBytes(16).toString('hex')}`;
  let consumed = false;
  /** The first callback's request target and the page it got: an identical repeat gets that page again. */
  let first: { target: string; page: Page } | null = null;
  let resolve!: (r: CallbackResult) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<CallbackResult>((res, rej) => { resolve = res; reject = rej; });
  result.catch(() => undefined); // the flow may stop before it ever awaits this

  const refuse = (): Page => {
    reject(new AuthFailed('verify'));
    o.onViolation();
    return PAGES.refused();
  };

  const handle = (method: string, target: string): Page => {
    let u: URL;
    try { u = new URL(target, 'http://127.0.0.1'); } catch { return PAGES.notFound(); }
    if (u.pathname !== path || method !== 'GET') return PAGES.notFound();
    // The fixed path (CIMD) is guessable: any page in the browser may hit it. Without our 128-bit state a request
    // proves nothing, so it gets the refusal page but neither uses up the one callback nor ends the sign-in, before or
    // after the real one.
    if (o.fixedPath && !sameSecret(q0(u), o.state)) return PAGES.refused();
    if (consumed) return first && sameSecret(`${u.pathname}${u.search}`, first.target) ? first.page : refuse();
    consumed = true;
    const page = check(u);
    if (page.status === 200) first = { target: `${u.pathname}${u.search}`, page };
    return page;
  };

  const check = (u: URL): Page => {
    const q = u.searchParams;
    const iss = q.get('iss');
    if (!sameSecret(q.get('state'), o.state) || (iss === null ? o.issRequired !== false : iss !== o.issuer)) return refuse();
    const error = q.get('error');
    if (error !== null) {
      if (error === 'access_denied') { resolve({ kind: 'denied' }); return PAGES.denied(); }
      const description = cleanDescription(q.get('error_description') || error) || 'unknown error';
      resolve({ kind: 'error', description });
      return PAGES.error(description);
    }
    const code = q.get('code');
    if (!code || !CODE.test(code)) return refuse();
    resolve({ kind: 'code', code });
    return PAGES.received();
  };

  const bind = o.bind ?? listenLoopback;
  const ports = o.ports ?? Array.from({ length: o.attempts ?? DEFAULT_ATTEMPTS }, () => 0);
  let server: Server | null = null;
  let lastError = 'unknown';
  for (let i = 0; i < ports.length && !server; i++) {
    const s = createServer((req, res) => {
      const p = handle(req.method ?? '', req.url ?? '/');
      res.writeHead(p.status, {
        'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', connection: 'close'
      });
      res.end(p.html);
    });
    s.requestTimeout = 10_000;
    try {
      await bind(s, ports[i]!);
      server = s;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      lastError = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
      s.close();
    }
  }
  if (!server) throw new AuthFailed('port', lastError);
  const live = server;
  const port = (live.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    redirectUri: `${origin}${path}`,
    result,
    deliver(url) {
      let u: URL;
      try { u = new URL(url); } catch { return; }
      if (u.origin === origin) handle('GET', `${u.pathname}${u.search}`);
    },
    close() {
      reject(new Aborted());
      live.close();
      live.closeAllConnections();
    }
  };
}
