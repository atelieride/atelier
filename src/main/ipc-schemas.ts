import { z } from 'zod';
import { ITEM_ID } from '@shared/background-files';
import { SETTINGS_FIELDS, isDockerEngineSetting, isSettingPath, isSettingText, type Field } from '@shared/settings';
import { isFontFamily } from '@shared/terminal-font';
import { normalizeCustom } from '@shared/redis';
import {
  DB_FILTER_OPS, DERIVED_MAX, FILTER_VALUE_MAX, FILTER_VALUES_MAX, FILTERS_MAX, PATH_INDEX_MAX, PATH_KEY_MAX, PATH_KEYS_MAX, validFilterShape, type DbFilterOp
} from '@shared/databases-filters';
import { ACCOUNT_ID, MAX_ACCOUNTS, MAX_DISMISSED, normalizeAccounts } from '@shared/claude-accounts';
import { MAX_FLAGS, MAX_TOKEN, MAX_TOKENS, normalizeFlags } from '@shared/claude-flags';
import { PROFILE_PATH_MAX } from '@shared/profiles';
import { SESSION_ID } from '@shared/history';
import { isCleanAbsPath } from '@shared/clean-path';
import { COMPANION_QUESTION_MAX } from '@shared/companion/types';
import { cleanName } from '@shared/shell';
import { RENDERER_ERROR_MAX } from '@shared/api';
import { CONNECTOR_IDS, type ConnectorId } from '@shared/tasks';
import { MAX_SAVED_SHELF, MAX_SAVED_TABS } from '@shared/tabs-state';
import { FILTER_MAX, HISTORY_CAP, HISTORY_PAGE } from '@shared/scm';
import { MAX_LINE, MAX_PATTERN, MAX_TRIGGERS, TRIGGER_ACTIONS, TRIGGER_ID, TRIGGER_SCOPES, checkPattern, type TriggerAction, type TriggerScope } from '@shared/triggers';
import { popoutKind } from '@shared/popout';
import { MENU_SPEC, menuItems } from '@shared/menu-spec';
import { absPathSchema, filePathKeySchema, gitRelSchema, safeRelSchema } from './path-schemas';
import { DB_CONN_ID, dbConnectionFields, hasEndpoint, sshOverTcp, sshTarget } from './databases/connection-schema';
import { DB_SLOT_MAX } from '@shared/databases';
import { scheduleAddFields, scheduleUpdateFields } from '@shared/scheduled-prompts';
import { THEME_IDS, type ThemeId } from '@shared/themes';
import { SEARCH_LIMITS } from '@shared/search';

export const idSchema = z.string().min(1).max(64);
/** Terminals stopped together (Close Workspace's Stop). */
export const termStopSchema = z.array(idSchema).min(1).max(200);
/** A renderer error for the app log (src/main/app-log.ts). */
export const rendererErrorSchema = z.object({
  kind: z.enum(['error', 'rejection', 'boundary']),
  message: z.string().max(RENDERER_ERROR_MAX.message),
  stack: z.string().max(RENDERER_ERROR_MAX.stack).optional(),
  panel: z.string().max(RENDERER_ERROR_MAX.panel).optional()
}).strict();
/** A window's state for the application menu (src/main/menu-state.ts). */
export const menuStateSchema = z.object({
  gitUndo: z.boolean(), hasRepos: z.boolean(), gitWrites: z.boolean(), messages: z.boolean(),
  workspaces: z.object({ names: z.array(z.string().min(1).max(60)).max(20), active: z.number().int().min(0).max(19) }).strict().optional(),
  project: z.boolean().optional()
}).strict();
/** A terminal profile from the renderer: 'atelier', 'user' or a shell path (main checks it against /etc/shells). */
export const profileKeySchema = z.union([z.literal('atelier'), z.literal('user'), absPathSchema(2, PROFILE_PATH_MAX)]);
const dim = z.number().int().min(2).max(1000);
export const termCreateSchema = z.object({
  cwd: absPathSchema(0, 4096).optional(),
  cols: dim, rows: dim,
  name: z.string().max(200).optional(),
  command: z.string().max(10000).optional(),
  profile: profileKeySchema.optional()
}).strict();
export const termInputSchema = z.object({ id: idSchema, data: z.string().max(1024 * 1024) }).strict();
export const termResizeSchema = z.object({ id: idSchema, cols: dim, rows: dim }).strict();
export const termResumeSchema = z.object({ id: idSchema, cols: dim, rows: dim }).strict();
/** Scheduled prompts: the same fields atelierd checks; a restored prompt is checked there. */
export const scheduleAddSchema = z.object(scheduleAddFields).strict();
export const scheduleUpdateSchema = z.object(scheduleUpdateFields).strict();
export const scheduleIdSchema = z.object({ id: idSchema }).strict();
export const scheduleRestoreSchema = z.object({ prompt: z.object({ id: idSchema, projectRoot: z.string().max(4096) }).passthrough() }).strict();
export const scheduleFireSchema = z.object({ id: idSchema, force: z.literal('usage').optional() }).strict();
export const scheduleSnoozeSchema = z.object({ id: idSchema, minutes: z.number().int().min(1).max(1440) }).strict();
/** The user settles unsure files: one of their candidates, or null for outside Claude. */
export const attributionResolveSchema = z.object({
  paths: z.array(absPathSchema(2, 4096)).min(1).max(200),
  terminalId: idSchema.nullable()
}).strict();
export const attributionUndoSchema = z.object({ token: z.string().min(1).max(32) }).strict();
/** A conversation from Claude's history: only its id; where it runs comes from the main process's own reading. */
/** account: the Claude account the conversation belongs to (absent: the default one), by id only. */
export const claudeResumeSchema = z.object({ sessionId: z.string().regex(SESSION_ID), cols: dim, rows: dim, account: z.string().regex(ACCOUNT_ID).optional() }).strict();
/** A name typed by hand: control characters never reach titles (nor the shell); nothing left means no name. */
const typedName = z.string().max(200).transform((s) => cleanName(s));
export const termRenameSchema = z.object({ id: idSchema, name: typedName.nullable().transform((s) => s || null) }).strict();
// The renderer only chooses the name and the folder: the session command is built by the main process.
/** Settings › Claude › Launch flags' preview: an account by id, a sample name. */
export const claudeLaunchPreviewSchema = z.object({ account: z.string().regex(ACCOUNT_ID).optional(), name: typedName }).strict();

/**
 * account: a Claude account's id; main resolves it, the renderer never sends a dir. noFlags:
 * New Session's ⌥↵ starts without launch flags; the flags themselves are main's, from Settings.
 */
export const termCreateSessionSchema = z.object({ cols: dim, rows: dim, name: typedName.optional(), cwd: absPathSchema(0, 4096).optional(), account: z.string().regex(ACCOUNT_ID).optional(), noFlags: z.literal(true).optional() }).strict();

const abs = absPathSchema(1, 4096);
export const filesListSchema = z.object({ dir: abs, showHidden: z.boolean() }).strict();
export const filesReadSchema = abs;
export const filesResolveSchema = z.object({ candidate: z.string().min(1).max(1024), cwd: abs }).strict();
/** A file or folder path in Claude's temp folder, from a terminal link. */
export const filesClaudeTempSchema = abs;
/**
 * Any file path a terminal link names, absolute or under the home folder, canonical (`C:/…`, `~/…`); main checks the
 * rest.
 */
export const filesOutsideSchema = z.string().min(1).max(4096).refine((p) => abs.safeParse(p).success || p.startsWith('~/'), 'path');
export const urlSchema = z.string().min(1).max(8192);
/** The id a page gives each of its Find in Files searches: a whole number it counts up from 0. */
export const searchIdSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A Find in Files search: what the editor's find card has, the path filters and whether ignored files count. */
export const searchStartSchema = z.object({
  searchId: searchIdSchema,
  query: z.string().max(SEARCH_LIMITS.queryMax),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
  regex: z.boolean(),
  include: z.string().max(SEARCH_LIMITS.globMax),
  exclude: z.string().max(SEARCH_LIMITS.globMax),
  includeIgnored: z.boolean(),
  unsaved: z.array(absPathSchema(1, 4096)).max(500)
}).strict();
/** A page's answer to main's question: which one, and the answer's word. */
export const askAnswerSchema = z.object({ id: z.string().min(1).max(32), answer: z.string().min(1).max(16) }).strict();
export const askShownSchema = z.object({ id: z.string().min(1).max(32) }).strict();
/** Whether a window has unsaved files (Windows: a session end waits for them). */
export const unsavedStateSchema = z.boolean();
/** Review: a file's base side, at HEAD or at the merge base main computed (a full commit id). */
export const gitBaseSchema = z.object({ path: abs, rev: z.union([z.literal('HEAD'), z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)]) }).strict();

/**
 * Source Control: roots main listed (checked by ScmHub), full commit ids, full refnames
 * (checked against main's last refs read), a bounded filter, repo-relative paths. Never a free-form git argument.
 */
const oidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const refnameSchema = z.string().min(1).max(250).regex(/^(?:HEAD|(?!.*\.\.)(?!.*@\{)refs\/(?:heads|remotes|tags)\/[^\0\s~^:?*[\\]+)$/);
const revSchema = z.union([oidSchema, refnameSchema]);
const viewSchema = z.string().max(40).optional();
export const scmScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refs'), refs: z.union([z.literal('all'), refnameSchema]), firstParent: z.boolean() }).strict(),
  z.object({ kind: z.literal('compare'), base: revSchema, head: revSchema }).strict()
]);
export const scmRootSchema = z.object({ root: abs }).strict();
/** git:facts — `view`: asked by a view of many repositories, which waits for a read slot. */
export const gitFactsSchema = z.object({ root: abs, view: z.literal(true).optional() }).strict();
/** A listed root and why; the argv itself is fixed in git/fetch.ts. */
export const scmFetchSchema = z.object({ root: abs, reason: z.enum(['view', 'manual']) }).strict();
export const scmLogSchema = z.object({
  root: abs, scope: scmScopeSchema, skip: z.number().int().min(0).max(HISTORY_CAP), count: z.number().int().min(1).max(HISTORY_PAGE * 10),
  filter: z.string().max(FILTER_MAX).refine((s) => !s.includes('\0'), 'nul').optional(), view: viewSchema
}).strict();
export const scmLocateSchema = z.object({ root: abs, scope: scmScopeSchema, oid: oidSchema, view: viewSchema }).strict();
export const scmResolveSchema = z.object({ root: abs, prefix: z.string().regex(/^[0-9a-f]{4,40}$/) }).strict();
export const scmCommitSchema = z.object({ root: abs, oid: oidSchema, against: oidSchema.nullable().optional(), view: viewSchema }).strict();
export const scmFileSchema = z.object({ root: abs, oid: oidSchema, rel: gitRelSchema(4096) }).strict();
export const scmAheadBehindSchema = z.object({ root: abs, a: revSchema, b: revSchema }).strict();

/*
 * Git writes: shapes only. GitOps checks the rest against main's own reads before any git call:
 * the root among the project's listed entries, each path in that root's last status, each refname in its last refs
 * read, a new name through check-ref-format, a stash's index and oid in the current list, a lease oid main showed.
 */
const relSchema = safeRelSchema(4096);
const relsSchema = z.union([z.literal('all'), z.array(relSchema).min(1).max(100_000)]);
/** A ref the renderer got from scm:refs: full names of branches, remote branches and tags only. */
const writeRefSchema = z.string().min(1).max(250).regex(/^(?!.*\.\.)(?!.*@\{)refs\/(?:heads|remotes|tags)\/[^\0\s~^:?*[\\]+$/);
const branchNameSchema = z.string().min(1).max(255).refine((s) => !s.includes('\0'), 'nul');
const commitMessageSchema = z.string().max(64 * 1024).refine((s) => !s.includes('\0') && Buffer.byteLength(s) <= 64 * 1024, 'message');
const stashMessageSchema = z.string().min(1).max(1024).refine((s) => !/[\0\r\n]/.test(s), 'one line');
export const gitPathsSchema = z.object({ root: abs, rels: relsSchema }).strict();
export const gitCommitSchema = z.object({
  root: abs, message: commitMessageSchema, amend: z.boolean(), coAuthor: z.boolean(), noVerify: z.boolean(), expectHead: oidSchema.optional()
}).strict();
/** Sync All: the listed roots to leave out (their incoming changes touch files live sessions are changing). */
export const gitSyncAllSchema = z.object({ skip: z.array(abs).max(1000) }).strict().optional();
export const gitUndoCommitSchema = z.object({ root: abs, oid: oidSchema }).strict();
export const gitPushSchema = z.object({
  root: abs, publish: z.object({ remote: z.string().min(1).max(100) }).strict().optional(), lease: z.object({ oid: oidSchema }).strict().optional()
}).strict();
export const gitPullSchema = z.object({ root: abs, rebase: z.boolean(), stash: z.literal(true).optional() }).strict();
export const gitSyncSchema = z.object({ root: abs, rebase: z.boolean() }).strict();
export const gitSwitchSchema = z.object({ root: abs, ref: writeRefSchema, carry: z.enum(['none', 'stash', 'bring']) }).strict();
export const gitCheckBranchNameSchema = z.object({ root: abs, name: branchNameSchema, same: branchNameSchema.optional() }).strict();
export const gitBranchCreateSchema = z.object({ root: abs, name: branchNameSchema, from: writeRefSchema.optional(), switch: z.boolean() }).strict();
export const gitBranchRenameSchema = z.object({ root: abs, ref: writeRefSchema, name: branchNameSchema }).strict();
export const gitBranchDeleteSchema = z.object({ root: abs, ref: writeRefSchema, force: z.boolean() }).strict();
export const gitBranchRestoreSchema = z.object({ root: abs, name: branchNameSchema, oid: oidSchema }).strict();
export const gitWorktreeCheckSchema = z.object({ root: abs, path: abs }).strict();
export const gitWorktreeAddSchema = z.object({ root: abs, path: abs, ref: writeRefSchema.optional(), newName: branchNameSchema.optional() }).strict()
  .refine((o) => o.ref !== undefined || o.newName !== undefined, 'ref or newName');
export const gitStashPushSchema = z.object({ root: abs, message: stashMessageSchema, untracked: z.boolean(), staged: z.boolean() }).strict();
const stashIndexSchema = z.number().int().min(0).max(999);
export const gitStashApplySchema = z.object({ root: abs, index: stashIndexSchema, oid: oidSchema, pop: z.boolean() }).strict();
export const gitStashDropSchema = z.object({ root: abs, index: stashIndexSchema, oid: oidSchema }).strict();
export const gitStashRestoreSchema = z.object({ root: abs, oid: oidSchema, message: stashMessageSchema }).strict();
export const gitIdSchema = z.object({ id: idSchema }).strict();
export const gitRemoteCommitsSchema = z.object({ root: abs, n: z.number().int().min(1).max(20) }).strict();
export const scmMessageSchema = z.object({
  root: abs, tweak: z.object({ kind: z.enum(['shorter', 'detail', 'subject']), current: commitMessageSchema }).strict().optional()
}).strict();

/**
 * Ask companion: the session a panel is bound to. The cwd picks its transcript: a clean
 * absolute path, checked again against the sender's project (companion/ipc.ts). configDir is kept for the shape the
 * renderer holds, but main replaces it with its terminal's configured account's dir (null for any other).
 */
const cleanAbs = abs.refine(isCleanAbsPath, 'path');
const sessionIdSchema = z.string().regex(SESSION_ID);
export const bindingSchema = z.object({
  terminalId: idSchema,
  sessionId: sessionIdSchema,
  cwd: cleanAbs,
  configDir: cleanAbs.nullable(),
  title: z.string().max(1000)
}).strict();
/** The thread's pickers. account: 'session' (the session's own) or an account's id, as Settings › Ask takes it; main maps it to a dir. */
const companionPick = {
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
  account: z.union([z.literal('session'), z.string().regex(ACCOUNT_ID)]).optional()
};
export const companionAskSchema = z.object({ binding: bindingSchema, text: z.string().min(1).max(COMPANION_QUESTION_MAX), ...companionPick }).strict();
export const companionCatchUpSchema = z.object({ binding: bindingSchema, final: z.boolean(), ...companionPick }).strict();
export const companionSessionSchema = z.object({ sessionId: sessionIdSchema }).strict();

/** A port chip click: which terminal and port; main opens it only if it lists that port now. */
export const portsOpenSchema = z.object({ id: idSchema, port: z.number().int().min(1).max(65535) }).strict();

/**
 * Session panel: the session's folder only. Main checks it is in the window's project, and the config
 * roots come from main's own environment, never from the renderer.
 */
/** terminalId: the session's terminal, whose Claude account main maps. */
export const claudeConfigSchema = z.object({ cwd: abs, terminalId: idSchema.optional() }).strict();
/**
 * Context usage: which terminal (main finds its session, folder and account); a path
 * to open, which main opens only when that terminal's last report listed it.
 */
export const claudeContextSchema = z.object({ terminalId: idSchema }).strict();
export const claudeContextOpenSchema = z.object({ terminalId: idSchema, path: abs }).strict();
/** Restart Session: which session; main builds the command from its own settings. */
export const claudeRestartSchema = z.object({ terminalId: idSchema, sessionId: z.string().regex(SESSION_ID) }).strict();

/** A PR chip click: which repo and branch, and whether its checks page; main opens only the URL gh gave it. */
export const prOpenSchema = z.object({ root: abs, branch: z.string().min(1).max(200), checks: z.boolean() }).strict();

/** Connectors: which connector; no URL, token or tool name ever comes from the renderer. */
export const connectorIdSchema = z.enum(CONNECTOR_IDS as [ConnectorId, ...ConnectorId[]]);
export const connectorRefSchema = z.object({ id: connectorIdSchema }).strict();
/** Only "Include closed tasks" (the workspace is display-only in v2.2). */
export const connectorOptionsSchema = z.object({ id: connectorIdSchema, options: z.object({ includeClosed: z.boolean().optional() }).strict() }).strict();
/** A task by its source's id (ClickUp's ids: [A-Za-z0-9_-]{1,64}); main holds the URL it opens. */
export const taskRefSchema = z.object({ source: connectorIdSchema, id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict();
export const taskSearchSchema = z.object({ source: connectorIdSchema, query: z.string().min(1).max(200) }).strict();
/**
 * Sources: a Notion data source id is dashless hex, a Jira project id digits;
 * property names are one clean line.
 */
export const sourceIdSchema = z.string().regex(/^(?:[0-9a-f]{32}|[1-9][0-9]{0,17})$/);
/**
 * A column (≤ 100) or option (≤ 200) name Atelier can send back to Notion: no control, bidi control or line/paragraph
 * separator (the rule of notion/fields.ts `usableName`; a zero-width joiner stays allowed). Escapes only, never raw.
 */
const SENDABLE_NAME = new RegExp('^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+$');
const propNameSchema = z.string().min(1).max(100).regex(SENDABLE_NAME);
const optionNameSchema = z.string().min(1).max(200).regex(SENDABLE_NAME);
/** = `NotionFields` (shared/tasks.ts). */
export const notionFieldsSchema = z.object({
  title: propNameSchema,
  status: z.object({ prop: propNameSchema, kind: z.enum(['status', 'select']), closed: z.array(optionNameSchema).max(50) }).strict().optional(),
  assignee: z.object({ prop: propNameSchema, mine: z.boolean() }).strict().optional(),
  due: propNameSchema.optional(),
  id: propNameSchema.optional()
}).strict();
/** Jira's picker lists the first projects for an empty query; the others need text. */
export const sourceSearchSchema = z.object({ id: connectorIdSchema, query: z.string().max(200) }).strict()
  .refine((x) => x.query.length > 0 || x.id === 'jira', { message: 'empty query' });
export const sourceAddSchema = z.object({ id: connectorIdSchema, ref: z.string().min(1).max(400) }).strict();
export const sourceRefSchema = z.object({ id: connectorIdSchema, sourceId: sourceIdSchema }).strict();
export const sourceFieldsSchema = z.object({ id: connectorIdSchema, sourceId: sourceIdSchema, fields: notionFieldsSchema }).strict();
/** Jira. */
export const sourceScopeSchema = z.object({ id: connectorIdSchema, sourceId: sourceIdSchema, everyone: z.boolean() }).strict();
export const filterSetSchema = z.object({ id: connectorIdSchema, filterId: z.string().regex(/^[1-9][0-9]{0,17}$/).nullable() }).strict();
/**
 * The API-token sign-in: an e-mail-shaped user (no `:`, it would split the Basic credentials), the token (printable
 * ASCII), and the site as typed (main validates it as a Jira Cloud site).
 */
export const tokenConnectSchema = z.object({
  id: connectorIdSchema,
  user: z.string().regex(/^[\x21-\x39\x3b-\x7e]{1,64}@[\x21-\x39\x3b-\x7e]{1,189}$/),
  secret: z.string().regex(/^[\x21-\x7e]{16,512}$/),
  site: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/).optional()
}).strict();
/** connectors:list and tasks:list take nothing. */
export const noArgsSchema = z.undefined();

// Automations: the shape is strict here, every value bounded; main then validates the values
// field by field (normalizeAutomation), and a new automation must be the sender's project.
const plainId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const automationConditionSchema = z.object({
  field: z.enum(['status', 'assignee', 'createdBy', 'tag', 'priority', 'title', 'due']),
  values: z.array(z.string().max(100)).max(20),
  labels: z.array(z.string().max(100)).max(20).optional()
}).strict();
const automationSchema = z.object({
  id: plainId,
  name: z.string().max(200),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  project: z.string().min(1).max(4096),
  folder: z.string().max(512),
  source: z.object({ connector: connectorIdSchema, scopes: z.array(plainId).min(1).max(20), labels: z.array(z.string().max(200)).max(20).optional() }).strict(),
  conditions: z.array(automationConditionSchema).max(8),
  claude: z.object({
    account: plainId, model: z.enum(['default', 'opus', 'sonnet', 'haiku']), mode: z.enum(['plan', 'auto', 'acceptEdits', 'default']),
    decideAlone: z.boolean(), useSourceMcp: z.boolean()
  }).strict(),
  isolation: z.object({ worktree: z.boolean(), base: z.union([z.enum(['default', 'current']), z.object({ branch: z.string().min(1).max(255) }).strict()]) }).strict(),
  instructions: z.string().max(8192),
  limits: z.object({
    concurrent: z.number().int().min(1).max(5), perDay: z.number().int().min(1).max(50),
    checkEveryMin: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(15)]), usagePause: z.number().int().min(50).max(95).nullable()
  }).strict(),
  rerunWhenMatchesAgain: z.boolean()
}).strict();
export const automationSaveSchema = z.object({ automation: automationSchema }).strict();
export const automationRefSchema = z.object({ id: plainId }).strict();
export const automationTurnOnSchema = z.object({ id: plainId, startMatching: z.boolean() }).strict();
export const automationCatchUpSchema = z.object({ id: plainId, action: z.enum(['start', 'skip']) }).strict();
export const automationPausedSchema = z.object({ paused: z.boolean() }).strict();
export const runRefSchema = z.object({ runId: plainId }).strict();
export const runCloseSchema = z.object({ runId: plainId, removeWorktree: z.boolean() }).strict();
export const automationSourceMcpSchema = z.object({ id: connectorIdSchema, account: plainId, automation: plainId.optional() }).strict();

export const paneIdSchema = z.string().regex(/^%\d+$/);
export const servicesWatchSchema = z.array(paneIdSchema).max(64);
/** Docker view: a container id (hex, as the engine gives it) and lists of them. */
export const containerIdSchema = z.string().regex(/^[0-9a-f]{12,64}$/);
export const containerIdsSchema = z.array(containerIdSchema).max(64);
export const dockerTailSchema = z.object({ id: containerIdSchema, n: z.number().int().min(1).max(500) }).strict();

// Redis view: keys in their wire form (UTF-8, or the base64 marker for bytes), bounded; a queue by
// its id only (main looks it up among what it detected); an instance by its endpoint key.
const redisKey = z.string().min(1).max(4096);
const redisDb = z.number().int().min(0).max(255);
const redisValueText = z.string().max(8 * 1024 * 1024);
const queueIdSchema = z.string().min(3).max(600);
const jobStateSchema = z.enum(['waiting', 'active', 'delayed', 'failed']);
export const redisInstanceKeySchema = z.string().regex(/^(tcp:\d{1,5}|unix:\/[^\u0000]{1,1023})$/);
export const redisWatchSchema = z.object({ db: redisDb, sidebar: z.boolean(), queues: z.boolean(), overview: z.boolean(), live: z.boolean() }).strict();
export const redisAuthSchema = z.object({ key: redisInstanceKeySchema, user: z.string().min(1).max(256).optional(), password: z.string().min(1).max(1024).optional(), useEnv: z.boolean().optional() }).strict();
export const redisScanSchema = z.object({ db: redisDb, match: z.string().min(1).max(1024), cursor: z.string().regex(/^\d{1,20}$/) }).strict();
export const redisValueSchema = z.object({ db: redisDb, key: redisKey, page: z.object({ cursor: z.string().max(64).optional(), start: z.number().int().min(0).max(1e9).optional() }).strict() }).strict();
export const redisCounterSchema = z.object({ db: redisDb, key: redisKey }).strict();
export const redisJobsSchema = z.object({ db: redisDb, queue: queueIdSchema, state: jobStateSchema, start: z.number().int().min(0).max(1e7), count: z.number().int().min(1).max(100) }).strict();
export const redisJobSchema = z.object({ db: redisDb, queue: queueIdSchema, state: jobStateSchema, id: z.string().min(1).max(256) }).strict();
export const redisPreviewSchema = z.object({ db: redisDb, pattern: z.string().min(1).max(1024), instance: redisInstanceKeySchema }).strict();
export const redisQueueIdSchema = queueIdSchema;
export const redisUndoSchema = z.string().uuid();
const queueOnly = z.object({ id: queueIdSchema }).strict();
const isJson = (v: string) => { try { JSON.parse(v); return true; } catch { return false; } };
export const redisWriteSchema = z.object({
  db: redisDb,
  instance: redisInstanceKeySchema,
  op: z.discriminatedUnion('op', [
    z.object({ op: z.literal('delete'), keys: z.array(redisKey).min(1).max(100) }).strict(),
    z.object({ op: z.literal('deleteMatching'), pattern: z.string().min(1).max(1024) }).strict(),
    z.object({ op: z.literal('ttl'), key: redisKey, ms: z.number().int().min(1).max(10 * 365 * 86_400_000).nullable() }).strict(),
    z.object({ op: z.literal('setString'), key: redisKey, value: redisValueText }).strict(),
    z.object({ op: z.literal('hset'), key: redisKey, field: z.string().min(1).max(65_536), value: redisValueText }).strict(),
    z.object({ op: z.literal('lset'), key: redisKey, index: z.number().int().min(-1e9).max(1e9), value: redisValueText }).strict(),
    z.object({ op: z.literal('zscore'), key: redisKey, member: z.string().min(1).max(65_536), score: z.number().finite() }).strict(),
    z.object({ op: z.literal('jsonSet'), key: redisKey, value: redisValueText.refine(isJson, 'json') }).strict(),
    z.object({ op: z.literal('flushdb') }).strict(),
    z.object({ op: z.literal('retry'), queue: queueOnly, id: z.string().min(1).max(256) }).strict(),
    z.object({ op: z.literal('remove'), queue: queueOnly, id: z.string().min(1).max(256) }).strict()
  ])
}).strict();

// Databases view: connections by id (the hub checks the window's project can see it),
// names as the catalog spells them (resolved against it in main before any statement: queries.ts), every list and text
// bounded. No identifier holds a NUL (the column cache keys a table by schema + '\0' + name), nor does a value (Postgres
// text can't hold one).
const noNul = (s: string) => !s.includes('\0');
const dbIdent = z.string().min(1).max(128).refine(noNul, 'nul');
/** A JSON path: keys and whole array indexes (int4, as `#>` takes them). */
const dbPath = z.array(z.union([z.string().max(PATH_KEY_MAX).refine(noNul, 'nul'), z.number().int().min(0).max(PATH_INDEX_MAX)])).max(PATH_KEYS_MAX);
const dbValue = z.string().max(FILTER_VALUE_MAX).refine(noNul, 'nul');
const DB_LIST = { columns: 200, filters: FILTERS_MAX, sorts: 10, derived: DERIVED_MAX } as const;
/** The tab a page, estimate or count is for (a newer one for it drops one not started yet); its key, ≤ 300. */
const dbSlot = z.string().min(1).max(DB_SLOT_MAX).refine(noNul, 'nul');
export const dbIdSchema = z.string().regex(DB_CONN_ID);
export const dbSelectSchema = dbIdSchema.nullable();
export const dbTableRefSchema = z.object({ connId: dbIdSchema, schema: dbIdent, name: dbIdent }).strict();
/**
 * A function by its identity arguments as the sidebar lists them (oidvectortypes: up to 100 type names, each possibly
 * schema-qualified and quoted). Compared as text in main, never written into a statement.
 */
const DB_ARGS_MAX = 16_384;
export const dbFunctionRefSchema = z.object({ connId: dbIdSchema, schema: dbIdent, name: dbIdent, args: z.string().max(DB_ARGS_MAX).refine(noNul, 'nul') }).strict();
/** DDL: a table's, or a function's definition (Copy Definition) — `args` is what makes it a function. */
export const dbDdlSchema = z.union([dbTableRefSchema, dbFunctionRefSchema]);
/** A filter's shape whatever its column (validFilterShape); the rest of validFilter runs on the catalog's column (sql.ts). */
const dbFilterSchema = z.object({
  column: dbIdent, path: dbPath.optional(), op: z.enum(DB_FILTER_OPS as [DbFilterOp, ...DbFilterOp[]]), values: z.array(dbValue).max(FILTER_VALUES_MAX)
}).strict().refine(validFilterShape, 'filter');
const dbFiltersSchema = z.array(dbFilterSchema).max(DB_LIST.filters);
export const dbPageSchema = z.object({
  ref: dbTableRefSchema,
  columns: z.array(dbIdent).max(DB_LIST.columns),
  derived: z.array(z.object({ column: dbIdent, path: dbPath.min(1) }).strict()).max(DB_LIST.derived),
  filters: dbFiltersSchema,
  sort: z.array(z.object({ column: dbIdent, path: dbPath.optional(), dir: z.enum(['asc', 'desc']) }).strict()).max(DB_LIST.sorts),
  page: z.number().int().min(0).max(1_000_000),
  size: z.union([z.literal(50), z.literal(100), z.literal(250), z.literal(500)]),
  slot: dbSlot.optional()
}).strict();
export const dbFilteredSchema = z.object({ ref: dbTableRefSchema, filters: dbFiltersSchema, slot: dbSlot.optional() }).strict();
const dbKey = <T extends z.ZodType>(value: T) => z.record(dbIdent, value).refine((k) => Object.keys(k).length <= DB_LIST.columns, 'key');
export const dbPeekSchema = z.object({ ref: dbTableRefSchema, cols: z.array(dbIdent).max(DB_LIST.columns), values: z.array(dbValue).max(DB_LIST.columns), row: z.literal(true).optional() }).strict()
  .refine((p) => p.cols.length === p.values.length, 'one value per column');
export const dbRefsSchema = z.object({ ref: dbTableRefSchema, key: dbKey(dbValue.nullable()) }).strict();
export const dbFullSchema = z.object({ ref: dbTableRefSchema, key: dbKey(dbValue), column: dbIdent, path: dbPath.optional() }).strict();
const dbPasswordText = z.string().max(1024);
export const dbPasswordSchema = z.object({ connId: dbIdSchema, password: dbPasswordText, save: z.boolean() }).strict();
/** Add / Edit Connection's form (DbConnectionForm): the connections file's fields minus what main keeps itself. */
export const dbFormSchema = dbConnectionFields.omit({ id: true, mask: true, writeNoted: true, schema: true, createdAt: true }).strict()
  .refine(hasEndpoint, { message: 'host or socket', path: ['host'] })
  .refine(sshOverTcp, { message: 'an SSH tunnel needs a host, not a socket', path: ['socket'] })
  .refine(sshTarget, { message: 'through an SSH tunnel, a host name or an IP address', path: ['host'] });
/** Test Connection and Save: a new connection (`id` null) or an edit; editing, '' or null keeps the saved password. */
export const dbEditSchema = z.object({ form: dbFormSchema, password: dbPasswordText.nullable(), id: dbIdSchema.nullable() }).strict();
/** Test Connection: Save's request (no suggestion to name any more). */
export const dbTestSchema = dbEditSchema;
export const dbMaskSchema = z.object({ id: dbIdSchema, on: z.boolean() }).strict();
export const dbSchemaPickSchema = z.object({ id: dbIdSchema, schema: dbIdent }).strict();

// File editing: the real limits are enforced by fs/write.ts, here we only drop what has the wrong shape.
const stampSchema = z.object({ mtimeMs: z.number(), size: z.number().int().nonnegative(), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const nameSchema = z.string().min(1).max(255);
export const filesSaveSchema = z.object({ path: abs, text: z.string().max(5 * 1024 * 1024), base: stampSchema.nullable(), eol: z.enum(['lf', 'crlf']), create: z.boolean().optional() }).strict();
export const filesCreateSchema = z.object({ dir: abs, name: nameSchema, kind: z.enum(['file', 'folder']) }).strict();
// Save as (untitled tab): the path is relative to the project root, checked by fs/write.ts.
export const filesSaveAsSchema = z.object({ rel: z.string().min(1).max(4096), text: z.string().max(5 * 1024 * 1024) }).strict();
/**
 * Save as outside the project: the name the save panel suggests (main's panel picks the
 * path), and the files open with unsaved edits, which it never replaces (a refusal only).
 */
export const filesSaveAsOutsideSchema = z.object({
  name: z.string().max(255), text: z.string().max(5 * 1024 * 1024), unsaved: z.array(z.string().min(1).max(4096)).max(500)
}).strict();
export const filesRenameSchema = z.object({ path: abs, name: nameSchema }).strict();
export const filesPathSchema = abs;
/** Paths of the files dropped from Finder, from the preload. */
// A whole folder's worth selected in Finder still opens (the router caps it and says so): cut, never refused.
export const filesOpenDroppedSchema = z.array(abs).max(100_000).transform((paths) => paths.slice(0, 1000));
/** A window's tabs to keep across restarts; main keeps only paths the project may read. */
const tabKey = z.string().min(1).max(4100);
export const tabsSaveSchema = z.object({ files: z.array(abs).max(MAX_SAVED_TABS), order: z.array(tabKey).max(400), active: tabKey.nullable(), shelf: z.array(abs).max(MAX_SAVED_SHELF).optional(), dbActive: tabKey.nullable().optional() }).strict();

/** Output triggers from the renderer: strict rules, valid and safe patterns, unique ids, capped. */
export const triggerRuleSchema = z.object({
  id: z.string().regex(TRIGGER_ID),
  pattern: z.string().min(1).max(MAX_PATTERN).refine((p) => checkPattern(p).ok, 'pattern'),
  action: z.enum(TRIGGER_ACTIONS as [TriggerAction, ...TriggerAction[]]),
  scope: z.enum(TRIGGER_SCOPES as [TriggerScope, ...TriggerScope[]]),
  enabled: z.boolean()
}).strict();
export const triggersSchema = z.array(triggerRuleSchema).max(MAX_TRIGGERS).refine((l) => new Set(l.map((r) => r.id)).size === l.length, 'duplicate ids');
/** A "notify" trigger matched in a terminal of the window: main may show the OS banner (text only, bounded). */
export const triggerNotifySchema = z.object({ id: idSchema, rule: z.string().min(1).max(MAX_PATTERN), line: z.string().max(MAX_LINE) }).strict();

const zField = (f: Field): z.ZodType => {
  switch (f.kind) {
    case 'triggers': return triggersSchema;
    case 'bool': return z.boolean();
    case 'enum': return z.enum(f.values as [string, ...string[]]);
    case 'int': return z.number().int().min(f.min).max(f.max);
    case 'step': return z.number().min(f.min).max(f.max);
    case 'profile': return profileKeySchema;
    case 'paths': return z.array(z.string().refine(isSettingPath)).max(f.max).refine((a) => new Set(a).size === a.length, 'duplicate path');
    case 'path': return z.union([z.literal(''), z.string().refine(isSettingPath)]);
    case 'dockerEngine': return z.union([z.literal(''), z.string().refine(isDockerEngineSetting)]);
    case 'redisUrls': return z.array(z.string().max(1024).refine((s) => normalizeCustom(s) === s, 'redis instance')).max(f.max).refine((a) => new Set(a).size === a.length, 'duplicate instance');
    case 'claudeAccounts': return claudeAccountsSchema;
    case 'claudeFlags': return claudeFlagsSchema;
    case 'text': return z.string().refine((v) => isSettingText(v, f.max), 'text');
    case 'fontFamily': return z.string().refine(isFontFamily, 'font family');
    case 'accountChoice': return z.union([z.literal('session'), z.string().regex(ACCOUNT_ID)]);
  }
};

/** Claude accounts from Settings: strictly shaped, and already in normalizeAccounts' form (nothing dropped or fixed). */
const accountSchema = z.object({ id: z.string().regex(ACCOUNT_ID), name: z.string().max(40), dir: z.string().max(4096), color: z.number().int() }).strict();
export const claudeAccountsSchema = z.object({
  list: z.array(accountSchema).min(1).max(MAX_ACCOUNTS),
  newSession: z.string().regex(ACCOUNT_ID),
  dismissed: z.array(z.string().max(4096)).max(MAX_DISMISSED)
}).strict().refine((v) => JSON.stringify(normalizeAccounts(v)) === JSON.stringify(v), 'claude accounts');

/** Launch flags from Settings: strictly shaped, and already in normalizeFlags' form (nothing dropped or fixed). */
const flagListSchema = z.array(z.array(z.string().max(MAX_TOKEN)).min(1).max(MAX_TOKENS)).max(MAX_FLAGS);
export const claudeFlagsSchema = z.object({
  all: flagListSchema,
  accounts: z.record(z.string().regex(ACCOUNT_ID), z.object({ flags: flagListSchema, shared: z.boolean() }).strict()).refine((r) => Object.keys(r).length <= MAX_ACCOUNTS, 'accounts')
}).strict().refine((v) => JSON.stringify(normalizeFlags(v)) === JSON.stringify(v), 'claude flags');

/** Schema of the patch coming from the renderer: strict, every field optional and within its limits. */
export const settingsPatchSchema = z.object(
  Object.fromEntries(Object.entries(SETTINGS_FIELDS).map(([k, f]) => [k, zField(f).optional()])) as Record<string, z.ZodOptional<z.ZodType>>
).strict();

// Dictation: 16-bit PCM (even byte count) up to 5 minutes at 16 kHz, plus the project vocabulary ingredients (text only,
// for Whisper's prompt hint and the polish context).
const words = z.array(z.string().max(200)).max(200);
export const dictationTranscribeSchema = z.object({
  // 5 minutes plus a one-second margin (microphone blocks do not land exactly on the limit).
  pcm: z.instanceof(Uint8Array).refine((b) => b.byteLength % 2 === 0 && b.byteLength <= 301 * 16000 * 2, 'pcm'),
  raw: z.boolean(),
  context: z.object({ sessions: words, branch: z.string().max(200).nullable(), files: words, identifiers: words }).strict(),
  // The terminal the text goes to: the polish runs with its Claude account.
  terminalId: idSchema.optional()
}).strict();

/** Background inspector: which item of which terminal; main resolves the file itself. */
export const backgroundWatchSchema = z.object({ terminalId: idSchema, itemId: z.string().regex(ITEM_ID) }).strict();
/** A self-paced loop's details: which cron of which terminal; main finds the transcript. */
export const backgroundLoopSchema = z.object({ terminalId: idSchema, cronId: z.string().regex(ITEM_ID) }).strict();

// Tab pop-out windows: every payload is data, bounded and closed over the known kinds.
const KEY_MAX = 4200;
export const popoutKeySchema = z.string().min(3).max(KEY_MAX).refine((k) => popoutKind(k) !== null);
const jsonSize = (max: number) => (v: unknown) => { try { return JSON.stringify(v ?? null).length <= max; } catch { return false; } };
export const popoutPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), rel: z.string().max(KEY_MAX), mode: z.enum(['margin', 'diff']) }).strict(),
  z.object({ kind: z.literal('review'), scope: z.string().max(KEY_MAX), againstMain: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('history'), repo: z.string().max(KEY_MAX), scope: z.unknown() }).strict(),
  z.object({ kind: z.literal('background'), terminalId: z.string().max(200), itemId: z.string().max(400).nullable() }).strict(),
  z.object({ kind: z.literal('docker'), target: z.unknown(), view: z.enum(['logs', 'inspect']) }).strict(),
  z.object({ kind: z.literal('redis'), view: z.unknown() }).strict(),
  z.object({ kind: z.literal('automations'), id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(), scope: z.enum(['project', 'all']) }).strict(),
  z.object({ kind: z.literal('rev'), root: z.string().max(KEY_MAX), oid: z.string().max(100), rel: z.string().max(KEY_MAX) }).strict(),
  // A table tab: names as the catalog spells them, empty for the overview (its key has none).
  z.object({
    kind: z.literal('db'), connId: dbIdSchema, schema: z.string().max(128).refine(noNul, 'nul'), name: z.string().max(128).refine(noNul, 'nul'),
    view: z.enum(['data', 'structure', 'relations']), rel: z.enum(['table', 'view', 'matview']).optional(),
    // An open asked in a pop-out: preview or not, a view asked or not, a key's filters as a page's.
    open: z.object({ preview: z.boolean(), view: z.boolean(), filters: dbFiltersSchema.optional(), inspector: z.boolean().optional() }).strict().optional()
  }).strict(),
  // Ask open for the terminal's session: the receiving window opens it from its own state.
  z.object({ kind: z.literal('terminal'), ask: z.boolean() }).strict()
]).refine(jsonSize(64 * 1024));
const HANDOFF_TEXT_MAX = 64 * 1024 * 1024;
/** The selection and the undo history (CodeMirror's JSON): the editor leaves a history past 8 MiB behind anyway. */
const HANDOFF_JSON_MAX = 16 * 1024 * 1024;
export const editorHandoffSchema = z.object({
  path: z.string().min(1).max(KEY_MAX),
  state: z.object({ doc: z.string().max(HANDOFF_TEXT_MAX), selection: z.unknown().refine(jsonSize(HANDOFF_JSON_MAX)), history: z.unknown().refine(jsonSize(HANDOFF_JSON_MAX)).optional() }).strict(),
  saved: z.string().max(HANDOFF_TEXT_MAX).nullable(),
  stamp: z.object({ mtimeMs: z.number(), size: z.number(), hash: z.string().max(200) }).strict().nullable(),
  eol: z.enum(['lf', 'crlf']),
  scrollTop: z.number().finite()
}).strict();
const popoutSize = z.object({ width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000) }).strict();
export const popoutOpenSchema = z.object({ key: popoutKeySchema, payload: popoutPayloadSchema.optional(), handoff: editorHandoffSchema.optional(), size: popoutSize, at: z.enum(['cursor', 'cascade']) }).strict();
const finite = z.number().finite();
/** Tab tear-off: a CSS colour as the avatar draws it (hex, rgb(), hsl(), oklch()…), no other syntax. */
const cssColor = z.string().max(64).regex(/^(#[0-9a-fA-F]{3,8}|[a-z]{3,6}\([0-9a-zA-Z.,%/ +-]{1,52}\)|[a-z]{3,20})$/);
export const popoutTearStartSchema = z.object({
  key: popoutKeySchema, title: z.string().max(300), icon: z.enum(['session', 'session-tile', 'terminal', 'file', 'view']), color: cssColor.optional(),
  size: popoutSize, rect: z.object({ x: finite.min(-20000).max(20000), y: finite.min(-20000).max(20000), width: finite.positive().max(20000), height: finite.positive().max(20000) }).strict().optional(),
  reduced: z.boolean().optional(), theme: z.enum(THEME_IDS as [ThemeId, ...ThemeId[]]).optional()
}).strict();
export const dockRequestSchema = z.object({ payload: popoutPayloadSchema.optional(), handoff: editorHandoffSchema.optional() }).strict();
/** Moving a tab to another project's window: the target project's root, the
 *  tab, its view and buffer, the client point it was dropped on there. Main checks the rest (the mover). */
const clientPoint = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const moveRequestSchema = z.object({
  to: absPathSchema(1, 4096), key: popoutKeySchema, payload: popoutPayloadSchema.optional(), handoff: editorHandoffSchema.optional(), at: clientPoint.optional()
}).strict();
export const adoptAnswerSchema = z.object({ id: z.number().int().positive(), ok: z.boolean(), reason: z.literal('open-there').optional() }).strict();
export const popoutFocusSchema = z.object({ key: popoutKeySchema, reveal: z.object({ line: z.number().int().positive().optional(), payload: popoutPayloadSchema.optional() }).strict().optional() }).strict();
/** A tab a pop-out shows in its project window (files go through popoutOpenInMainSchema). */
export const popoutShowInMainSchema = z.object({ key: popoutKeySchema, payload: popoutPayloadSchema.optional() }).strict();
/** A file a pop-out opens in its project window: on disk (absolute; an untitled buffer lives in one window only). */
export const popoutOpenInMainSchema = z.object({
  path: absPathSchema(2, KEY_MAX).refine((p) => !p.includes('\0'), 'path'),
  line: z.number().int().positive().optional()
}).strict();
/** Save As in a pop-out: its untitled buffer (`f:untitled:N`) is a file on disk now (an absolute path). */
export const popoutRekeySchema = z.object({
  from: z.string().regex(/^f:untitled:\d{1,9}$/),
  to: filePathKeySchema(KEY_MAX)
}).strict();
/** The menu commands a pop-out may forward to the main window (derived from the menu spec, so they can't drift). */
const FORWARDABLE = new Set<string>(menuItems(MENU_SPEC).flatMap((i) => ('command' in i && i.command ? [i.command as string] : [])));
// Not in the menu: a connector's details page, asked by a pop-out's toast or palette command.
const OPEN_CONNECTOR = new Set<string>(CONNECTOR_IDS.map((id) => `open-connector:${id}`));
export const popoutForwardSchema = z.string().max(200).refine((c) => FORWARDABLE.has(c) || OPEN_CONNECTOR.has(c) || /^(tab-[1-9]|new-session-account:.+|new-terminal-profile:.+)$/.test(c));
