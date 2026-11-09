// Catch me up: the JSON schema handed to `claude -p --json-schema` and the validator that never trusts what came back.

import type { CatchPoint, CatchUp, PointStatus } from './types';

/** The one source of the limits: the schema and the validator both read it. */
export const CATCHUP_LIMITS = { points: 12, pointText: 80, note: 100, where: 400, choices: 3, choice: 100, leftOpen: 300 } as const;

const STATUSES: readonly PointStatus[] = ['done', 'in_progress', 'not_started', 'unclear'];
const AT_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';
const AT_RE = new RegExp(AT_PATTERN);

export const CATCHUP_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['points', 'where', 'choices', 'leftOpen'],
  properties: {
    points: {
      type: 'array',
      maxItems: CATCHUP_LIMITS.points,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'text', 'status', 'at', 'note'],
        properties: {
          n: { type: 'integer' },
          text: { type: 'string', maxLength: CATCHUP_LIMITS.pointText },
          status: { type: 'string', enum: [...STATUSES] },
          at: { type: ['string', 'null'], pattern: AT_PATTERN },
          note: { type: ['string', 'null'], maxLength: CATCHUP_LIMITS.note },
        },
      },
    },
    where: { type: 'string', maxLength: CATCHUP_LIMITS.where },
    choices: { type: 'array', maxItems: CATCHUP_LIMITS.choices, items: { type: 'string', maxLength: CATCHUP_LIMITS.choice } },
    leftOpen: { type: ['string', 'null'], maxLength: CATCHUP_LIMITS.leftOpen },
  },
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Rec, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
/** At most `max` characters, counted as the schema's maxLength does (code points; one is at most two UTF-16 units). */
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= 2 * max && [...v].length <= max;
const strOrNull = (v: unknown, max: number): v is string | null => v === null || str(v, max);

function parsePoint(v: unknown): CatchPoint | null {
  if (!isRec(v) || !onlyKeys(v, ['n', 'text', 'status', 'at', 'note'])) return null;
  const { n, text, status, at, note } = v;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  if (!str(text, CATCHUP_LIMITS.pointText)) return null;
  if (typeof status !== 'string' || !STATUSES.includes(status as PointStatus)) return null;
  if (at !== null && !(typeof at === 'string' && AT_RE.test(at))) return null;
  if (!strOrNull(note, CATCHUP_LIMITS.note)) return null;
  return { n, text, status: status as PointStatus, at, note };
}

/** Validates a model's catch-up against the same limits as the schema. Never throws. */
export function parseCatchUp(raw: unknown): CatchUp | null {
  if (!isRec(raw) || !onlyKeys(raw, ['points', 'where', 'choices', 'leftOpen'])) return null;
  const { points, where, choices, leftOpen } = raw;
  if (!Array.isArray(points) || points.length > CATCHUP_LIMITS.points) return null;
  if (!str(where, CATCHUP_LIMITS.where)) return null;
  if (!Array.isArray(choices) || choices.length > CATCHUP_LIMITS.choices) return null;
  if (!choices.every((c) => str(c, CATCHUP_LIMITS.choice))) return null;
  if (!strOrNull(leftOpen, CATCHUP_LIMITS.leftOpen)) return null;
  const parsed: CatchPoint[] = [];
  for (const p of points) {
    const pt = parsePoint(p);
    if (!pt) return null;
    parsed.push(pt);
  }
  return { points: parsed, where, choices: [...(choices as string[])], leftOpen };
}
