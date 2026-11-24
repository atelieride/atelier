// The app messages of an iPhone connection, inside the Noise channel: what a phone may send (strict schemas — an
// unknown field or kind is refused), and what this computer sends it. Every message is one JSON object with a string
// `t`; requests carry `rid`, a positive integer the phone picks, repeated in the answer.
import { z } from 'zod';
import { ACCOUNT_ID } from '@shared/claude-accounts';
import type { RemoteLayout } from '@shared/remote';

/** Control and line-separator characters: names are shown as plain text on both ends. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const shownText = (max: number) => z.string().min(1).max(max).refine((s) => !CONTROL.test(s) && s.trim().length > 0, 'text');

/** Message 3's payload: who the phone says it is (shown in the Allow prompt and in Settings). */
export const deviceHelloSchema = z.object({
  v: z.literal(1),
  name: shownText(64),
  model: z.string().regex(/^[A-Za-z0-9,._ -]{1,64}$/),
  app: z.string().regex(/^[A-Za-z0-9.+_-]{1,32}$/)
}).strict();
export type DeviceHello = z.infer<typeof deviceHelloSchema>;

const rid = z.number().int().min(1).max(2 ** 31 - 1);
const terminalId = z.string().min(1).max(64);
const dim = z.number().int().min(2).max(1000);
/** At most 64 KiB of UTF-8 per input message. */
export const MAX_INPUT_BYTES = 64 * 1024;

/** A workspace or activity of a project's layout, as the sidebar names it. */
const placeId = z.string().regex(/^[\w-]{1,40}$/);
/** A Claude account, by the id `usage` lists (never a directory). */
const accountId = z.string().regex(ACCOUNT_ID);
/** A wait's key, as the state gave it. */
const waitKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A push key: 32 bytes, base64url without padding. */
const pushKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((k) => Buffer.from(k, 'base64url').length === 32 && Buffer.from(k, 'base64url').toString('base64url') === k, 'a 32-byte key');
/** At most 60 characters (not UTF-16 units: an emoji counts once). */
export const MAX_NAME = 60;
/** A listed project, by the opaque id the state gave it. */
const projectId = z.string().min(1).max(64);
/** A workspace's or an activity's name as it travels (its rule: placeNameProblem). */
const placeName = z.string().max(MAX_NAME * 4);

export const deviceMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('attach'), rid, id: terminalId, cols: dim, rows: dim }).strict(),
  z.object({ t: z.literal('detach'), id: terminalId }).strict(),
  z.object({ t: z.literal('input'), id: terminalId, data: z.string().max(MAX_INPUT_BYTES).refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_INPUT_BYTES, 'input too large') }).strict(),
  z.object({ t: z.literal('resize'), id: terminalId, cols: dim, rows: dim }).strict(),
  z.object({ t: z.literal('create'), rid, project: z.string().min(1).max(64), kind: z.enum(['claude', 'terminal']), place: placeId.optional(), account: accountId.optional() }).strict(),
  z.object({ t: z.literal('answer'), rid, id: terminalId, wait: waitKey, choice: z.enum(['allow', 'deny']) }).strict(),
  z.object({ t: z.literal('rename'), rid, id: terminalId, name: z.string().max(MAX_NAME * 4).refine((s) => [...s].length <= MAX_NAME, 'name too long') }).strict(),
  z.object({ t: z.literal('close'), rid, id: terminalId }).strict(),
  z.object({ t: z.literal('resume'), rid, id: terminalId }).strict(),
  z.object({ t: z.literal('dismiss'), rid, id: terminalId }).strict(),
  // Push notifications: an APNs device token (hex), its environment and the 32-byte key notices are sealed with;
  // a null token unregisters (nothing else then).
  z.object({ t: z.literal('push'), rid, token: z.string().regex(/^[0-9a-fA-F]{64,200}$/).nullable(), env: z.enum(['sandbox', 'production']).optional(), key: pushKey.optional() }).strict()
    .refine((m) => (m.token === null ? m.env === undefined && m.key === undefined : m.env !== undefined && m.key !== undefined), 'a token comes with its environment and key'),
  // Workspaces and activities, applied in the project's window. A name's own rule is placeNameProblem's, answered by
  // the hub in words; here it is only bounded.
  z.object({ t: z.literal('workspace'), rid, project: projectId, name: placeName.optional() }).strict(),
  z.object({ t: z.literal('activity'), rid, project: projectId, workspace: placeId, name: placeName.optional() }).strict(),
  z.object({ t: z.literal('renamePlace'), rid, project: projectId, place: placeId, name: placeName }).strict(),
  z.object({ t: z.literal('move'), rid, id: terminalId, place: placeId }).strict(),
  // Closing a workspace or an activity as its Close… does: what is in it moves (the default) or stops.
  z.object({ t: z.literal('closePlace'), rid, project: projectId, place: placeId, sessions: z.enum(['move', 'stop']).optional() }).strict(),
  // A project's window, opened as a recent project opens, or closed as its own close does: `sessions` is the phone's
  // user's answer to the question Atelier asks about what is still busy in it.
  z.object({ t: z.literal('openWindow'), rid, project: projectId }).strict(),
  z.object({ t: z.literal('closeWindow'), rid, project: projectId, sessions: z.enum(['keep', 'stop']).optional() }).strict()
]);
/** The requests that change rows, places or windows (answered `busy` past their shared limit). */
export const ROW_ACTIONS: ReadonlySet<DeviceMessage['t']> = new Set(['answer', 'rename', 'close', 'resume', 'dismiss', 'workspace', 'activity', 'renamePlace', 'move', 'closePlace', 'openWindow', 'closeWindow']);
export type DeviceMessage = z.infer<typeof deviceMessageSchema>;

/**
 * Why a workspace's or an activity's name from a phone can't be one, or null when it can: 1…60 characters (an emoji
 * counts once), on one line, not only spaces.
 */
export function placeNameProblem(name: string): string | null {
  const n = [...name].length;
  if (n === 0 || n > MAX_NAME || name.trim().length === 0) return `A name has 1 to ${MAX_NAME} characters.`;
  if (CONTROL.test(name)) return 'A name stays on one line, without control characters.';
  return null;
}

export interface RemoteProject { id: string; name: string; color: number | null; open: boolean }
/** A row of a project's sidebar as a phone draws it: what Atelier shows of it, by names and ids, never paths. */
export interface RemoteSession {
  id: string;
  project: string;
  title: string;
  claude: boolean;
  state: 'idle' | 'running' | 'waiting' | 'done' | 'error';
  waitingFor?: 'permission' | 'question';
  createdAt: number;
  /** The group the sidebar puts it in when grouping by state. */
  section: 'needs' | 'review' | 'working' | 'idle';
  /** Its own color, #RRGGBB. */
  color: string;
  starting?: true;
  unread?: true;
  /** The line under its name in the sidebar (≤ 120 characters). */
  detail?: string;
  /** While waiting for a permission: what for (≤ 60 characters). */
  permission?: string;
  /** While waiting: a key of this very wait (an `answer` names it). */
  wait?: string;
  lastMessageAt?: number;
  model?: string;
  contextPct?: number;
  mode?: 'plan' | 'bypass';
  agents?: number;
  /** Background work as the row's chip counts it; `idle` when none of it counts (past its cap, a watcher). */
  work?: { agents?: number; shells?: number; monitors?: number; tasks?: number; idle?: true };
  /** How many wake-ups are set (cron jobs, loops). */
  scheduled?: number;
  /** The soonest wake-up that has a time (ms); absent when none has one, or while a self-paced loop's has fired. */
  wakeAt?: number;
  /** The terminal profile's label when not the default one (≤ 40 characters), never a folder. */
  profile?: string;
  /** An account's id (as `usage` lists it), only when not the default one. */
  account?: string;
  /** The folder or worktree it runs in when not the project's root: a name, never a path. */
  folder?: string;
  /** `folder` names a linked git worktree. */
  worktree?: true;
  /** A plain terminal's foreground program, by name only. */
  command?: string;
  ports?: { port: number; name?: string }[];
  pr?: { number: number; title: string; state: 'open' | 'draft' | 'merged' | 'closed'; checks?: 'pass' | 'fail' | 'pending' };
  cost?: { usd: number; added: number; removed: number };
}
/** A session Atelier offers to resume. */
export interface RemoteResumable { id: string; project: string; title: string; color: string; endedAt: number; lastMessageAt?: number; account?: string }
/** A Claude account with its limits when known (a window whose reset has passed is left out): names and colors only. */
export interface RemoteAccount {
  id: string; name: string; color: number | null; default: boolean;
  fiveHour?: { pct: number; resetsAt: number }; sevenDay?: { pct: number; resetsAt: number }; updatedAt?: number;
}

export type ErrorCode = 'not-found' | 'invalid' | 'busy' | 'failed';
export type DeniedReason = 'declined' | 'expired' | 'unknown-device' | 'disabled';
export type ByeReason = 'revoked' | 'disabled' | 'quitting';

export type HostMessage =
  | { t: 'welcome'; host: { name: string; platform: string; app: string }; room?: string }
  | { t: 'denied'; reason: DeniedReason }
  | { t: 'state'; projects: RemoteProject[]; sessions: RemoteSession[]; resumables: RemoteResumable[] }
  | { t: 'usage'; accounts: RemoteAccount[] }
  | { t: 'layout'; project: string; layout: RemoteLayout | null }
  | { t: 'snapshot'; id: string; cols: number; rows: number; data: string }
  | { t: 'out'; id: string; data: string }
  | { t: 'size'; id: string; cols: number; rows: number }
  | { t: 'exit'; id: string }
  | { t: 'ok'; rid: number }
  | { t: 'created'; rid: number; id: string }
  /** rid 0: the refused message carried none (input, resize, detach). */
  | { t: 'error'; rid: number; code: ErrorCode; message: string }
  | { t: 'bye'; reason: ByeReason };

/** The close codes this computer ends a channel with (the relay passes them on to the phone). */
export const CLOSE = {
  /** A normal end: a `bye` or `denied` message just said why. */
  normal: 4000,
  /** A message that doesn't decrypt or parse, or a failed handshake. */
  malformed: 4400,
  /** A phone whose key isn't paired with this computer. */
  unknownDevice: 4401,
  /** A pairing channel while no code is live. */
  noCode: 4404,
  /** The handshake took too long. */
  timeout: 4408,
  /** A message beyond 8 MiB, or a frame beyond a Noise message's 65535 bytes. */
  tooLarge: 4413,
  /**
   * Too many refused messages, more output queued than the link carries, or too many handshakes at once (the phone
   * reconnects).
   */
  overloaded: 4429
} as const;
