// Add / Edit Connection: the renderer's form mirrors main's rules, so Save and Connect is
// enabled exactly when main would take the form, and the "•••• saved" placeholder shows exactly
// while main would keep the saved password. Checked here against main's own schema and secretTargetOf, so the two
// can't drift apart.
import { describe, expect, test } from 'vitest';
import type { DbConnectionForm } from '../../src/shared/databases';
import { initPlatform, resetPlatformForTests } from '../../src/shared/platform';
import { secretTargetOf } from '../../src/main/databases/hub';
import { dbFormSchema } from '../../src/main/ipc-schemas';
import { draftFrom, formErrors, formToConnection, sameServer, type DbDraft } from '../../src/renderer/databases/form';

const ROOT = '/Users/me/acme-store';
const base: DbDraft = { ...draftFrom({ host: 'db.example.com', port: 5432, database: 'acme', user: 'app' }), name: 'acme' };
const ssh = (p: Partial<DbDraft>): DbDraft => ({ ...base, ssh: true, sshHost: 'bastion', ...p });

const CASES: [string, DbDraft][] = [
  ['complete', base],
  ['no name', { ...base, name: '' }],
  ['name too long', { ...base, name: 'x'.repeat(121) }],
  ['name of 120', { ...base, name: 'x'.repeat(120) }],
  ['control character in the name', { ...base, name: 'a\u0007b' }],
  ['no host', { ...base, host: '' }],
  ['host too long', { ...base, host: `${'h'.repeat(256)}` }],
  ['host with a space (no SSH)', { ...base, host: 'db 1' }],
  ['socket, no host', { ...base, host: '', socket: '/var/run/postgresql' }],
  ['socket and host', { ...base, socket: '/tmp' }],
  ['relative socket', { ...base, host: '', socket: 'tmp' }],
  ['port 0', { ...base, port: '0' }],
  ['port 65535', { ...base, port: '65535' }],
  ['port 65536', { ...base, port: '65536' }],
  ['port empty', { ...base, port: '' }],
  ['port text', { ...base, port: 'abc' }],
  ['no database', { ...base, database: '' }],
  ['database of 129', { ...base, database: 'd'.repeat(129) }],
  ['no user', { ...base, user: '' }],
  ['user of 128', { ...base, user: 'u'.repeat(128) }],
  ['ssh with host only', ssh({})],
  ['ssh without host', ssh({ sshHost: '' })],
  ['ssh host an option', ssh({ sshHost: '-oProxyCommand=x' })],
  ['ssh host with a space', ssh({ sshHost: 'a b' })],
  ['ssh host an alias with _', ssh({ sshHost: 'prod_bastion' })],
  ['ssh host IPv6 with zone', ssh({ sshHost: 'fe80::1%en0' })],
  ['ssh host IPv4', ssh({ sshHost: '10.0.0.1' })],
  ['ssh port 22', ssh({ sshPort: '22' })],
  ['ssh port 0', ssh({ sshPort: '0' })],
  ['ssh port 70000', ssh({ sshPort: '70000' })],
  ['ssh user', ssh({ sshUser: 'deploy' })],
  ['ssh user an option', ssh({ sshUser: '-l' })],
  ['ssh user with a space', ssh({ sshUser: 'a b' })],
  ['ssh user of 129', ssh({ sshUser: 'u'.repeat(129) })],
  ['ssh and a socket', ssh({ host: '', socket: '/tmp' })],
  ['ssh and a host that is an option', ssh({ host: '-db' })],
  ['ssh and a host with a space', ssh({ host: 'db 1' })],
  ['ssh and an IPv6 database host', ssh({ host: '::1' })],
  ['ssh off keeps odd fields unchecked', { ...base, ssh: false, sshHost: '-x', sshPort: 'x', sshUser: '-y' }]
];

describe('the form\'s errors are main\'s schema (Save and Connect enabled exactly when main takes it)', () => {
  test.each(CASES)('%s', (_, d) => {
    const ok = Object.keys(formErrors(d)).length === 0;
    expect(ok).toBe(dbFormSchema.safeParse(formToConnection(d, ROOT)).success);
  });

  test('Windows: a socket folder is absolute as main reads it there (a drive letter); a POSIX path is not', () => {
    initPlatform('win32');
    try {
      for (const socket of ['C:\\pg\\run', 'D:/sockets', '/tmp', 'pg', '\\\\server\\share']) {
        const d: DbDraft = { ...base, host: '', socket };
        expect(Object.keys(formErrors(d)).length === 0, socket).toBe(dbFormSchema.safeParse(formToConnection(d, 'C:\\code\\acme')).success);
      }
      expect(Object.keys(formErrors({ ...base, host: '', socket: 'C:\\pg' }))).toEqual([]);
    } finally {
      resetPlatformForTests();
    }
  });

  test('both sides of the line are covered', () => {
    const oks = CASES.filter(([, d]) => Object.keys(formErrors(d)).length === 0).length;
    expect(oks).toBeGreaterThan(8);
    expect(CASES.length - oks).toBeGreaterThan(15);
  });
});

describe('"•••• saved" exactly while main keeps the saved password', () => {
  const a: DbConnectionForm = formToConnection(base, ROOT);
  const t: DbConnectionForm = formToConnection(ssh({ sshPort: '22', sshUser: 'deploy' }), ROOT);
  const PAIRS: [string, DbConnectionForm, DbConnectionForm][] = [
    ['same', a, { ...a }],
    ['another database and user', a, { ...a, database: 'other', user: 'other', name: 'n', env: 'prod' }],
    ['another host', a, { ...a, host: 'other' }],
    ['another port', a, { ...a, port: 6543 }],
    ['a socket', a, { ...a, socket: '/tmp' }],
    ['another TLS mode', a, { ...a, tls: 'verify' }],
    ['through SSH', a, t],
    ['same SSH', t, { ...t, ssh: { host: 'bastion', port: 22, user: 'deploy' } }],
    ['SSH port left to the config', t, { ...t, ssh: { host: 'bastion', port: null, user: 'deploy' } }],
    ['another SSH user', t, { ...t, ssh: { host: 'bastion', port: 22, user: 'root' } }],
    ['another SSH host', t, { ...t, ssh: { host: 'jump', port: 22, user: 'deploy' } }]
  ];
  test.each(PAIRS)('%s', (_, x, y) => {
    expect(sameServer(x, y)).toBe(secretTargetOf(x) === secretTargetOf(y));
  });
});
