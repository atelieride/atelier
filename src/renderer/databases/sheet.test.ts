import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { createElement } from 'react';

/**
 * A form's run held busy for one render (the lock test): `useReducer` with that reducer answers `state`; every other
 * call is React's own. Null: React's own everywhere (every other test).
 */
const busyRun = vi.hoisted(() => ({ reducer: null as unknown, state: null as unknown }));
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const useReducer = ((r: unknown, init: unknown, make?: unknown) =>
    (busyRun.state !== null && r === busyRun.reducer ? [busyRun.state, () => {}] : (real.useReducer as (...a: unknown[]) => unknown)(r, init, make))) as typeof real.useReducer;
  // `default` stays React's own object (test-render spies on it).
  return { ...real, useReducer };
});
import {
  DB_ENGINES, EMPTY_DB_SNAPSHOT, type DbConnView, type DbConnection, type DbConnectionForm, type DbServerInfo, type DbSnapshot
} from '@shared/databases';
import { tdb } from '../i18n/db';
import { useApp } from '../store';
import { DbSheets, TestNote, removeConnection, saveAndConnect, testConnection } from './ConnectionSheet';
import { DatabasesList } from './DatabasesList';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import {
  IDLE_RUN, chipOf, controlsOf, draftFrom, draftOfConn, formErrors, formFromUrl, formToConnection, hostText, passwordMode, patchDraft, removedElsewhere,
  runStep, sameServer, startFromUrlField, takePastedPassword, testArgs, urlFieldError, withHostText, type DbDraft
} from './form';
import { useDb, type DbSheet } from './store';
import type { DbTabRef } from './tabs';
import { renderLive } from './test-render';

// Add / Edit Connection and Remove.

const ROOT = '/Users/me/acme-store';
const RAILWAY = 'postgresql://postgres:s3cret-pw@sample-db1.proxy.rlwy.net:54321/railway';
const PROD = 'c00000000000c';
const DEV = 'c00000000000a';
const conn = (id: string, o: Partial<DbConnection> = {}): DbConnection => ({
  id, name: id, engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme_dev', user: 'app', tls: 'prefer', ssh: null,
  scope: { kind: 'project', root: ROOT }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (c: DbConnection, o: Partial<DbConnView> = {}): DbConnView =>
  ({ conn: c, state: 'idle', problem: null, server: null, hasPassword: false, provider: null, held: false, ...o });
const prod = conn(PROD, { name: 'acme · production', env: 'prod', host: 'sample-db1.proxy.rlwy.net', port: 54321, database: 'railway', user: 'readonly_analyst', tls: 'require', scope: { kind: 'all' } });
const SERVER: DbServerInfo = { version: '17.2', versionNum: 170002, tls: true, role: 'readonly_analyst', canWrite: false, latencyMs: 84 };

const open = (sheet: DbSheet, snap: Partial<DbSnapshot> = {}) => useDb.setState({ loaded: true, sheet, snap: { ...EMPTY_DB_SNAPSHOT, ...snap } });
const html = () => renderLive(DbSheets);
/** A draft as the URL would make it, then changed. */
const railway = (p: Partial<DbDraft> = {}): DbDraft => ({ ...formFromUrl(RAILWAY)!.draft, ...p });
/** The radio of a segmented group, by its label: its markup up to its closing tag. */
const radio = (out: string, label: string) => new RegExp(`<button[^>]*role="radio"[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`).exec(out)?.[0] ?? '';

beforeEach(() => {
  useApp.setState({ project: { root: ROOT, name: 'acme-store', realRoot: ROOT }, popout: null, ws: null, activity: 'databases' });
});
afterEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
});

describe('the form from a URL (URL parsing, provider chip, defaults)', () => {
  test('a Railway URL: the provider chip, Development, TLS Require, named "Railway · railway", its password kept apart', () => {
    const r = formFromUrl(RAILWAY)!;
    expect(r.password).toBe('s3cret-pw');
    expect(r.draft).toMatchObject({ host: 'sample-db1.proxy.rlwy.net', port: '54321', database: 'railway', user: 'postgres', socket: '' });
    expect(chipOf(r.draft)).toBe('Railway');
    expect(r.draft.env).toBe('dev');
    expect(r.draft.tls).toBe('require');
    expect(r.draft.name).toBe('Railway · railway');
    // Nothing of the password in the draft.
    expect(JSON.stringify(r.draft)).not.toContain('s3cret-pw');
  });

  test('anything else is not a connection URL', () => {
    expect(formFromUrl('mysql://u@h/db')).toBeNull();
    expect(formFromUrl('hello')).toBeNull();
  });

  test('sslmode wins over the default; a loopback host is Local with TLS Prefer, named after its database', () => {
    const d = formFromUrl('postgres://app@localhost:5433/acme_dev?sslmode=disable')!.draft;
    expect(d).toMatchObject({ env: 'local', tls: 'off', name: 'acme_dev', port: '5433' });
    expect(chipOf(d)).toBeNull();
  });

  test('a socket folder (host=/path, as libpq writes it) goes in the Host field and reads "Unix socket"', () => {
    const d = formFromUrl('postgresql:///acme?host=/var/run/postgresql')!.draft;
    expect(d.socket).toBe('/var/run/postgresql');
    expect(hostText(d)).toBe('/var/run/postgresql');
    expect(chipOf(d)).toBe('Unix socket');
    expect(d.env).toBe('local');
    expect(d.tls).toBe('prefer');
  });

  test('a socket form has no host: a URL with both keeps the socket and drops the host', () => {
    const d = formFromUrl('postgresql://app@localhost:5433/acme?host=/var/run/postgresql')!.draft;
    expect(d).toMatchObject({ host: '', socket: '/var/run/postgresql', port: '5433' });
    expect(formToConnection(d, ROOT)).toMatchObject({ host: '', socket: '/var/run/postgresql' });
  });

  test('a blank form (Continue with no URL): port 5432, Local, nothing else guessed', () => {
    const d = draftFrom({});
    expect(d).toMatchObject({ host: '', port: '5432', database: '', user: '', name: '', env: 'local', tls: 'prefer', ssh: false, scope: 'project' });
  });
});

describe('defaults follow the host and database until the user sets them', () => {
  test('a remote host turns Local into Development, Prefer into Require, and names it after the provider', () => {
    const d = patchDraft(withHostText(draftFrom({}), 'ep-misty-fog.eu-central-1.aws.neon.tech'), { database: 'acme' });
    expect(d).toMatchObject({ env: 'dev', tls: 'require', name: 'Neon · acme' });
  });

  test('what the user picked stays: environment, TLS and name are no longer guessed', () => {
    let d = patchDraft(draftFrom({}), { env: 'staging', tls: 'verify', name: 'mine' });
    d = withHostText(d, 'db.example.com');
    d = patchDraft(d, { database: 'x' });
    expect(d).toMatchObject({ env: 'staging', tls: 'verify', name: 'mine' });
  });

  test('a path in the Host field is a socket folder, and the form has no host then; a name again is a host', () => {
    const s = withHostText(draftFrom({ host: 'localhost' }), '/tmp');
    expect(s).toMatchObject({ socket: '/tmp', host: '' });
    const h = withHostText(s, 'db.internal');
    expect(h).toMatchObject({ socket: '', host: 'db.internal' });
  });

  test('Windows: a socket folder is an absolute path as main reads one there (a drive letter), never a POSIX one', () => {
    initPlatform('win32');
    try {
      expect(withHostText(draftFrom({}), 'C:\\pg\\run')).toMatchObject({ socket: 'C:\\pg\\run', host: '' });
      expect(withHostText(draftFrom({}), '/tmp')).toMatchObject({ socket: '', host: '/tmp' });
      expect(formErrors(railway({ host: '', socket: '/tmp' }))).toHaveProperty('host');
      expect(formErrors(railway({ host: '', socket: 'C:\\pg' }))).toEqual({});
    } finally {
      resetPlatformForTests();
    }
  });

  test('editing keeps its own name, environment and TLS', () => {
    const d = withHostText(draftOfConn(prod), 'localhost');
    expect(d).toMatchObject({ env: 'prod', tls: 'require', name: 'acme · production' });
  });
});

describe('formErrors: Save and Connect waits until the form is one main takes', () => {
  test('a complete form has none', () => {
    expect(formErrors(railway())).toEqual({});
  });

  test('an empty host (and no socket), port 0 or past 65535, an empty database, user or name', () => {
    expect(formErrors(railway({ host: '' }))).toHaveProperty('host');
    expect(formErrors(railway({ port: '0' }))).toHaveProperty('port');
    expect(formErrors(railway({ port: '65536' }))).toHaveProperty('port');
    expect(formErrors(railway({ port: '54x' }))).toHaveProperty('port');
    expect(formErrors(railway({ database: ' ' }))).toHaveProperty('database');
    expect(formErrors(railway({ user: '' }))).toHaveProperty('user');
    expect(formErrors(railway({ name: '' }))).toHaveProperty('name');
  });

  test('a socket that is not an absolute folder', () => {
    expect(formErrors(railway({ host: '', socket: 'tmp/pg' }))).toHaveProperty('host');
    expect(formErrors(railway({ host: '', socket: '/tmp' }))).toEqual({});
  });

  test('only what is shown is checked: under a socket, the host the field doesn\'t show is not', () => {
    expect(formErrors(railway({ host: 'a\u0007b', socket: '/tmp' }))).toEqual({});
    expect(formErrors(railway({ host: 'x'.repeat(300), socket: '/tmp' }))).toEqual({});
  });

  test('SSH needs its host; port and user are optional, ~/.ssh/config decides', () => {
    expect(formErrors(railway({ ssh: true, sshHost: '' }))).toHaveProperty('sshHost');
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion', sshPort: '', sshUser: '' }))).toEqual({});
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion', sshPort: '0' }))).toHaveProperty('sshPort');
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion', sshPort: '2222', sshUser: 'deploy' }))).toEqual({});
    // Off, the SSH fields are kept for later but never checked.
    expect(formErrors(railway({ ssh: false, sshHost: '-oProxyCommand=x' }))).toEqual({});
  });

  test('through SSH, hosts and the user go into ssh\'s argv: names or IP literals, never an option', () => {
    expect(formErrors(railway({ ssh: true, sshHost: '-oProxyCommand=touch /tmp/x' }))).toHaveProperty('sshHost');
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion host' }))).toHaveProperty('sshHost');
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion', sshUser: '-l' }))).toHaveProperty('sshUser');
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion', sshUser: 'de ploy' }))).toHaveProperty('sshUser');
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion', host: '-db' }))).toHaveProperty('host');
    expect(formErrors(railway({ ssh: true, sshHost: 'fe80::1%en0', host: 'db_1.internal' }))).toEqual({});
    // Without SSH the database host is the driver's, not ssh's: any text main stores.
    expect(formErrors(railway({ host: 'db_1 internal' }))).toEqual({});
  });

  test('an SSH tunnel forwards TCP: never with a socket', () => {
    expect(formErrors(railway({ ssh: true, sshHost: 'bastion', host: '', socket: '/tmp' }))).toHaveProperty('host');
  });
});

describe('formToConnection: the exact form main takes', () => {
  test('every field, trimmed, numbers as numbers, the scope with the project\'s root', () => {
    const f = formToConnection(railway({ name: ' prod ', user: ' postgres ', scope: 'all' }), ROOT);
    expect(f).toEqual({
      name: 'prod', engine: 'postgres', env: 'dev', host: 'sample-db1.proxy.rlwy.net', port: 54321, database: 'railway', user: 'postgres',
      tls: 'require', ssh: null, scope: { kind: 'all' }
    });
    expect(formToConnection(railway(), ROOT).scope).toEqual({ kind: 'project', root: ROOT });
  });

  test('a socket only when there is one, and then no host; SSH with its port null and user empty when left to ~/.ssh/config', () => {
    expect(formToConnection(railway({ socket: '/tmp' }), ROOT)).toMatchObject({ socket: '/tmp', host: '' });
    expect(formToConnection(railway(), ROOT)).not.toHaveProperty('socket');
    expect(formToConnection(railway({ ssh: true, sshHost: ' bastion ', sshPort: '', sshUser: '' }), ROOT).ssh).toEqual({ host: 'bastion', port: null, user: '' });
    expect(formToConnection(railway({ ssh: true, sshHost: 'b', sshPort: '2222', sshUser: 'deploy' }), ROOT).ssh).toEqual({ host: 'b', port: 2222, user: 'deploy' });
  });
});

describe('the password field', () => {
  const edit = (c: DbConnection, hasPassword: boolean) => ({ kind: 'edit' as const, conn: c, hasPassword });

  test('the same server: host, port, socket, SSH and TLS; another database or user keeps the password', () => {
    const a = formToConnection(draftOfConn(prod), ROOT);
    const other: DbConnectionForm = { ...a, database: 'other', user: 'other' };
    expect(sameServer(a, other)).toBe(true);
    for (const p of [{ host: 'x' }, { port: 1 }, { socket: '/tmp' }, { tls: 'verify' as const }, { ssh: { host: 'b', port: null, user: '' } }]) {
      expect(sameServer(a, { ...a, ...p }), JSON.stringify(p)).toBe(false);
    }
    const t = { ...a, ssh: { host: 'b', port: null, user: '' } };
    expect(sameServer(t, { ...t, ssh: { host: 'b', port: null, user: '' } })).toBe(true);
    expect(sameServer(t, { ...t, ssh: { host: 'b', port: 22, user: '' } })).toBe(false);
  });

  test('editing: "•••• saved" while the server stays the same; pointed elsewhere, it asks for the new server\'s', () => {
    expect(passwordMode(draftOfConn(prod), edit(prod, true))).toBe('saved');
    expect(passwordMode({ ...draftOfConn(prod), database: 'x' }, edit(prod, true))).toBe('saved');
    expect(passwordMode(withHostText(draftOfConn(prod), 'other.rlwy.net'), edit(prod, true))).toBe('new-server');
    expect(passwordMode(patchDraft(draftOfConn(prod), { tls: 'verify' }), edit(prod, true))).toBe('new-server');
    expect(passwordMode(draftOfConn(prod), edit(prod, false))).toBe('none');
    expect(passwordMode(railway(), null)).toBe('none');
  });

  test('a port half-typed (not a number yet) keeps the last decision: no flicker between "•••• saved" and the new server\'s hint', () => {
    const settled = draftOfConn(prod);
    for (const port of ['', '4x']) {
      expect(passwordMode({ ...settled, port }, edit(prod, true), settled), port).toBe('saved');
      expect(passwordMode({ ...settled, port }, edit(prod, true), withHostText(settled, 'other.rlwy.net')), port).toBe('saved');
    }
    // The settled draft lends only its ports: another host typed meanwhile still counts.
    expect(passwordMode(withHostText({ ...settled, port: '' }, 'other.rlwy.net'), edit(prod, true), settled)).toBe('new-server');
    const ssh = patchDraft(settled, { ssh: true, sshHost: 'b', sshPort: '22' });
    expect(passwordMode({ ...ssh, sshPort: '2x' }, edit({ ...prod, ssh: { host: 'b', port: 22, user: '' } }, true), ssh)).toBe('saved');
    // A whole number is a decision: another port is another server.
    expect(passwordMode({ ...settled, port: '5432' }, edit(prod, true), settled)).toBe('new-server');
  });

  test('Test Connection sends the typed password, or (editing, same server) none with the id so main uses the saved one', () => {
    const e = edit(prod, true);
    expect(testArgs(draftOfConn(prod), ROOT, '', e)).toEqual({ form: formToConnection(draftOfConn(prod), ROOT), password: null, id: PROD });
    expect(testArgs(draftOfConn(prod), ROOT, 'typed', e)).toMatchObject({ password: 'typed', id: null });
    // Elsewhere, the saved one never goes: no id, so main tests with what is typed (nothing).
    expect(testArgs(withHostText(draftOfConn(prod), 'other.rlwy.net'), ROOT, '', e)).toMatchObject({ password: null, id: null });
    expect(testArgs(railway(), ROOT, 'pw', null)).toMatchObject({ password: 'pw', id: null });
    // Nothing names a suggestion any more (main's schema refuses one).
    expect(Object.keys(testArgs(railway(), ROOT, 'pw', null)).sort()).toEqual(['form', 'id', 'password']);
  });
});

describe('the sheet\'s run: what a test or a save in flight does to the form', () => {
  const ok = { kind: 'ok' as const, server: SERVER };
  const problem = { kind: 'other' as const, message: 'Invalid connection: host' };

  test('a refused save is a save problem, never a test result: the button stays "Test Connection"', () => {
    let r = runStep(IDLE_RUN, { type: 'save' });
    r = runStep(r, { type: 'saved', problem });
    expect(r).toMatchObject({ busy: null, tested: null, refused: problem });
    expect(controlsOf(r, true).test).toBe('Test Connection');
    // A test's answer says "Test Again"; a refusal afterwards keeps that answer and adds its own.
    r = runStep(runStep(IDLE_RUN, { type: 'test' }), { type: 'tested', gen: 0, result: ok });
    expect(controlsOf(r, true).test).toBe('Test Again');
    r = runStep(runStep(r, { type: 'save' }), { type: 'saved', problem });
    expect(r).toMatchObject({ tested: ok, refused: problem });
  });

  test('every field is read-only while a test or a save is in flight; nothing can be pressed twice', () => {
    expect(controlsOf(IDLE_RUN, true)).toEqual({ locked: false, canTest: true, canSave: true, test: 'Test Connection' });
    for (const e of [{ type: 'test' }, { type: 'save' }] as const) {
      expect(controlsOf(runStep(IDLE_RUN, e), true)).toMatchObject({ locked: true, canTest: false, canSave: false });
    }
    // A form main would refuse: neither, but the fields stay open to fix it.
    expect(controlsOf(IDLE_RUN, false)).toMatchObject({ locked: false, canTest: false, canSave: false });
  });

  test('the lock in the page: while a test or a save runs, every field read-only, every choice and Back disabled', () => {
    for (const e of [{ type: 'test' }, { type: 'save' }] as const) {
      // The form's run as if the press had happened (a server render can't press): its reducer answers busy.
      busyRun.reducer = runStep;
      busyRun.state = runStep(IDLE_RUN, e);
      try {
        open({ kind: 'add', step: 2, form: { host: 'localhost', port: 5432, database: 'acme', user: 'app' } });
        const out = html();
        const inputs = out.match(/<input [^>]*id="db-f-[^"]+"[^>]*>/g) ?? [];
        expect(inputs.length, e.type).toBeGreaterThanOrEqual(6);
        for (const i of inputs) expect(i, `${e.type}: ${i}`).toMatch(/ readOnly=""/i);
        for (const label of ['acme-store', 'Every project', 'Local', 'Production', 'Off', 'Require']) expect(radio(out, label), `${e.type}: ${label}`).toMatch(/disabled=""/);
        expect(out).toMatch(/<button[^>]*role="switch"[^>]*class="db-sect"[^>]*disabled=""/);
        expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*?Back<\/button>/);
        expect(out).toContain('db-sheet-body is-locked');
        // The pressed one is busy, the other can't be pressed (both stay focusable).
        expect(out).toMatch(e.type === 'test' ? /aria-busy="true"[^>]*>.*?Test Connection/ : /aria-busy="true"[^>]*>Save and Connect/);
      } finally {
        busyRun.state = null;
      }
    }
    // Idle: nothing locked.
    open({ kind: 'add', step: 2, form: { host: 'localhost', port: 5432, database: 'acme', user: 'app' } });
    const idle = html();
    expect(idle).not.toMatch(/ readOnly=""/);
    expect(idle).not.toContain('is-locked');
  });

  test('a change drops the answer for older values; a test that comes back for them is dropped too', () => {
    const tested = runStep(runStep(IDLE_RUN, { type: 'test' }), { type: 'tested', gen: 0, result: ok });
    expect(runStep(tested, { type: 'change', server: false })).toMatchObject({ tested: ok });
    const changed = runStep(tested, { type: 'change', server: true });
    expect(changed).toMatchObject({ tested: null, gen: 1 });
    expect(runStep(runStep(changed, { type: 'test' }), { type: 'tested', gen: 0, result: ok })).toMatchObject({ busy: null, tested: null });
    const refused = runStep(runStep(IDLE_RUN, { type: 'save' }), { type: 'saved', problem });
    expect(runStep(refused, { type: 'change', server: false }).refused).toBeNull();
  });
});

describe('step 1\'s ways to the form', () => {
  test('Continue: a URL fills the form, nothing gives a blank one, anything else is said not to be a URL', () => {
    expect(startFromUrlField(RAILWAY, 'continue')).toMatchObject({ draft: formFromUrl(RAILWAY)!.draft, password: 's3cret-pw', prefilled: true, base: null });
    expect(startFromUrlField('  ', 'continue')).toMatchObject({ draft: draftFrom({}), password: '', prefilled: false });
    expect(startFromUrlField('mysql://x', 'continue')).toBeNull();
  });

  test('the URL error says why — a raw / in the password is to be encoded as %2F; anything else isn\'t a postgres:// URL', () => {
    expect(urlFieldError('postgres://app:pa/ss@db.example.com/acme')).toBe(tdb.sheet.urlSlash);
    expect(tdb.sheet.urlSlash).toContain('%2F');
    expect(urlFieldError('mysql://x')).toBe(tdb.sheet.urlBad);
    expect(urlFieldError('postgres://app@h/my@db')).toBe(tdb.sheet.urlBad);
  });

  test('the PostgreSQL card: the form, prefilled from a valid URL, else blank — never the URL error', () => {
    expect(startFromUrlField(RAILWAY, 'engine')).toMatchObject({ draft: formFromUrl(RAILWAY)!.draft, prefilled: true });
    expect(startFromUrlField('mysql://x', 'engine')).toMatchObject({ draft: draftFrom({}), prefilled: false });
    expect(startFromUrlField('', 'engine')).toMatchObject({ draft: draftFrom({}), prefilled: false });
  });
});

describe('an edit sheet whose connection goes away', () => {
  test('gone from this window: removed, or no longer shown here — said apart; still there, or never there, nothing', () => {
    const mine = conn(DEV, { name: 'acme_dev' });
    const before = { ...EMPTY_DB_SNAPSHOT, connections: [view(prod), view(mine)] };
    const without = (id: string) => ({ ...before, connections: before.connections.filter((v) => v.conn.id !== id) });
    // This project's own connection can only leave by a removal (no other project's window shows it to edit).
    expect(removedElsewhere(DEV, before, without(DEV), ROOT, false)).toEqual({ name: 'acme_dev', removed: true });
    // An every-project one may have been moved to another project's scope, or removed: only "isn't shown here".
    expect(removedElsewhere(PROD, before, without(PROD), ROOT, false)).toEqual({ name: 'acme · production', removed: false });
    // Never (Settings › Databases): main sends an empty snapshot — nothing was removed.
    expect(removedElsewhere(DEV, before, EMPTY_DB_SNAPSHOT, ROOT, true)).toEqual({ name: 'acme_dev', removed: false });
    // Another project's window: its scope isn't this one.
    expect(removedElsewhere(DEV, before, without(DEV), '/other', false)).toEqual({ name: 'acme_dev', removed: false });
    expect(removedElsewhere(PROD, before, before, ROOT, false)).toBeNull();
    expect(removedElsewhere(PROD, EMPTY_DB_SNAPSHOT, EMPTY_DB_SNAPSHOT, ROOT, false)).toBeNull();
    // The words.
    expect(tdb.sheet.removedElsewhere('acme_dev')).toBe('acme_dev was removed in another window');
    expect(tdb.sheet.notShownHere('acme · production')).toBe('acme · production isn’t shown here anymore');
  });
});

describe('the pasted password never stays in the store', () => {
  test('the sheet takes it out of the store into its own state', () => {
    open({ kind: 'add', step: 2, form: { host: 'h', port: 5432, database: 'd', user: 'u' }, password: 's3cret-pw' });
    expect(takePastedPassword()).toBe('s3cret-pw');
    const s = useDb.getState().sheet;
    expect(s).toEqual({ kind: 'add', step: 2, form: { host: 'h', port: 5432, database: 'd', user: 'u' } });
    expect(JSON.stringify(s)).not.toContain('s3cret-pw');
    expect(takePastedPassword()).toBe('');
  });

  test('nor in the page: the field is never controlled, so React writes no value attribute (a controlled one would, even empty)', () => {
    open({ kind: 'add', step: 2, form: { host: 'sample-db1.proxy.rlwy.net', port: 54321, database: 'railway', user: 'postgres' }, password: 's3cret-pw' });
    const out = html();
    const field = /<input[^>]*id="db-f-password"[^>]*>/.exec(out)?.[0] ?? '';
    expect(field).toContain('type="password"');
    expect(field).not.toMatch(/\s(value|defaultValue)=/i);
    expect(out).not.toContain('s3cret-pw');
    // Step 1's URL field (a typed URL may hold a password) neither.
    open({ kind: 'add', step: 1 });
    expect(/<input[^>]*id="db-f-url"[^>]*>/.exec(html())?.[0]).not.toMatch(/\svalue=/i);
  });
});

describe('step 1', () => {
  test('the URL field (focused), the engines (the five others "Later"), the note, Cancel and Continue — nothing of the project\'s', () => {
    open({ kind: 'add', step: 1 });
    const out = html();
    expect(out).toContain('role="dialog"');
    expect(out).toContain('Add Connection');
    expect(out).toContain('Connection URL');
    expect(out).toMatch(/<input[^>]*placeholder="postgres:\/\/user@host:5432\/database"[^>]*data-autofocus/);
    expect(out).toContain('Paste one and the rest fills in. A password in it goes to your Keychain, never to a file.');
    expect(out).not.toContain('Found in this project');
    expect(out).not.toMatch(/>Use</);
    expect(out).toContain('or pick an engine');
    for (const e of DB_ENGINES) expect(out).toContain(`>${e.label}<`);
    expect(out.match(/>Later</g)).toHaveLength(5);
    // PostgreSQL is the one to pick; the others are drawn disabled.
    expect(out.match(/<button[^>]*class="db-engine[^"]*"[^>]*disabled/g)).toHaveLength(5);
    expect(out).toMatch(/class="db-engine is-on"/);
    expect(out).toContain('Speaks Postgres, works today:');
    expect(out).toContain('Supabase · Neon · Railway · Timescale · CockroachDB · AlloyDB · Aurora');
    expect(out).toContain('Every connection opens read-only.');
    expect(out).toContain('>Cancel<');
    expect(out).toContain('>Continue<');
  });
});

describe('step 2', () => {
  const pasted = (): DbSheet => ({ kind: 'add', step: 2, form: { host: 'sample-db1.proxy.rlwy.net', port: 54321, database: 'railway', user: 'postgres', tls: 'require' } });

  test('every label, the provider chip, the guessed environment and TLS, the read-only note and the three buttons', () => {
    useApp.setState({ settings: { ...useApp.getState().settings, dbTimeoutSec: 15 } });
    open(pasted());
    const out = html();
    for (const l of ['Name', 'Show in', 'Environment', 'Host', 'Port', 'Database', 'User', 'Password', 'Encryption (TLS)', 'SSH tunnel']) expect(out, l).toContain(`>${l}<`);
    expect(out).toContain('acme-store');
    expect(out).toContain('Every project');
    for (const e of ['Local', 'Development', 'Staging', 'Production']) expect(radio(out, e), e).not.toBe('');
    expect(radio(out, 'Development')).toContain('aria-checked="true"');
    expect(radio(out, 'Production')).toContain('is-prod');
    expect(out).toContain('Production frames its tabs in the theme’s danger color.');
    expect(out).toMatch(/class="db-chip"[^>]*>Railway</);
    expect(out).toContain('value="Railway · railway"');
    for (const m of ['Off', 'Prefer', 'Require', 'Verify']) expect(radio(out, m), m).not.toBe('');
    expect(radio(out, 'Require')).toContain('aria-checked="true"');
    expect(out).toContain('encrypted, the certificate not checked');
    expect(out).toContain('Reach the database through a bastion host, with your SSH agent’s keys');
    expect(out).toContain('Keychain');
    expect(out).toContain('Read-only, always.');
    expect(out).toContain('BEGIN READ ONLY … ROLLBACK');
    expect(out).toContain('15 s');
    expect(out).toContain('>Test Connection<');
    expect(out).toContain('>Cancel<');
    expect(out).toMatch(/<button[^>]*class="btn-primary"[^>]*>Save and Connect</);
    expect(out).not.toMatch(/<button[^>]*disabled[^>]*>Save and Connect</);
    expect(out).toContain('>Back<');
  });

  test('a form main would refuse: the field says why, Save and Connect waits', () => {
    open({ kind: 'add', step: 2, form: { host: 'localhost', port: 5432, database: 'acme', user: '' } });
    const out = html();
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Save and Connect</);
    expect(out).toContain('A user is needed');
  });

  test('editing: the same step, its own title, "•••• saved" for a saved password, no Back', () => {
    open({ kind: 'edit', id: PROD }, { connections: [view(prod, { hasPassword: true })] });
    const out = html();
    expect(out).toContain('Edit Connection');
    expect(out).toContain('placeholder="•••• saved"');
    expect(out).toContain('value="acme · production"');
    expect(radio(out, 'Production')).toContain('aria-checked="true"');
    expect(radio(out, 'Every project')).toContain('aria-checked="true"');
    expect(out).not.toContain('>Back<');
  });

  test('editing a connection with no saved password: no "saved" placeholder', () => {
    open({ kind: 'edit', id: DEV }, { connections: [view(conn(DEV))] });
    expect(html()).not.toContain('•••• saved');
  });

  test('SSH on: its host, and port and user left to ~/.ssh/config', () => {
    open({ kind: 'edit', id: DEV }, { connections: [view(conn(DEV, { host: 'db.internal', ssh: { host: 'bastion', port: null, user: '' } }))] });
    const out = html();
    expect(out).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(out).toContain('>SSH host<');
    expect(out).toContain('value="bastion"');
    expect(out).toContain('placeholder="22 · from ~/.ssh/config"');
    expect(out).toContain('placeholder="from ~/.ssh/config"');
  });

  test('an edit sheet for a connection this window doesn\'t show draws nothing', () => {
    open({ kind: 'edit', id: DEV });
    expect(html()).toBe('');
  });
});

describe('Test Connection\'s answer', () => {
  const note = (r: Parameters<typeof TestNote>[0]['result']) => renderLive(createElement(TestNote, { result: r }));

  test('connected: the latency, then the server version, TLS and the role that can only read', () => {
    const out = note({ kind: 'ok', server: SERVER });
    expect(out).toContain('db-sheet-note is-ok');
    expect(out).toContain('Connected in 84 ms');
    expect(out).toContain('PostgreSQL 17.2 · TLS · role readonly_analyst can only read');
  });

  test('a role that can write says so, in amber; no TLS says so', () => {
    const out = note({ kind: 'ok', server: { ...SERVER, tls: false, role: 'postgres', canWrite: true } });
    expect(out).toContain('PostgreSQL 17.2 · no TLS · role postgres');
    expect(out).toMatch(/class="db-sheet-warn">can write</);
  });

  test('a problem: its title, the detail in mono, a hint; Postgres\'s own error with its SQLSTATE, quiet', () => {
    const refused = note({ kind: 'err', problem: { kind: 'refused', message: 'Can\'t connect · connection refused localhost:5432', hint: 'Is Postgres running?' } });
    expect(refused).toContain('db-sheet-note is-err');
    expect(refused).toContain('Can&#x27;t connect');
    expect(refused).toMatch(/class="db-sheet-note-mono">connection refused localhost:5432</);
    expect(refused).toContain('Is Postgres running?');
    const other = note({ kind: 'err', problem: { kind: 'other', message: 'permission denied for database acme', code: '42501', detail: 'role app' } });
    expect(other).toContain('permission denied for database acme');
    expect(other).toContain('role app');
    expect(other).toMatch(/class="db-sheet-note-code">SQLSTATE 42501</);
  });
});

describe('what the buttons do', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let toast: Mock<(text: string | null) => void>;
  let closeDbTabs: Mock<(filter: (r: DbTabRef) => boolean) => void>;
  const NEW = 'c0000000000f1';
  beforeEach(() => {
    api = {
      save: vi.fn(async () => ({ ok: true, value: { id: NEW } })),
      select: vi.fn(async () => {}), test: vi.fn(async () => ({ ok: true, value: SERVER })), remove: vi.fn(async () => {})
    };
    toast = vi.fn();
    closeDbTabs = vi.fn();
    vi.stubGlobal('window', { atelier: { databases: api } });
    useApp.setState({ showToast: toast, closeDbTabs });
  });
  afterEach(() => vi.unstubAllGlobals());
  const sheetOpen = () => open({ kind: 'add', step: 2 });

  test('Save and Connect: the exact form and the typed password, then picked and connected, the sheet closed', async () => {
    sheetOpen();
    expect(await saveAndConnect({ draft: railway(), root: ROOT, password: 'pw', base: null, editId: null })).toBeNull();
    expect(api.save).toHaveBeenCalledWith({ form: formToConnection(railway(), ROOT), password: 'pw', id: null });
    expect(api.select).toHaveBeenCalledWith(NEW);
    expect(useDb.getState().sheet).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  test('editing with the field left empty: null, so main keeps the saved password', async () => {
    open({ kind: 'edit', id: PROD }, { connections: [view(prod, { hasPassword: true })] });
    await saveAndConnect({ draft: draftOfConn(prod), root: ROOT, password: '', base: { kind: 'edit', conn: prod, hasPassword: true }, editId: PROD });
    expect(api.save).toHaveBeenCalledWith({ form: formToConnection(draftOfConn(prod), ROOT), password: null, id: PROD });
    expect(api.select).toHaveBeenCalledWith(NEW);
  });

  test('the Keychain refused the password: saved anyway, said in a toast — never the password itself', async () => {
    sheetOpen();
    api.save!.mockResolvedValueOnce({ ok: true, value: { id: NEW }, warning: 'The Keychain refused the password: it\'s kept until you quit.' });
    await saveAndConnect({ draft: railway(), root: ROOT, password: 's3cret-pw', base: null, editId: null });
    expect(toast).toHaveBeenCalledWith('The Keychain refused the password: it\'s kept until you quit.');
    expect(JSON.stringify(toast.mock.calls)).not.toContain('s3cret-pw');
  });

  test('refused: the problem for the sheet, which stays; nothing connects', async () => {
    sheetOpen();
    const problem = { kind: 'other' as const, message: 'Invalid connection: host' };
    api.save!.mockResolvedValueOnce({ ok: false, problem });
    expect(await saveAndConnect({ draft: railway(), root: ROOT, password: '', base: null, editId: null })).toEqual(problem);
    expect(useDb.getState().sheet).not.toBeNull();
    expect(api.select).not.toHaveBeenCalled();
  });

  test('Test Connection: the request testArgs makes, main\'s answer as the note\'s', async () => {
    const base = { kind: 'edit' as const, conn: prod, hasPassword: true };
    expect(await testConnection({ draft: draftOfConn(prod), root: ROOT, password: '', base })).toEqual({ kind: 'ok', server: SERVER });
    expect(api.test).toHaveBeenCalledWith(testArgs(draftOfConn(prod), ROOT, '', base));
    const problem = { kind: 'auth' as const, message: 'Wrong user or password' };
    api.test!.mockResolvedValueOnce({ ok: false, problem });
    expect(await testConnection({ draft: railway(), root: ROOT, password: 'x', base: null })).toEqual({ kind: 'err', problem });
  });

  test('Remove: the sheet goes, main removes it, this window closes its tabs', async () => {
    open({ kind: 'remove', id: PROD }, { connections: [view(prod)] });
    await removeConnection(PROD);
    expect(useDb.getState().sheet).toBeNull();
    expect(api.remove).toHaveBeenCalledWith(PROD);
    expect(closeDbTabs).toHaveBeenCalledTimes(1);
    const which = closeDbTabs.mock.calls[0]![0];
    const tab = (connId: string): DbTabRef => ({ key: `db:${connId}`, connId, schema: 'public', name: 'orders', kind: 'table', view: 'data' } as DbTabRef);
    expect(which(tab(PROD))).toBe(true);
    expect(which(tab(DEV))).toBe(false);
  });

  test('Remove that failed: said, and the tabs stay', async () => {
    open({ kind: 'remove', id: PROD }, { connections: [view(prod)] });
    api.remove!.mockRejectedValueOnce(new Error('gone'));
    await removeConnection(PROD);
    expect(toast).toHaveBeenCalledWith('Couldn\'t remove the connection');
    expect(closeDbTabs).not.toHaveBeenCalled();
  });
});

describe('Remove Connection (in-app confirm)', () => {
  test('"Remove <name>? Its saved password goes too." with Remove in the danger color and Cancel', () => {
    open({ kind: 'remove', id: PROD }, { connections: [view(prod, { hasPassword: true })] });
    const out = html();
    expect(out).toContain('role="alertdialog"');
    expect(out).toContain('Remove acme · production?');
    expect(out).toContain('Its saved password goes too.');
    expect(out).toMatch(/<button type="button" class="btn-danger sm"[^>]*>Remove</);
    expect(out).toContain('Cancel');
  });

  test('it hangs under the connection\'s row, which carries its id', () => {
    useDb.setState({ loaded: true, sheet: null, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(prod)] } });
    expect(renderLive(DatabasesList)).toMatch(new RegExp(`<button type="button" class="db-conn[^"]*"[^>]*data-conn="${PROD}"`));
  });

  test('a connection without a saved password: no line about one', () => {
    open({ kind: 'remove', id: DEV }, { connections: [view(conn(DEV))] });
    const out = html();
    expect(out).toContain('Remove c00000000000a?');
    expect(out).not.toContain('saved password');
  });
});
