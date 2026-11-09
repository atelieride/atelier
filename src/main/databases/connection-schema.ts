// A saved database connection's shape: the connections file's schema (store.ts) and the
// IPC's form (ipc-schemas.ts dbFormSchema) are built from these fields. Schemas only: no file access, so every IPC
// module can import it.
import { z } from 'zod';
import { isAbsPath } from '@shared/paths';
import type { DbConnection } from '@shared/databases';

/** A connection id: `c` + 12 lowercase hex characters (it doubles as the Keychain secret id's suffix). */
export const DB_CONN_ID = /^c[0-9a-f]{12}$/;
const text = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, 'control characters');
const absPath = z.string().max(4096).refine((p) => isAbsPath(p) && !p.includes('\u0000'), 'absolute path');
const port = z.number().int().min(1).max(65535);
/**
 * Through an SSH tunnel (ssh-tunnel.ts sshArgs checks again): a host is a host name, a
 * ~/.ssh/config alias or an IPv4 address ([A-Za-z0-9._-], no leading '-': ssh would read it as an option,
 * `-oProxyCommand=…` runs a command; '_' for aliases and compose service names) or an IPv6 literal (hex digits, ':',
 * '.', an optional %zone); a user is [A-Za-z0-9._-] with no leading '-', or '' (~/.ssh/config decides, as for a
 * null port).
 */
const TUNNEL_HOST = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*|(?=[^%]*:)[0-9A-Fa-f:.]+(?:%[A-Za-z0-9]+)?)$/;
const SSH_USER = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*)?$/;
const tunnelHost = z.string().min(1).max(255).regex(TUNNEL_HOST, 'a host name or an IP address');

// Empty user/database/host are refused on purpose: node-postgres would fill them from PG* environment variables.
/** A connection's fields, every one bounded (the IPC's form is these minus what main keeps: ipc-schemas.ts dbFormSchema). */
export const dbConnectionFields = z.object({
  id: z.string().regex(DB_CONN_ID),
  name: text(120).min(1),
  engine: z.literal('postgres'),
  env: z.enum(['local', 'dev', 'staging', 'prod']),
  host: text(255),
  port,
  database: text(128).min(1),
  user: text(128).min(1),
  socket: absPath.optional(),
  tls: z.enum(['off', 'prefer', 'require', 'verify']),
  ssh: z.object({ host: tunnelHost, port: port.nullable(), user: z.string().max(128).regex(SSH_USER, 'letters, digits, . _ -') }).strict().nullable(),
  scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('project'), root: absPath }).strict(), z.object({ kind: z.literal('all') }).strict()]),
  mask: z.boolean(),
  writeNoted: z.boolean(),
  schema: text(128).min(1).optional(),
  createdAt: z.number().finite()
}).strict();
/** A host or a socket: one of them says where the server is. */
export const hasEndpoint = (c: { host: string; socket?: string }): boolean => c.socket !== undefined || c.host.length > 0;
/** An SSH tunnel forwards TCP: a connection through one has a host, never a socket. */
export const sshOverTcp = (c: { ssh: unknown; socket?: string }): boolean => c.ssh === null || c.socket === undefined;
/** Through an SSH tunnel the database host goes into ssh's argv (-L): a host name or an IP literal. */
export const sshTarget = (c: { ssh: unknown; host: string }): boolean => c.ssh === null || tunnelHost.safeParse(c.host).success;
export const dbConnectionSchema = dbConnectionFields
  .refine(hasEndpoint, { message: 'host or socket', path: ['host'] })
  .refine(sshOverTcp, { message: 'an SSH tunnel needs a host, not a socket', path: ['socket'] })
  .refine(sshTarget, { message: 'through an SSH tunnel, a host name or an IP address', path: ['host'] }) as unknown as z.ZodType<DbConnection>;
