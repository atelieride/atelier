// Add / Edit Connection's form, pure: the draft the sheet edits (text as typed, the port too),
// how it is made from a URL or a saved connection, the defaults that follow the host until the user sets them, the
// errors
// under the fields (main's own rules mirrored, so Save waits until main would take it), the exact
// form main takes, which password goes where, and the sheet's run (a test or a save in flight, their
// answers). Loaded with the sheet's chunk, never with the first paint: view.ts is in it.
import {
  defaultEnv, defaultName, defaultTls, providerOf, type DbConnection, type DbConnectionForm, type DbEnv, type DbProblem, type DbServerInfo,
  type DbSnapshot, type DbTls
} from '@shared/databases';
import { dbUrlRefusal } from '@shared/databases-url';
import { isAbsPath } from '@shared/paths';
import { tdb } from '../i18n/db';
import { pastedSheet } from './side';
import { useDb } from './store';

export interface DbDraft {
  name: string;
  scope: 'project' | 'all';
  env: DbEnv;
  /** The host; '' while the Host field holds a socket folder: a socket form has no host. */
  host: string;
  /** A Unix socket's folder, '' for none: typed in the Host field as libpq takes it (an absolute path). */
  socket: string;
  port: string;
  database: string;
  user: string;
  tls: DbTls;
  /** The tunnel's fields stay while it is off (turned on again, they are back), but count only while it is on. */
  ssh: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  /** Name, environment and TLS follow the host and database until the user sets them. */
  auto: { name: boolean; env: boolean; tls: boolean };
}

export type DraftField = 'name' | 'host' | 'port' | 'database' | 'user' | 'sshHost' | 'sshPort' | 'sshUser';
export type DraftErrors = Partial<Record<DraftField, string>>;

/** The guesses again, for the fields still guessed. */
function guessed(d: DbDraft): DbDraft {
  const host = d.socket ? '' : d.host.trim();
  const socket = d.socket.trim() || undefined;
  return {
    ...d,
    ...(d.auto.name ? { name: defaultName({ host, database: d.database.trim() }) } : {}),
    ...(d.auto.env ? { env: defaultEnv(host, socket) } : {}),
    ...(d.auto.tls ? { tls: defaultTls(host, socket) } : {})
  };
}

/** A draft from what a URL said (or nothing: Continue with no URL); what it left out is guessed. */
export function draftFrom(f: Partial<DbConnectionForm>): DbDraft {
  return guessed({
    name: f.name ?? '', scope: f.scope?.kind ?? 'project', env: f.env ?? 'local', host: f.socket ? '' : f.host ?? '', socket: f.socket ?? '',
    port: String(f.port ?? 5432), database: f.database ?? '', user: f.user ?? '', tls: f.tls ?? 'prefer',
    ssh: false, sshHost: '', sshPort: '', sshUser: '',
    auto: { name: f.name === undefined, env: f.env === undefined, tls: f.tls === undefined }
  });
}

/**
 * What step 1's URL field says when Continue can't take its text: a raw / in the password is to
 * be written %2F; anything else isn't a postgres:// URL.
 */
export function urlFieldError(text: string): string {
  return dbUrlRefusal(text.trim()) === 'slash' ? tdb.sheet.urlSlash : tdb.sheet.urlBad;
}

/** A pasted or typed connection URL: the draft, and its password apart (it goes to the sheet's own state only). */
export function formFromUrl(text: string): { draft: DbDraft; password: string | null } | null {
  const s = pastedSheet(text);
  if (s?.kind !== 'add') return null;
  return { draft: draftFrom(s.form ?? {}), password: s.password ?? null };
}

/** Edit Connection…: the saved connection as it is, nothing guessed. */
export function draftOfConn(c: DbConnection): DbDraft {
  return {
    name: c.name, scope: c.scope.kind, env: c.env, host: c.socket ? '' : c.host, socket: c.socket ?? '', port: String(c.port), database: c.database,
    user: c.user, tls: c.tls, ssh: c.ssh !== null, sshHost: c.ssh?.host ?? '', sshPort: c.ssh?.port == null ? '' : String(c.ssh.port), sshUser: c.ssh?.user ?? '',
    auto: { name: false, env: false, tls: false }
  };
}

/** A change the user made: a name, environment or TLS mode the user sets is no longer guessed; the others follow the host. */
export function patchDraft(d: DbDraft, p: Partial<Omit<DbDraft, 'auto'>>): DbDraft {
  return guessed({ ...d, ...p, auto: { name: d.auto.name && !('name' in p), env: d.auto.env && !('env' in p), tls: d.auto.tls && !('tls' in p) } });
}

/** What the Host field shows: the socket folder when there is one, else the host. */
export const hostText = (d: DbDraft): string => d.socket || d.host;

/**
 * The Host field typed: an absolute path (as main reads one on this platform) is a socket folder, as libpq takes it, and
 * the form then has no host; anything else is a host.
 */
export function withHostText(d: DbDraft, text: string): DbDraft {
  return isAbsPath(text) ? patchDraft(d, { socket: text, host: '' }) : patchDraft(d, { host: text, socket: '' });
}

/** The chip in the Host field: the provider its suffix names, or a socket. */
export function chipOf(d: DbDraft): string | null {
  return d.socket ? tdb.sheet.socketChip : providerOf(d.host.trim());
}

// Main's rules (src/main/databases/connection-schema.ts), mirrored: tests/integration/db-form-parity.test.ts holds them
// equal. Through an SSH tunnel a host and a user go into ssh's argv: never something ssh reads as an option.
const TUNNEL_HOST = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*|(?=[^%]*:)[0-9A-Fa-f:.]+(?:%[A-Za-z0-9]+)?)$/;
const SSH_USER = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*)?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A port as typed: 1–65535, or NaN (main refuses it, the field says why). */
function portOf(text: string): number {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return Number.NaN;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : Number.NaN;
}

/** Both ports read as numbers (the tunnel's only while on and given): the form says where it points. */
const portsRead = (d: DbDraft): boolean => !Number.isNaN(portOf(d.port)) && (!d.ssh || !d.sshPort.trim() || !Number.isNaN(portOf(d.sshPort)));

/** A text field main bounds: empty (when it must not be), too long, or with control characters. */
function textError(v: string, max: number, empty: string | null): string | undefined {
  const e = tdb.sheet.errors;
  if (empty !== null && v.length === 0) return empty;
  if (v.length > max) return e.tooLong(max);
  if (CONTROL.test(v)) return e.control;
  return undefined;
}

/** Why main would refuse the form, field by field — the fields shown only; empty when Save and Connect can go. */
export function formErrors(d: DbDraft): DraftErrors {
  const e = tdb.sheet.errors;
  const out: DraftErrors = {};
  const set = (k: DraftField, m: string | undefined) => { if (m !== undefined && out[k] === undefined) out[k] = m; };
  const host = d.host.trim();
  const socket = d.socket.trim();
  set('name', textError(d.name.trim(), 120, e.name));
  if (socket) {
    // The rule main's schema uses (connection-schema.ts absPath): an absolute path on this platform, no NUL.
    if (!isAbsPath(socket) || socket.length > 4096 || socket.includes('\u0000')) set('host', e.socket);
    if (d.ssh) set('host', e.sshSocket);
  } else {
    set('host', textError(host, 255, e.host));
    if (d.ssh && host && !TUNNEL_HOST.test(host)) set('host', e.tunnelHost);
  }
  if (Number.isNaN(portOf(d.port))) set('port', e.port);
  set('database', textError(d.database.trim(), 128, e.database));
  set('user', textError(d.user.trim(), 128, e.user));
  if (d.ssh) {
    const sh = d.sshHost.trim();
    if (!sh) set('sshHost', e.sshHost);
    else if (sh.length > 255 || !TUNNEL_HOST.test(sh)) set('sshHost', e.tunnelHost);
    if (d.sshPort.trim() && Number.isNaN(portOf(d.sshPort))) set('sshPort', e.sshPort);
    const su = d.sshUser.trim();
    if (su.length > 128 || !SSH_USER.test(su)) set('sshUser', e.sshUser);
  }
  return out;
}

/** The form exactly as main's schema takes it (built field by field, nothing spread in), trimmed. */
export function formToConnection(d: DbDraft, root: string): DbConnectionForm {
  const socket = d.socket.trim();
  return {
    name: d.name.trim(), engine: 'postgres', env: d.env, host: socket ? '' : d.host.trim(), port: portOf(d.port), database: d.database.trim(),
    user: d.user.trim(),
    ...(socket ? { socket } : {}),
    tls: d.tls,
    ssh: d.ssh ? { host: d.sshHost.trim(), port: d.sshPort.trim() ? portOf(d.sshPort) : null, user: d.sshUser.trim() } : null,
    scope: d.scope === 'all' ? { kind: 'all' } : { kind: 'project', root }
  };
}

type Server = Pick<DbConnectionForm, 'host' | 'port' | 'socket' | 'ssh' | 'tls'>;

/**
 * The server a password was typed for (main's secretTargetOf): host, port, socket, SSH hop and TLS mode.
 * Another database or user on it is the same server.
 */
export function sameServer(a: Server, b: Server): boolean {
  const ssh = a.ssh === null || b.ssh === null ? a.ssh === b.ssh : a.ssh.host === b.ssh.host && a.ssh.port === b.ssh.port && a.ssh.user === b.ssh.user;
  return a.host === b.host && a.port === b.port && (a.socket ?? null) === (b.socket ?? null) && a.tls === b.tls && ssh;
}

/** What the form starts from: a saved connection (Edit), or nothing (Add). */
export type DraftBase = { kind: 'edit'; conn: DbConnection; hasPassword: boolean } | null;

/**
 * The password field: "•••• saved" while editing a connection with one on the same server; the new server's asked for
 * once the user points it elsewhere; else nothing.
 */
export type PasswordMode = 'none' | 'saved' | 'new-server';

/**
 * `settled`: the last draft whose ports read as numbers. A port half-typed (empty, not a number yet) borrows its ports,
 * so the decision stays where it was instead of flickering to "another server" while the user types.
 */
export function passwordMode(d: DbDraft, base: DraftBase, settled?: DbDraft): PasswordMode {
  const probe = settled && !portsRead(d) ? { ...d, port: settled.port, sshPort: settled.sshPort } : d;
  if (base?.kind === 'edit') {
    if (!base.hasPassword) return 'none';
    const c = base.conn;
    const was: Server = { host: c.host, port: c.port, tls: c.tls, ssh: c.ssh, ...(c.socket !== undefined ? { socket: c.socket } : {}) };
    return sameServer(was, formToConnection(probe, '/')) ? 'saved' : 'new-server';
  }
  return 'none';
}

/** Whether the draft's ports read as numbers: the sheet keeps such a draft as the settled one (passwordMode). */
export const settles = portsRead;

/**
 * Test Connection's request: the typed password; with none, editing on the same server, the id, so main uses the saved
 * one; pointed elsewhere, no id: the saved password never reaches a server it wasn't typed for.
 */
export function testArgs(d: DbDraft, root: string, password: string, base: DraftBase): { form: DbConnectionForm; password: string | null; id: string | null } {
  const form = formToConnection(d, root);
  const saved = base?.kind === 'edit' && password === '' && passwordMode(d, base) === 'saved';
  return { form, password: password || null, id: saved ? base.conn.id : null };
}

/**
 * The password ⌘V brought with a pasted URL, taken out of the store into the sheet's own state: it never
 * stays there longer than it takes the sheet to read it. '' when there is none.
 */
export function takePastedPassword(): string {
  const s = useDb.getState().sheet;
  if (s?.kind !== 'add' || s.password === undefined) return '';
  useDb.setState({ sheet: { kind: 'add', step: s.step, ...(s.form ? { form: s.form } : {}) } });
  return s.password;
}

// —— step 1 ——

/** Where step 2 starts: the draft, a password typed in step 1's URL, and what it came from. */
export interface DraftStart {
  draft: DbDraft;
  password: string;
  /** A ⌘V'd URL brought a password: the form takes it out of the store (it knows it has one before it reads it). */
  pasted: boolean;
  hasPassword: boolean;
  /** Filled from somewhere (a URL, a saved connection): what is missing says so at once. */
  prefilled: boolean;
  base: DraftBase;
}

/**
 * Step 1's URL field taken to the form: a URL fills it, nothing gives a blank one. Anything else is null for Continue
 * (the field says it isn't a URL); the PostgreSQL card opens the blank form instead, never that error.
 */
export function startFromUrlField(text: string, via: 'continue' | 'engine'): DraftStart | null {
  const t = text.trim();
  const r = t ? formFromUrl(t) : null;
  if (r) return { draft: r.draft, password: r.password ?? '', pasted: false, hasPassword: !!r.password, prefilled: true, base: null };
  if (t && via === 'continue') return null;
  return { draft: draftFrom({}), password: '', pasted: false, hasPassword: false, prefilled: false, base: null };
}

// —— the sheet's run ——

export type TestResult = { kind: 'ok'; server: DbServerInfo } | { kind: 'err'; problem: DbProblem };

export interface SheetRun {
  /** A test or a save in flight: the fields are read-only, neither can be pressed again. */
  busy: 'test' | 'save' | null;
  /** Test Connection's answer, for the values it tested. */
  tested: TestResult | null;
  /** Main refused the save: a save problem, never a test's answer. */
  refused: DbProblem | null;
  /** Bumped by every change: a test's answer for older values is dropped. */
  gen: number;
}

export const IDLE_RUN: SheetRun = { busy: null, tested: null, refused: null, gen: 0 };

export type RunEvent =
  | { type: 'change'; server: boolean }
  | { type: 'test' }
  | { type: 'tested'; gen: number; result: TestResult | null }
  | { type: 'save' }
  | { type: 'saved'; problem: DbProblem | null };

/**
 * The run's next state. A change drops a refusal and — when it reaches the server (not the name, environment or scope)
 * — the test's answer, which was for other values.
 */
export function runStep(r: SheetRun, e: RunEvent): SheetRun {
  switch (e.type) {
    case 'change': return { ...r, gen: r.gen + 1, refused: null, tested: e.server ? null : r.tested };
    case 'test': return { ...r, busy: 'test', tested: null, refused: null };
    case 'tested': return { ...r, busy: null, tested: e.gen === r.gen ? e.result : null };
    case 'save': return { ...r, busy: 'save', refused: null };
    case 'saved': return { ...r, busy: null, refused: e.problem };
  }
}

/** The buttons and fields for a run: `ok`, the form is one main takes. The test's label says whether it answered. */
export function controlsOf(r: SheetRun, ok: boolean): { locked: boolean; canTest: boolean; canSave: boolean; test: string } {
  const locked = r.busy !== null;
  return { locked, canTest: ok && !locked, canSave: ok && !locked, test: r.tested ? tdb.sheet.testAgain : tdb.sheet.test };
}

/**
 * An edit sheet's connection gone from this window: its name, to say so, and whether it was surely removed
 *. One scoped to this project only leaves by a removal — no other project's window shows it to edit; one shown in
 * every project may have moved to another project's scope, and Never (`off`) hides them all: "isn't shown here".
 */
export function removedElsewhere(id: string, before: DbSnapshot, now: DbSnapshot, root: string, off: boolean): { name: string; removed: boolean } | null {
  const was = before.connections.find((c) => c.conn.id === id);
  if (!was || now.connections.some((c) => c.conn.id === id)) return null;
  const scope = was.conn.scope;
  return { name: was.conn.name, removed: !off && scope.kind === 'project' && scope.root === root };
}
