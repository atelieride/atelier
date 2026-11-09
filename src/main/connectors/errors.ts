// Typed failures of the connector core: the status machine (task-connector.ts) maps each class to a state.
// Messages are ours, short, fixed and for the logs only (shared by every connector, so they name none): they never
// carry a token, a request header or a reply body, and no error here has a `cause` (a transport error could quote the
// request). Server text (ToolError) is scrubbed and clipped by the caller.

export type ConnectorErrorKind =
  | 'not-allowed' | 'invalid-arguments' | 'host-not-allowed' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'unreachable'
  | 'schema-changed' | 'too-large' | 'tool-error' | 'aborted' | 'secret-unavailable' | 'secret-unreadable' | 'auth-failed';

export abstract class ConnectorError extends Error {
  abstract readonly kind: ConnectorErrorKind;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A tool outside the read-only allowlist: refused before any request is built. */
export class NotAllowed extends ConnectorError {
  readonly kind = 'not-allowed';
  constructor() { super("Tool not allowed: Atelier only calls the connector's read-only tools."); }
}

/** An allowlisted tool called with arguments outside its strict schema (a bug in Atelier): refused before any request.
 * Carries the tool's name only, never the arguments. */
export class InvalidArguments extends ConnectorError {
  readonly kind = 'invalid-arguments';
  constructor(readonly tool: string) { super(`Invalid arguments for ${tool}.`); }
}

/** A URL (request or redirect) outside the connector's one allowed origin: refused before it is opened. */
export class HostNotAllowed extends ConnectorError {
  readonly kind = 'host-not-allowed';
  constructor(readonly origin: string) { super(`Host not allowed: ${origin}`); }
}

/** HTTP 401: the token is invalid, revoked or reset → `reconnect`. */
export class Unauthorized extends ConnectorError {
  readonly kind = 'unauthorized';
  constructor() { super('The server refused the token (401).'); }
}

/** HTTP 403: no access (also how a gone workspace may show). */
export class Forbidden extends ConnectorError {
  readonly kind = 'forbidden';
  constructor() { super('The server refused access (403).'); }
}

/** HTTP 429. `resetAt` (ms since the epoch) comes from `x-ratelimit-reset`, never more than 5 minutes ahead. */
export class RateLimited extends ConnectorError {
  readonly kind = 'rate-limited';
  constructor(readonly resetAt: number) { super('Rate limit reached (429).'); }
}

/** Network failure, timeout or a server error (5xx): the connector goes `offline` and retries. */
export class Unreachable extends ConnectorError {
  readonly kind = 'unreachable';
  constructor(readonly reason: 'network' | 'timeout' | 'server', readonly status?: number) {
    super(reason === 'timeout' ? 'The server did not answer in time.' : reason === 'server' ? `Server error (${status ?? '?'}).` : "Can't reach the server.");
  }
}

/** The reply (or the protocol) is not what Atelier knows: a missing core field, malformed JSON, an unknown tool. */
export class SchemaChanged extends ConnectorError {
  readonly kind = 'schema-changed';
  constructor(readonly detail: string) { super(`The connector changed: ${detail}`); }
}

/** At Connect, tools Atelier needs aren't listed: for an API token, one made without the scopes (Jira). */
export class ToolsMissing extends SchemaChanged {
  constructor(readonly tools: readonly string[]) { super(`tools missing: ${tools.join(', ')}`); }
}

/** A reply over the size cap (4 MB): that call fails, the cache stays. */
export class TooLarge extends ConnectorError {
  readonly kind = 'too-large';
  constructor(readonly maxBytes: number) { super(`The reply is over the ${maxBytes} byte cap.`); }
}

/** A tool answered with `isError: true` (a gone task, a gone workspace…). `text` is the server's, scrubbed and clipped. */
export class ToolError extends ConnectorError {
  readonly kind = 'tool-error';
  /**
   * `text`: the server's words for display (one line, ≤ 200 characters). `fullText`: the same, scrubbed but not cut,
   * for a connector that must read a value out of a longer message (Jira's "The value 'N' does not exist…").
   */
  constructor(readonly tool: string, readonly text: string, readonly fullText?: string) { super(`${tool} failed: ${text}`); }
}

/** The caller's signal ended the request (Cancel, Disconnect, quit). */
export class Aborted extends ConnectorError {
  readonly kind = 'aborted';
  constructor() { super('Request cancelled.'); }
}

/** `safeStorage` can't encrypt or decrypt (Keychain unavailable or denied): nothing is stored. */
export class SecretUnavailable extends ConnectorError {
  readonly kind = 'secret-unavailable';
  constructor() { super("macOS Keychain isn't available, so Atelier can't store the connection safely."); }
}

/** The stored blob can't be decrypted (garbled, or made by another Keychain identity) → `reconnect`. */
export class SecretUnreadable extends ConnectorError {
  readonly kind = 'secret-unreadable';
  constructor(readonly id: string) { super(`The stored ${id} connection can't be read.`); }
}

/**
 * Why a sign-in failed: the server doesn't offer the flow Atelier requires (`unsupported`),
 * the user said no (`denied`), the server reported another OAuth error (`oauth-error`), the callback failed its checks
 * or came twice (`verify`), no loopback port could be opened (`port`), the server was unreachable (`network`), or a refresh token was refused (`signed-out`).
 */
export type AuthFailureReason = 'unsupported' | 'denied' | 'oauth-error' | 'verify' | 'port' | 'network' | 'signed-out';

/** For the logs only (the UI words come from the reason, i18n/en.ts): never a connector's name, they serve all. */
const AUTH_MESSAGES: Record<AuthFailureReason, string> = {
  unsupported: 'The server changed how apps sign in.',
  denied: "Access wasn't allowed.",
  'oauth-error': 'The server reported a sign-in error.',
  verify: "The sign-in reply couldn't be verified.",
  port: "The sign-in listener couldn't be opened.",
  network: "Can't reach the server.",
  'signed-out': 'The sign-in expired.'
};

/**
 * A failed sign-in. `detail` is display text that is safe to show: the server's error_description (one line, ≤ 120
 * characters) for `oauth-error`, the listen error code for `port`. Never a code, a state, a verifier or a token.
 */
export class AuthFailed extends ConnectorError {
  readonly kind = 'auth-failed';
  constructor(readonly reason: AuthFailureReason, readonly detail?: string) { super(AUTH_MESSAGES[reason]); }
}
