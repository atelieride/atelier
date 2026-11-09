// Automations: the model, its validation, and the pure decisions the runner
// takes — which tasks match, which ones are new, and whether a run starts, waits in line or waits for the user. No
// Electron, no I/O: the runner (src/main/automations/) feeds these with what it read.
import { isCleanAbsPath } from './clean-path';
import { validBranchName } from './git-write';
import { pathStyle, type PathStyle } from './platform';
import type { ClaudeModel } from './settings';
import type { ConnectorId } from './tasks';

/** Claude's permission mode for a run. Never bypassPermissions or dontAsk (settings rule). */
export type AutomationMode = 'plan' | 'auto' | 'acceptEdits' | 'default';
export type ConditionField = 'status' | 'assignee' | 'createdBy' | 'tag' | 'priority' | 'title' | 'due';

/**
 * One condition; every condition of an automation must hold. `values` by field: status, tag — any of the names;
 * assignee, createdBy — any of the user ids, "me" for the connected user; priority — at least values[0]; title —
 * contains values[0]; due — within values[0] days.
 */
export interface Condition {
  field: ConditionField;
  values: string[];
  /** The values' names for display, one per value (people: "Me", a name), as picked; never matched. */
  labels?: string[];
}

export type BaseRef = 'default' | 'current' | { branch: string };

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: number;
  /** The project's real root. */
  project: string;
  /** Relative to the project, '' = its root. */
  folder: string;
  /** ClickUp list ids or Notion data source ids; `labels`: their names as picked (display only, one per scope). */
  source: { connector: ConnectorId; scopes: string[]; labels?: string[] };
  conditions: Condition[];
  claude: { account: string; model: ClaudeModel; mode: AutomationMode; decideAlone: boolean; useSourceMcp: boolean };
  isolation: { worktree: boolean; base: BaseRef };
  instructions: string;
  limits: { concurrent: number; perDay: number; checkEveryMin: CheckEvery; usagePause: number | null };
  rerunWhenMatchesAgain: boolean;
}

export type CheckEvery = 1 | 2 | 5 | 15;

/** Settings › Automations. */
export interface AutomationsSettings { cap: number; whenFull: 'ask' | 'queue'; paused: boolean; keepAwake: boolean }

export const AUTOMATIONS_SETTINGS_DEFAULTS: AutomationsSettings = Object.freeze({ cap: 3, whenFull: 'ask', paused: false, keepAwake: false });

export const AUTOMATION_DEFAULTS: Readonly<Omit<Automation, 'id' | 'project' | 'source'>> = Object.freeze<Omit<Automation, 'id' | 'project' | 'source'>>({
  name: 'Automation',
  enabled: false,
  createdAt: 0,
  folder: '',
  conditions: [],
  claude: { account: 'default', model: 'default', mode: 'auto', decideAlone: false, useSourceMcp: false },
  isolation: { worktree: true, base: 'default' },
  instructions: '',
  limits: { concurrent: 2, perDay: 10, checkEveryMin: 2, usagePause: 80 },
  rerunWhenMatchesAgain: false
});

/**
 * The connector's watch read: the tasks, and whether that was all of them (false: more pages than a read takes, or a
 * database that couldn't be read). Only a whole read may say a queued task no longer matches.
 */
export interface WatchResult {
  tasks: WatchedTask[];
  complete: boolean;
  /** The names of the assignees and creators the read saw, for the editor's people chips. */
  people?: { id: string; name: string }[];
}

/** A listed task with the fields conditions read (the connector's watch read). */
export interface WatchedTask {
  id: string;
  /** The list (ClickUp) or data source (Notion) it was read from: one read serves every automation on the connector. */
  scope: string;
  displayId: string;
  title: string;
  url: string;
  status: string;
  /** User ids. */
  assignees: string[];
  /** Known only once read (ClickUp: get_task); a createdBy condition never matches without it. */
  creatorId?: string;
  tags: string[];
  priority?: string;
  due?: number;
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_CONDITIONS = 8;
export const MAX_INSTRUCTIONS = 8192;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const MODELS: readonly ClaudeModel[] = ['default', 'opus', 'sonnet', 'haiku'];
const MODES: readonly AutomationMode[] = ['plan', 'auto', 'acceptEdits', 'default'];
const CHECK_EVERY: readonly CheckEvery[] = [1, 2, 5, 15];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
const FIELDS: readonly ConditionField[] = ['status', 'assignee', 'createdBy', 'tag', 'priority', 'title', 'due'];

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const oneLine = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\t\r\n]+/g, ' ').replace(CONTROL, '').trim().slice(0, max) : '';
const int = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt;

/** A folder inside the project: relative, no empty, `.` or `..` segment, never `.git`, no control character. */
export function cleanFolder(v: unknown): string {
  if (typeof v !== 'string' || v === '' || v.length > 512 || /[\x00-\x1f\x7f-\x9f\\]/.test(v)) return '';
  const parts = v.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && p !== '.git') ? v : '';
}

/**
 * A Jira service-desk project feeds an automation only when Created by names people: its
 * requests are written by customers outside the company, and a request is text Claude reads. `serviceScopes`: the
 * automation's scopes that are service projects.
 */
export function serviceProjectBlocked(conditions: readonly Condition[], serviceScopes: readonly string[]): boolean {
  return serviceScopes.length > 0 && !conditions.some((c) => c.field === 'createdBy' && c.values.length > 0);
}

/** The fields a source's tasks carry; createdBy for Notion only with a creator column. */
export function conditionFields(connector: ConnectorId, notionCreator: boolean): ConditionField[] {
  // Jira: every field; Created by is the issue's `creator` (never its reporter).
  if (connector === 'clickup' || connector === 'jira') return [...FIELDS];
  // Notion: the database's own "Assigned to me / Everyone" setting governs assignees.
  return FIELDS.filter((f) => f === 'status' || f === 'title' || f === 'due' || (f === 'createdBy' && notionCreator));
}

function cleanCondition(raw: unknown, allowed: readonly ConditionField[]): Condition | null {
  const o = obj(raw);
  const field = o.field as ConditionField;
  if (!allowed.includes(field) || !Array.isArray(o.values)) return null;
  const rawLabels = Array.isArray(o.labels) && o.labels.length === o.values.length ? o.labels : null;
  const kept = o.values.map((v, i) => ({ value: oneLine(v, 100), label: rawLabels ? oneLine(rawLabels[i], 100) || '…' : '' }))
    .filter((x) => x.value).slice(0, 20);
  const values = kept.map((x) => x.value);
  if (values.length === 0) return null;
  if (field === 'priority' && !(PRIORITIES as readonly string[]).includes(values[0]!.toLowerCase())) return null;
  if (field === 'due' && !/^(?:[0-9]|[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-5])$/.test(values[0]!)) return null;
  if (field === 'priority' || field === 'title' || field === 'due') return { field, values: [values[0]!] };
  return { field, values, ...(rawLabels ? { labels: kept.map((x) => x.label) } : {}) };
}

function cleanBase(v: unknown): BaseRef {
  if (v === 'default' || v === 'current') return v;
  const branch = obj(v).branch;
  return typeof branch === 'string' && validBranchName(branch) ? { branch } : 'default';
}

/**
 * An automation from disk or the renderer, field by field: the core (id, project, source) must be valid, or null;
 * every other field falls back to its default when missing or wrong. Conditions on fields the source lacks are dropped.
 */
export function normalizeAutomation(raw: unknown): Automation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id) || !isCleanAbsPath(o.project)) return null;
  const src = obj(o.source);
  const connector = src.connector;
  if (connector !== 'clickup' && connector !== 'notion' && connector !== 'jira') return null;
  if (!Array.isArray(src.scopes) || src.scopes.length === 0 || src.scopes.length > 20 || !src.scopes.every((s) => typeof s === 'string' && ID.test(s))) return null;
  const d = AUTOMATION_DEFAULTS;
  const allowed = conditionFields(connector, true);
  const conditions = (Array.isArray(o.conditions) ? o.conditions : [])
    .map((c) => cleanCondition(c, allowed)).filter((c): c is Condition => c !== null).slice(0, MAX_CONDITIONS);
  const c = obj(o.claude);
  const iso = obj(o.isolation);
  const l = obj(o.limits);
  const usage = l.usagePause === null ? null : int(l.usagePause, 50, 95, d.limits.usagePause!);
  return {
    id: o.id,
    name: oneLine(o.name, 60) || d.name,
    enabled: o.enabled === true,
    createdAt: int(o.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
    project: o.project,
    folder: cleanFolder(o.folder),
    source: {
      connector, scopes: [...src.scopes] as string[],
      ...(Array.isArray(src.labels) && src.labels.length === src.scopes.length ? { labels: src.labels.map((l) => oneLine(l, 100) || '…') } : {})
    },
    conditions,
    claude: {
      account: typeof c.account === 'string' && ID.test(c.account) ? c.account : d.claude.account,
      model: MODELS.includes(c.model as ClaudeModel) ? c.model as ClaudeModel : d.claude.model,
      mode: MODES.includes(c.mode as AutomationMode) ? c.mode as AutomationMode : d.claude.mode,
      decideAlone: c.decideAlone === true,
      useSourceMcp: c.useSourceMcp === true
    },
    isolation: { worktree: iso.worktree !== false, base: cleanBase(iso.base ?? 'default') },
    instructions: typeof o.instructions === 'string' ? o.instructions.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, MAX_INSTRUCTIONS) : '',
    limits: {
      concurrent: int(l.concurrent, 1, 5, d.limits.concurrent),
      perDay: int(l.perDay, 1, 50, d.limits.perDay),
      checkEveryMin: CHECK_EVERY.includes(l.checkEveryMin as CheckEvery) ? l.checkEveryMin as CheckEvery : d.limits.checkEveryMin,
      usagePause: usage
    },
    rerunWhenMatchesAgain: o.rerunWhenMatchesAgain === true
  };
}

// ── Matching ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 3600_000;
const lower = (s: string) => s.toLowerCase();
const rank = (p: string | undefined) => (p ? (PRIORITIES as readonly string[]).indexOf(lower(p)) : -1);

function holds(t: WatchedTask, c: Condition, ctx: { me: string; now: number }): boolean {
  const ids = c.values.map((v) => (v === 'me' ? ctx.me : v));
  switch (c.field) {
    case 'status': return c.values.some((v) => lower(v) === lower(t.status));
    case 'assignee': return t.assignees.some((a) => ids.includes(a));
    case 'createdBy': return t.creatorId !== undefined && ids.includes(t.creatorId);
    case 'tag': return t.tags.some((g) => c.values.some((v) => lower(v) === lower(g)));
    case 'priority': { const have = rank(t.priority); return have >= 0 && have <= rank(c.values[0]); }
    case 'title': return lower(t.title).includes(lower(c.values[0] ?? ''));
    case 'due': return t.due !== undefined && t.due <= ctx.now + Number(c.values[0]) * DAY_MS;
  }
}

/** Every condition holds for the task. */
export function matches(t: WatchedTask, conditions: readonly Condition[], ctx: { me: string; now: number }): boolean {
  return conditions.every((c) => holds(t, c, ctx));
}

/** The runner must read the creator of a candidate before the last match (ClickUp lists don't carry it). */
export const needsCreator = (conditions: readonly Condition[]): boolean => conditions.some((c) => c.field === 'createdBy');

// ── The seen ledger ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Task id → when the source last reported it, whether it matched then, and whether it was ever handled (it matched
 * once: a run was made for it, or it was baselined when the automation was turned on).
 */
export type Ledger = Record<string, { at: number; matched: boolean; done: boolean }>;

export const MAX_LEDGER = 5000;
export const LEDGER_FORGET_MS = 30 * DAY_MS;

/**
 * The matching tasks that should run now: never handled (new, or seen before while they didn't match); with
 * rerunWhenMatchesAgain, also those handled before that the last poll saw not matching.
 */
export function newMatches<T extends { id: string }>(matching: readonly T[], ledger: Ledger, rerun: boolean): T[] {
  return matching.filter((t) => {
    const e = Object.hasOwn(ledger, t.id) ? ledger[t.id] : undefined;
    return !e || !e.done || (rerun && !e.matched);
  });
}

/**
 * The ledger after a poll: what the source reported (seen) and what matched — every match is handled by then (a run,
 * a baseline, a skip); old ids forgotten, at most 5000.
 */
export function ledgerAfterPoll(ledger: Ledger, poll: { seen: readonly string[]; matched: readonly string[] }, now: number): Ledger {
  const next: Ledger = {};
  for (const [id, e] of Object.entries(ledger)) if (now - e.at <= LEDGER_FORGET_MS) next[id] = e;
  const matched = new Set(poll.matched);
  for (const id of new Set([...poll.seen, ...poll.matched])) {
    const was = Object.hasOwn(next, id) ? next[id]!.done : false;
    next[id] = { at: now, matched: matched.has(id), done: was || matched.has(id) };
  }
  const ids = Object.keys(next);
  if (ids.length <= MAX_LEDGER) return next;
  ids.sort((a, b) => next[a]!.at - next[b]!.at);
  for (const id of ids.slice(0, ids.length - MAX_LEDGER)) delete next[id];
  return next;
}

// ── Starting ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CapInput {
  /** This automation's runs starting or working. */
  perAutomationActive: number;
  /** Every automation's runs starting or working. */
  globalActive: number;
  /** This automation's runs started today (local day). */
  todayCount: number;
  /** The account's 5h usage, null when unknown. */
  usagePercent: number | null;
  /** The user asked for this one (Start, Start Now, Start Anyway). */
  manual: boolean;
}

export type QueueReason = 'perDay' | 'usage' | 'perAutomation' | 'global';
export type Decision = { kind: 'start' } | { kind: 'queued'; reason: QueueReason } | { kind: 'held'; reason: 'global' };

/**
 * Start now, wait in line (starts by itself later) or hold for the user. The day's count first, then
 * usage, then the automation's own limit, then the global cap. A start the user asked for always starts.
 */
export function decide(a: Automation, s: AutomationsSettings, i: CapInput): Decision {
  if (i.manual) return { kind: 'start' };
  if (i.todayCount >= a.limits.perDay) return { kind: 'queued', reason: 'perDay' };
  if (a.limits.usagePause !== null && i.usagePercent !== null && i.usagePercent >= a.limits.usagePause) return { kind: 'queued', reason: 'usage' };
  if (i.perAutomationActive >= a.limits.concurrent) return { kind: 'queued', reason: 'perAutomation' };
  if (i.globalActive >= s.cap) return s.whenFull === 'ask' ? { kind: 'held', reason: 'global' } : { kind: 'queued', reason: 'global' };
  return { kind: 'start' };
}

// ── What the windows see ────────────────────────────────────────────────────────────────────────────────────────

export interface AutomationStatus {
  kind: 'on' | 'off' | 'paused';
  /** Why it is paused ("ClickUp signed you out", "All automations are paused"). */
  reason?: string;
  lastPollAt: number | null;
  nextPollAt: number | null;
}

/** The editor's live column: what matches now, and what a condition leaves out (with why). */
export interface AutomationPreview {
  matching: WatchedTask[];
  /** All the matching tasks, the list being capped. */
  count: number;
  leftOut: { task: WatchedTask; reason: string }[];
  /** The source couldn't be read: one line. */
  error?: string;
  /** What the condition chips suggest, from the same read; absent when it failed. */
  values?: ConditionValues;
}

// ── Suggestions ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A status or tag the chips offer; `count`: the open tasks that have it now (0: only defined by the source). */
export interface ValueOption { name: string; color?: string; count: number }
export interface PersonOption { id: string; name: string; count: number }
export interface ConditionValues { status: ValueOption[]; tag: ValueOption[]; people: PersonOption[] }

const MAX_STATUS_VALUES = 100;
const MAX_TAG_VALUES = 200;
const MAX_PEOPLE_VALUES = 200;

const byUse = <T extends { name: string; count: number }>(a: T, b: T) => b.count - a.count || a.name.localeCompare(b.name);

/**
 * The chips' suggestions: statuses, tags and people counted over every task read for the scopes
 * (before conditions, so they don't shrink as conditions are added), most used first. Names compare as matching does
 * (case-insensitive; the first spelling seen wins). `defined`: the statuses the source defines (ClickUp's lists,
 * Notion's column), after the used ones with 0 unless a task has them. People only with a name from the read.
 */
export function conditionValues(tasks: readonly WatchedTask[], people: readonly { id: string; name: string }[], defined: readonly { name: string; color?: string }[]): ConditionValues {
  const count = (names: Iterable<string>, into: Map<string, ValueOption>) => {
    for (const name of names) {
      if (!name) continue;
      const k = lower(name);
      const e = into.get(k);
      if (e) e.count++;
      else into.set(k, { name, count: 1 });
    }
  };
  const status = new Map<string, ValueOption>();
  count(tasks.map((t) => t.status), status);
  for (const d of defined) {
    if (!d.name) continue;
    const e = status.get(lower(d.name));
    if (!e) status.set(lower(d.name), { name: d.name, ...(d.color ? { color: d.color } : {}), count: 0 });
    else if (d.color && !e.color) e.color = d.color;
  }
  const tag = new Map<string, ValueOption>();
  for (const t of tasks) count(dedupe(t.tags), tag);
  const names = new Map(people.filter((p) => p.name).map((p) => [p.id, p.name] as const));
  const seen = new Map<string, PersonOption>();
  for (const t of tasks) {
    for (const id of new Set([...t.assignees, ...(t.creatorId !== undefined ? [t.creatorId] : [])])) {
      const name = names.get(id);
      if (!name) continue;
      const e = seen.get(id);
      if (e) e.count++;
      else seen.set(id, { id, name, count: 1 });
    }
  }
  return {
    status: [...status.values()].sort(byUse).slice(0, MAX_STATUS_VALUES),
    tag: [...tag.values()].sort(byUse).slice(0, MAX_TAG_VALUES),
    people: [...seen.values()].sort(byUse).slice(0, MAX_PEOPLE_VALUES)
  };
}

/** The names once each, case-insensitively, first spelling kept. */
function dedupe(names: readonly string[]): string[] {
  const keys = new Set<string>();
  return names.filter((n) => { const k = lower(n); if (keys.has(k)) return false; keys.add(k); return true; });
}

/**
 * Turning on asks again when the automation is new or got wider: its source, conditions, mode or account,
 * or the worktree turned off. A new name, instructions or limits don't. Main turns a widened one off until then.
 */
export function needsConsent(prev: Automation | null, next: Automation): boolean {
  if (!prev) return true;
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const decides = (cs: readonly Condition[]) => cs.map((c) => [c.field, c.values]);
  return !same(prev.source.scopes, next.source.scopes) || prev.source.connector !== next.source.connector || !same(decides(prev.conditions), decides(next.conditions))
    || prev.claude.mode !== next.claude.mode || prev.claude.account !== next.claude.account || (prev.isolation.worktree && !next.isolation.worktree);
}

/** The first read after a gap longer than twice the interval: its new matches are offered, not started. */
export function isCatchUp(lastPollAt: number | null, now: number, intervalMs: number): boolean {
  return lastPollAt !== null && now - lastPollAt > 2 * intervalMs;
}

// ── Names ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const SLUG_MAX = 24;

/** ASCII, lower-case, words joined by dashes, at most 24 characters; 'task' when nothing is left. */
export function slug(text: string, max = SLUG_MAX): string {
  const ascii = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let out = words.slice(0, max).replace(/-+$/, '');
  // Cut at the last whole word when the cut fell inside one.
  if (words.length > max && words[max] !== '-' && out.includes('-')) out = out.slice(0, out.lastIndexOf('-'));
  return out || 'task';
}

/** The names a run's branch may take, in order: `auto/<id>-<slug>` (or `auto/<slug>` without an id), then `-2`…`-9`. */
export function branchCandidates(displayId: string, title: string): string[] {
  const id = slug(displayId, SLUG_MAX);
  const head = `auto/${displayId.trim() && id !== 'task' ? `${id}-` : ''}${slug(title)}`;
  return Array.from({ length: 9 }, (_, i) => (i === 0 ? head : `${head}-${i + 1}`)).filter(validBranchName);
}

/** The first candidate not taken; null when all are. */
export function runBranch(displayId: string, title: string, taken: (branch: string) => boolean): string | null {
  return branchCandidates(displayId, title).find((b) => !taken(b)) ?? null;
}

/** At most `max` characters of a dash-separated name, cut after a whole word when the cut falls inside one. */
function cutName(s: string, max: number): string {
  if (s.length <= max) return s;
  const out = s.slice(0, max).replace(/-+$/, '');
  return s[max] !== '-' && out.includes('-') ? out.slice(0, out.lastIndexOf('-')) : out;
}

/**
 * The run's worktree: `.claude/worktrees/<branch with "/" as "-">` in the project. Windows: `auto-` and at
 * most 20 characters of the rest, a collision's `-N` kept, so a project's path plus node_modules stays short.
 */
export function worktreeDir(root: string, branch: string, style: PathStyle = pathStyle()): string {
  const base = `${root.replace(/\/+$/, '')}/.claude/worktrees/`;
  if (style !== 'win32') return base + branch.replace(/\//g, '-');
  const rest = branch.replace(/^auto\//, '').replace(/\//g, '-');
  const n = /^(.+)-([2-9])$/.exec(rest);
  return `${base}auto-${rest.length <= 20 ? rest : n ? `${cutName(n[1]!, 18)}-${n[2]}` : cutName(rest, 20)}`;
}
