// The app messages of an iPhone connection, inside the Noise channel: what a phone may send (strict schemas — an
// unknown field or kind is refused), and what this computer sends it. Every message is one JSON object with a string
// `t`; requests carry `rid`, a positive integer the phone picks, repeated in the answer.
import { z } from 'zod';

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

export const deviceMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('attach'), rid, id: terminalId, cols: dim, rows: dim }).strict(),
  z.object({ t: z.literal('detach'), id: terminalId }).strict(),
  z.object({ t: z.literal('input'), id: terminalId, data: z.string().max(MAX_INPUT_BYTES).refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_INPUT_BYTES, 'input too large') }).strict(),
  z.object({ t: z.literal('resize'), id: terminalId, cols: dim, rows: dim }).strict(),
  z.object({ t: z.literal('create'), rid, project: z.string().min(1).max(64), kind: z.enum(['claude', 'terminal']) }).strict()
]);
export type DeviceMessage = z.infer<typeof deviceMessageSchema>;

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
  /** An account's id (as `usage` lists it), only when not the default one. */
  account?: string;
  /** The folder or worktree it runs in when not the project's root: a name, never a path. */
  folder?: string;
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
  | { t: 'welcome'; host: { name: string; platform: string }; room?: string }
  | { t: 'denied'; reason: DeniedReason }
  | { t: 'state'; projects: RemoteProject[]; sessions: RemoteSession[]; resumables: RemoteResumable[] }
  | { t: 'usage'; accounts: RemoteAccount[] }
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
  /** A message beyond 8 MiB. */
  tooLarge: 4413,
  /** Too many refused messages, or more output queued than the link carries (the phone reconnects). */
  overloaded: 4429
} as const;
