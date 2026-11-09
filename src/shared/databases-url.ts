// Connection URLs: postgres(ql)://[user[:password]@]host[:port][/database][?params].
import type { DbConnection, DbTls } from './databases';

export interface ParsedDbUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | null;
  socket?: string;
  tls: DbTls | null;
  extraHosts: number;
}

const SSLMODE: Record<string, DbTls> = {
  disable: 'off', allow: 'prefer', prefer: 'prefer', require: 'require', 'verify-ca': 'verify', 'verify-full': 'verify'
};

function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

function parsePort(s: string): number | null {
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** One `host[:port]` or `[v6][:port]` entry of the authority. */
function parseHostPort(entry: string): { host: string; port: number | null } | null {
  let host = entry;
  let port: string | null = null;
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    if (end < 0) return null;
    host = entry.slice(1, end);
    const rest = entry.slice(end + 1);
    if (rest) { if (!rest.startsWith(':')) return null; port = rest.slice(1); }
  } else {
    const i = entry.lastIndexOf(':');
    if (i >= 0) { host = entry.slice(0, i); port = entry.slice(i + 1); }
  }
  const h = decode(host);
  if (h === null) return null;
  if (port === null || port === '') return { host: h, port: null };
  const p = parsePort(port);
  return p === null ? null : { host: h, port: p };
}

/**
 * Whether `before` (what precedes an @ ahead of the first /) can be user info: user[:password]. A raw ? or # there is
 * the password's only after the user's colon (libpq reads a raw ? or # in a password before the host, as psql does),
 * and never after a host:port's digits or an [IPv6] host — there it starts the query or the fragment, and the @ is
 * theirs (postgres://h?user=a@corp is host h).
 */
function userInfo(before: string): boolean {
  const mark = before.search(/[?#]/);
  if (mark < 0) return true;
  if (before.startsWith('[')) return false;
  const colon = before.indexOf(':');
  return colon >= 0 && colon < mark && !/^\d{1,5}$/.test(before.slice(colon + 1, mark));
}

/** Why parse refused a URL: a raw / in its password ('slash': encode it as %2F), or anything else. */
type Refusal = 'slash' | 'bad';

function parse(text: string): ParsedDbUrl | Refusal {
  const m = /^postgres(?:ql)?:\/\/(.*)$/is.exec(text.trim());
  if (!m) return 'bad';
  let rest = m[1]!;
  // The user info ends at the last @ before the first / (libpq looks for it there) whose text before it is user info.
  const firstSlash = rest.indexOf('/');
  const authority = firstSlash >= 0 ? rest.slice(0, firstSlash) : rest;
  let at = authority.lastIndexOf('@');
  while (at >= 0 && !userInfo(authority.slice(0, at))) at = authority.lastIndexOf('@', at - 1);
  const info = at >= 0 ? rest.slice(0, at) : null;
  if (at >= 0) rest = rest.slice(at + 1);
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  const slash = rest.indexOf('/');
  const hostsPart = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash + 1) : '';
  // A raw / in a password ends the authority early: the @ then sits in the path. Refused rather than read as another
  // host (a raw @ in a database name is refused with it); said as a / to encode when it looks like user:password.
  if (path.includes('@')) return info === null && hostsPart.includes(':') ? 'slash' : 'bad';

  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decode((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, ' '));
    const v = decode((eq >= 0 ? pair.slice(eq + 1) : '').replace(/\+/g, ' '));
    if (k === null || v === null) return 'bad';
    params.set(k, v);
  }

  let user = '';
  let password: string | null = null;
  if (info !== null) {
    const colon = info.indexOf(':');
    const u = decode(colon >= 0 ? info.slice(0, colon) : info);
    const p = colon >= 0 ? decode(info.slice(colon + 1)) : null;
    if (u === null || (colon >= 0 && p === null)) return 'bad';
    user = u;
    password = p;
  }

  const entries = hostsPart.split(',').filter((e) => e !== '');
  let host = '';
  let port: number | null = null;
  if (entries.length > 0) {
    const first = parseHostPort(entries[0]!);
    if (!first) return 'bad';
    host = first.host;
    port = first.port;
  }
  const extraHosts = Math.max(0, entries.length - 1);

  let socket: string | undefined;
  // A host that decodes to a folder (%2F…) is a socket folder, as libpq reads it.
  if (host.startsWith('/')) { socket = host; host = ''; }
  const hostParam = params.get('host');
  if (hostParam) {
    if (hostParam.startsWith('/')) socket = hostParam;
    else if (!host && !socket) host = hostParam;
  }
  // A ?port= that isn't a port is refused, as a bad port in the authority is; an empty one is no port.
  const portParam = params.get('port');
  if (portParam) {
    const p = parsePort(portParam);
    if (p === null) return 'bad';
    if (port === null) port = p;
  }
  // libpq: a host= parameter overrides the URL's host; a socket folder there leaves no host.
  if (socket) host = '';
  else if (!host) host = 'localhost';

  const dbPath = decode(path);
  if (dbPath === null) return 'bad';
  user = params.get('user') ?? user;
  if (params.has('password')) password = params.get('password')!;
  const database = params.get('dbname') || dbPath || user;

  const out: ParsedDbUrl = {
    host, port: port ?? 5432, database, user, password, tls: SSLMODE[params.get('sslmode') ?? ''] ?? null, extraHosts
  };
  if (socket) out.socket = socket;
  return out;
}

export function parseDbUrl(text: string): ParsedDbUrl | null {
  const r = parse(text);
  return typeof r === 'string' ? null : r;
}

/**
 * Why parseDbUrl refuses `text`: 'slash' — a raw / in its password ended the authority early (the field says to write
 * it as %2F) —, 'bad' for anything else; null when it reads.
 */
export function dbUrlRefusal(text: string): Refusal | null {
  const r = parse(text);
  return typeof r === 'string' ? r : null;
}

type UrlParts = Pick<DbConnection, 'host' | 'port' | 'database' | 'user' | 'socket' | 'tls'>;

/** The connection as a URL, never with a password. */
export function formatDbUrl(c: UrlParts): string {
  const user = c.user ? `${encodeURIComponent(c.user)}@` : '';
  const params: string[] = [];
  let hostPart = '';
  if (c.socket) {
    params.push(`host=${encodeURIComponent(c.socket)}`);
    // The socket file is named after the port (.s.PGSQL.<port>): libpq reads it from `port`.
    if (c.port !== 5432) params.push(`port=${c.port}`);
  } else hostPart = (c.host.includes(':') ? `[${c.host}]` : c.host) + `:${c.port}`;
  if (c.tls === 'require') params.push('sslmode=require');
  else if (c.tls === 'verify') params.push('sslmode=verify-full');
  return `postgresql://${user}${hostPart}/${encodeURIComponent(c.database)}${params.length ? `?${params.join('&')}` : ''}`;
}

export function psqlCommand(c: UrlParts): string {
  return `psql '${formatDbUrl(c).replace(/'/g, `'\\''`)}'`;
}
