// App settings: one table of fields, from which defaults, normalization and the IPC schema derive.
import { isProfileKeyShape, type ProfileKey } from './profiles';
import { DEFAULT_TRIGGERS, normalizeTriggers, type TriggerRule } from './triggers';
import type { UpdateChannelSetting } from './update-feed';
import { normalizeCustom } from './redis';
import { ACCOUNT_ID, DEFAULT_ACCOUNTS, normalizeAccounts, type ClaudeAccounts } from './claude-accounts';
import { DEFAULT_FLAGS, normalizeFlags, pruneFlags, type ClaudeFlags } from './claude-flags';
import type { ConnectorId } from './tasks';
import { isAbsPath } from './paths';
import { dockerPipeName } from './docker';
import { pathStyle } from './platform';
import type { AnswerStyle, CompanionModel } from './companion/types';
import { THEME_IDS, type TerminalColors, type ThemeId } from './themes';
import { BUNDLED_FONT, isFontFamily } from './terminal-font';

export type InterfaceSize = 'small' | 'default' | 'large' | 'larger';
export type CursorStyle = 'bar' | 'block' | 'underline';
export type ClaudeModel = 'default' | 'opus' | 'sonnet' | 'haiku';
// inherit: no flag, the user's own Claude setting decides. No bypassPermissions: Atelier never starts
// sessions without confirmations (nor dontAsk).
export type ClaudePermissionMode = 'inherit' | 'default' | 'auto' | 'acceptEdits' | 'plan';
export type MotionPref = 'system' | 'reduced';
export type DictationShortcut = 'alt-space' | 'ctrl-alt-space' | 'f5';
export type DictationLanguage = 'auto' | 'it' | 'en';
export type DictationKeepLoaded = 'ten-minutes' | 'always';
/** "Finished" (bell entry, chime, macOS banner) only for turns at least this long (quick replies spammed them). */
export type NotifyDoneAfter = 'always' | '30s' | '1m' | '3m' | '5m';
export const NOTIFY_DONE_AFTER_MS: Record<NotifyDoneAfter, number> = { always: 0, '30s': 30_000, '1m': 60_000, '3m': 180_000, '5m': 300_000 };
/** Source Control fetches on its own: the repo being viewed, or also every repo every N minutes. */
export type AutoFetch = 'viewing' | '15m' | '30m' | '60m' | 'off';
/** Git writes: commit, push, branches from Atelier, or read-only as before. */
export type GitActions = 'on' | 'read-only';
/** ✦ commit messages: which Claude writes them, or none. */
export type CommitMessages = 'haiku' | 'sonnet' | 'off';
/** ✦'s language: like the repository's recent commits, or always English. */
export type CommitLanguage = 'commits' | 'english';
/** Commit with nothing staged: ask to stage everything, do it, or wait for checked files. */
export type CommitNothingStaged = 'ask' | 'stage-all' | 'never';
/** Docker view: Auto shows it when an engine answers. */
export type ShowDocker = 'auto' | 'always' | 'never';
/** Redis view: Auto shows it when an instance answers or the project mentions one. */
export type ShowRedis = 'auto' | 'always' | 'never';
/** Settings › Redis › Edits: every write asks first (and can be undone), or none is offered. */
export type RedisEdits = 'ask' | 'readonly';
/** Databases view: Auto shows it when a connection is saved for the project or every project. */
export type ShowDatabases = 'auto' | 'always' | 'never';
/** How the grid shows times with a zone: the Mac's local time, UTC, or as Postgres printed them. */
export type DbTimes = 'local' | 'utc' | 'stored';
/** Rows per fetch as the grid scrolls: a string, as Segmented takes strings. */
export type DbPageSize = '50' | '100' | '250' | '500';
/** Markdown preview: the view a Markdown file opens in when it has none of its own. */
export type MarkdownView = 'source' | 'preview';
/** JSON navigation: the view a JSON file opens in, and Copy Path's format. */
export type JsonView = 'source' | 'tree';
export type JsonPathFormat = 'jq' | 'js' | 'pointer';
/** CSV viewer: the view a CSV file opens in. */
export type CsvView = 'source' | 'table';
export const AUTO_FETCH_INTERVAL_MS: Partial<Record<AutoFetch, number>> = { '15m': 15 * 60_000, '30m': 30 * 60_000, '60m': 60 * 60_000 };

export interface Settings {
  interfaceSize: InterfaceSize;
  theme: ThemeId;
  terminalColors: TerminalColors;
  motion: MotionPref;
  /** The terminal's font family: JetBrains Mono or an installed monospaced font. */
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  optionAsMeta: boolean;
  scrollback: number;
  /** Profile of new terminals: 'atelier', 'user' (zsh with your config) or a shell from /etc/shells. */
  terminalProfile: ProfileKey;
  /** Atelier-profile terminals get the aliases of the user's zsh config (spec Atelier profile aliases). */
  terminalAliases: boolean;
  /**
   * A new Atelier-profile terminal first reloads atelierd's shell environment when the user's zsh files changed after
   * the capture.
   */
  shellEnvAutoReload: boolean;
  /** Extra files checked like the zsh startup files (e.g. one the user's .zshrc sources): absolute paths. */
  shellEnvWatchFiles: string[];
  /** Command blocks in Atelier-profile terminals: gutter bars, ⌘↑/⌘↓, copy output, sticky command. */
  commandBlocks: boolean;
  /** A click in the command being typed moves zsh's cursor there (Atelier-profile terminals). */
  clickMovesCursor: boolean;
  /** Output triggers: rules matched against new terminal output. */
  triggers: TriggerRule[];
  /** Listening ports chips: main reads them with ps and lsof; off, it runs nothing. */
  showPorts: boolean;
  /** Ports of the OS's ephemeral range (49152–65535: test runs' random ports) in the chips too. */
  showEphemeralPorts: boolean;
  /**
   * A session whose agents wait for their own background work reads as Working; off, the inbox
   * and "Finished" follow the main agent only.
   */
  countBackgroundWork: boolean;
  /**
   * A project window closing, or Atelier quitting: 'ask' when something is busy, else
   * stop its terminals; 'stop' always; 'keep' leaves them running in atelierd (the behaviour before).
   */
  closeWindowSessions: 'ask' | 'stop' | 'keep';
  /**
   * Closing one Claude session leaves it under the sidebar's Resume instead of ending it:
   * its process stops, its memory goes, a click resumes it.
   */
  keepClosedSessions: boolean;
  /** Workspaces: ⌘J goes to a session waiting in another workspace, switching to it. */
  wsJumpFollows: boolean;
  /**
   * Workspaces in every project (2026-11-02): on, every project window has them, whatever its own switch says (set
   * aside meanwhile); off, each project decides again.
   */
  workspacesEverywhere: boolean;
  /** Ask companion: the model that answers, haiku/sonnet/opus. */
  askModel: CompanionModel;
  /** Whose account pays for Ask: 'session' (the session's own) or a Claude account id. */
  askAccount: string;
  /** Opening Ask in a session with no summary yet starts the catch-up by itself. Off by default: Ask opens on its
   *  Catch me up button and starters. */
  askCatchUpOnOpen: boolean;
  askAnswers: AnswerStyle;
  /** What you already know about the project, so answers skip it (at most ASK_KNOWN_MAX characters). */
  askKnown: string;
  editorFontSize: number;
  wordWrap: boolean;
  markdownView: MarkdownView;
  markdownOutline: boolean;
  jsonView: JsonView;
  jsonPathFormat: JsonPathFormat;
  /** Split: the tree selects the value under the editor's cursor. */
  jsonTreeFollowsCursor: boolean;
  /** CSV viewer: the default view, Split's sync, the source's colors and padding, the
   * table header's summaries. */
  csvView: CsvView;
  csvTableFollowsCursor: boolean;
  csvRainbow: boolean;
  csvAlign: boolean;
  csvSummaries: boolean;
  /** Files opened with a single click share one italic tab, replaced by the next one. */
  previewTabs: boolean;
  showHiddenFiles: boolean;
  /** Changes on the left, the activity bar and sidebar (sessions, files…) on the right. */
  swapSidePanels: boolean;
  /**
   * Session avatars in the sidebar, tabs and session bars; off,
   * rows start with the title and tabs show the session tile.
   */
  sessionAvatars: boolean;
  /** The Services view, the project's tmux panes (2026-11-02: off until turned on; few people use tmux). Never on Windows. */
  showServices: boolean;
  claudeModel: ClaudeModel;
  claudePermissionMode: ClaudePermissionMode;
  /** Claude accounts: the default one first, the account new sessions start with. */
  claudeAccounts: ClaudeAccounts;
  /** Launch flags: `claude` flags for all accounts and per account, added to new sessions. */
  claudeFlags: ClaudeFlags;
  /** New MCP servers: a session's servers added since it started, shown with a restart. */
  claudeMcpNotice: boolean;
  /** Pull request and CI chip of a session's branch: main asks the GitHub CLI; off, gh never runs. */
  prStatus: boolean;
  /**
   * Automations at all (2026-11-02: off until turned on). Off: no view, menu or palette entry, and the runner reads and
   * starts nothing new (as with Pause All). Someone who had automations before is turned on once (keepExistingOn).
   */
  automationsEnabled: boolean;
  /** Automations: runs at once across projects, starting ones included. */
  automationsCap: number;
  /** When the cap is reached, new runs wait for the user ('ask') or in line ('queue'). */
  automationsWhenFull: 'ask' | 'queue';
  /** Pause All: nothing new is read or started. */
  automationsPaused: boolean;
  /** The Mac stays awake while a run works. */
  automationsKeepAwake: boolean;
  notifyWaiting: boolean;
  notifyDone: boolean;
  /** "Finished" (bell entry, chime, macOS banner) only for turns at least this long; errors always. */
  notifyDoneAfter: NotifyDoneAfter;
  notifySound: boolean;
  /** An OS notification when a "notify" trigger matches (the notification center gets the entry anyway). */
  notifyTriggers: boolean;
  dockBadge: boolean;
  /** Session icons (spec session tray icons): macOS menu bar dots for sessions that need you, Windows' notification-area icon. */
  trayIcons: boolean;
  dictationEnabled: boolean;
  dictationShortcut: DictationShortcut;
  dictationLanguage: DictationLanguage;
  dictationPolish: boolean;
  dictationAutoSend: boolean;
  dictationSounds: boolean;
  dictationKeepLoaded: DictationKeepLoaded;
  /** In-app updates (Settings › About): 'auto' follows the build's channel (none for dev and stage-update builds). */
  updateChannel: UpdateChannelSetting;
  /** Settings › Connectors: a linked task opens in its desktop app (ClickUp) when installed, else in the browser. */
  openTasksInApp: boolean;
  /** The same for Notion's tasks: each connector has its own toggle. */
  openNotionTasksInApp: boolean;
  /** Settings › Source Control: when Atelier runs `git fetch` on its own; manual fetches always work. */
  autoFetch: AutoFetch;
  /**
   * Settings › Source Control, git writes: the actions, ✦'s model, whether ✦ reads what the
   * sessions were asked, its language, and the Co-authored-by Claude toggle's default.
   */
  gitActions: GitActions;
  commitMessages: CommitMessages;
  commitUsePrompts: boolean;
  commitLanguage: CommitLanguage;
  commitCoAuthor: boolean;
  commitNothingStaged: CommitNothingStaged;
  /** Settings › Docker: the view, the engine's socket ('' detected), others, notifications, history. */
  showDocker: ShowDocker;
  dockerSocket: string;
  dockerOthers: boolean;
  dockerNotify: boolean;
  dockerLogLines: number;
  /** Settings › Redis: the view, custom instances (passwordless), edits, monitor, queues, notify, scan size. */
  showRedis: ShowRedis;
  redisInstances: string[];
  redisEdits: RedisEdits;
  redisMonitor: boolean;
  redisQueues: boolean;
  redisNotify: boolean;
  redisScanKeys: number;
  /** Settings › Databases: the view, times, rows per fetch, the query timeout in seconds. */
  showDatabases: ShowDatabases;
  dbTimes: DbTimes;
  dbPageSize: DbPageSize;
  dbTimeoutSec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  interfaceSize: 'default',
  theme: 'aurora',
  terminalColors: 'theme',
  motion: 'system',
  terminalFontFamily: BUNDLED_FONT,
  terminalFontSize: 13,
  terminalLineHeight: 1.2,
  cursorStyle: 'bar',
  cursorBlink: true,
  optionAsMeta: false,
  scrollback: 10000,
  terminalProfile: 'atelier',
  terminalAliases: true,
  shellEnvAutoReload: true,
  shellEnvWatchFiles: [],
  commandBlocks: true,
  clickMovesCursor: true,
  triggers: DEFAULT_TRIGGERS,
  showPorts: true,
  showEphemeralPorts: false,
  countBackgroundWork: true,
  closeWindowSessions: 'ask',
  keepClosedSessions: false,
  wsJumpFollows: true,
  workspacesEverywhere: false,
  askModel: 'sonnet',
  askAccount: 'session',
  askCatchUpOnOpen: false,
  askAnswers: 'short',
  askKnown: '',
  editorFontSize: 13,
  wordWrap: false,
  markdownView: 'source',
  markdownOutline: true,
  jsonView: 'source',
  jsonPathFormat: 'jq',
  jsonTreeFollowsCursor: true,
  csvView: 'source',
  csvTableFollowsCursor: true,
  csvRainbow: true,
  csvAlign: false,
  csvSummaries: false,
  previewTabs: true,
  showHiddenFiles: false,
  swapSidePanels: false,
  sessionAvatars: true,
  showServices: false,
  claudeModel: 'default',
  claudePermissionMode: 'inherit',
  claudeAccounts: DEFAULT_ACCOUNTS,
  claudeFlags: DEFAULT_FLAGS,
  claudeMcpNotice: true,
  prStatus: true,
  automationsEnabled: false,
  automationsCap: 3,
  automationsWhenFull: 'ask',
  automationsPaused: false,
  automationsKeepAwake: false,
  notifyWaiting: true,
  notifyDone: false,
  notifyDoneAfter: '1m',
  notifySound: true,
  notifyTriggers: true,
  dockBadge: true,
  trayIcons: true,
  dictationEnabled: false,
  dictationShortcut: 'alt-space',
  dictationLanguage: 'auto',
  dictationPolish: true,
  dictationAutoSend: false,
  dictationSounds: true,
  dictationKeepLoaded: 'ten-minutes',
  updateChannel: 'auto',
  openTasksInApp: true,
  openNotionTasksInApp: true,
  autoFetch: 'viewing',
  gitActions: 'on',
  commitMessages: 'haiku',
  commitUsePrompts: true,
  commitLanguage: 'commits',
  commitCoAuthor: true,
  commitNothingStaged: 'ask',
  showDocker: 'auto',
  dockerSocket: '',
  dockerOthers: true,
  dockerNotify: true,
  dockerLogLines: 5000,
  showRedis: 'auto',
  redisInstances: [],
  redisEdits: 'ask',
  redisMonitor: true,
  redisQueues: true,
  redisNotify: false,
  redisScanKeys: 10000,
  showDatabases: 'auto',
  dbTimes: 'local',
  dbPageSize: '100',
  dbTimeoutSec: 15
};

export type Field =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'step'; min: number; max: number; step: number }
  | { kind: 'bool' }
  | { kind: 'profile' }
  | { kind: 'triggers' }
  | { kind: 'paths'; max: number }
  /** One absolute path, or '' for none. */
  | { kind: 'path' }
  /** The Docker engine: an absolute socket path, a named pipe on Windows; '' for detected. */
  | { kind: 'dockerEngine' }
  /** Custom Redis instances: passwordless loopback URLs or absolute socket paths (normalizeCustom's form). */
  | { kind: 'redisUrls'; max: number }
  /** Claude accounts (normalizeAccounts' form). */
  | { kind: 'claudeAccounts' }
  /** Launch flags (normalizeFlags' form). */
  | { kind: 'claudeFlags' }
  /** Free text up to `max` characters; newline and tab allowed, other control characters not. */
  | { kind: 'text'; max: number }
  /** A font family name (isFontFamily). */
  | { kind: 'fontFamily' }
  /** 'session' or a Claude account id. */
  | { kind: 'accountChoice' };

/** The most characters "What I already know" (Settings › Ask) keeps. */
export const ASK_KNOWN_MAX = 2000;

/** Bounded text a `text` field accepts: a string within `max`, no control characters but \n and \t. */
export function isSettingText(v: unknown, max: number): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(v);
}

/** Settings › Docker › Engine: a socket path on macOS, a named pipe (either form) on Windows. */
export function isDockerEngineSetting(v: unknown): v is string {
  return pathStyle() === 'win32' ? typeof v === 'string' && dockerPipeName(v) !== null : isSettingPath(v);
}

/** A path a `paths` field accepts: absolute, no NUL, at most this long. */
export const MAX_SETTING_PATH = 1024;
export function isSettingPath(v: unknown): v is string {
  return typeof v === 'string' && isAbsPath(v) && v.length <= MAX_SETTING_PATH && !v.includes('\u0000');
}

export const SETTINGS_FIELDS: { [K in keyof Settings]: Field } = {
  interfaceSize: { kind: 'enum', values: ['small', 'default', 'large', 'larger'] },
  theme: { kind: 'enum', values: THEME_IDS },
  terminalColors: { kind: 'enum', values: ['theme', 'dark'] },
  motion: { kind: 'enum', values: ['system', 'reduced'] },
  terminalFontFamily: { kind: 'fontFamily' },
  terminalFontSize: { kind: 'int', min: 10, max: 24 },
  terminalLineHeight: { kind: 'step', min: 1, max: 1.6, step: 0.05 },
  cursorStyle: { kind: 'enum', values: ['bar', 'block', 'underline'] },
  cursorBlink: { kind: 'bool' },
  optionAsMeta: { kind: 'bool' },
  scrollback: { kind: 'int', min: 1000, max: 100000 },
  terminalProfile: { kind: 'profile' },
  terminalAliases: { kind: 'bool' },
  shellEnvAutoReload: { kind: 'bool' },
  shellEnvWatchFiles: { kind: 'paths', max: 20 },
  commandBlocks: { kind: 'bool' },
  clickMovesCursor: { kind: 'bool' },
  triggers: { kind: 'triggers' },
  showPorts: { kind: 'bool' },
  showEphemeralPorts: { kind: 'bool' },
  countBackgroundWork: { kind: 'bool' },
  closeWindowSessions: { kind: 'enum', values: ['ask', 'stop', 'keep'] },
  keepClosedSessions: { kind: 'bool' },
  wsJumpFollows: { kind: 'bool' },
  workspacesEverywhere: { kind: 'bool' },
  askModel: { kind: 'enum', values: ['haiku', 'sonnet', 'opus'] },
  askAccount: { kind: 'accountChoice' },
  askCatchUpOnOpen: { kind: 'bool' },
  askAnswers: { kind: 'enum', values: ['short', 'detailed'] },
  askKnown: { kind: 'text', max: ASK_KNOWN_MAX },
  editorFontSize: { kind: 'int', min: 10, max: 24 },
  wordWrap: { kind: 'bool' },
  markdownView: { kind: 'enum', values: ['source', 'preview'] },
  markdownOutline: { kind: 'bool' },
  jsonView: { kind: 'enum', values: ['source', 'tree'] },
  jsonPathFormat: { kind: 'enum', values: ['jq', 'js', 'pointer'] },
  jsonTreeFollowsCursor: { kind: 'bool' },
  csvView: { kind: 'enum', values: ['source', 'table'] },
  csvTableFollowsCursor: { kind: 'bool' },
  csvRainbow: { kind: 'bool' },
  csvAlign: { kind: 'bool' },
  csvSummaries: { kind: 'bool' },
  previewTabs: { kind: 'bool' },
  showHiddenFiles: { kind: 'bool' },
  swapSidePanels: { kind: 'bool' },
  sessionAvatars: { kind: 'bool' },
  showServices: { kind: 'bool' },
  claudeModel: { kind: 'enum', values: ['default', 'opus', 'sonnet', 'haiku'] },
  claudePermissionMode: { kind: 'enum', values: ['inherit', 'default', 'auto', 'acceptEdits', 'plan'] },
  claudeAccounts: { kind: 'claudeAccounts' },
  claudeFlags: { kind: 'claudeFlags' },
  claudeMcpNotice: { kind: 'bool' },
  prStatus: { kind: 'bool' },
  automationsEnabled: { kind: 'bool' },
  automationsCap: { kind: 'int', min: 1, max: 10 },
  automationsWhenFull: { kind: 'enum', values: ['ask', 'queue'] },
  automationsPaused: { kind: 'bool' },
  automationsKeepAwake: { kind: 'bool' },
  notifyWaiting: { kind: 'bool' },
  notifyDone: { kind: 'bool' },
  notifyDoneAfter: { kind: 'enum', values: ['always', '30s', '1m', '3m', '5m'] },
  notifySound: { kind: 'bool' },
  notifyTriggers: { kind: 'bool' },
  dockBadge: { kind: 'bool' },
  trayIcons: { kind: 'bool' },
  dictationEnabled: { kind: 'bool' },
  dictationShortcut: { kind: 'enum', values: ['alt-space', 'ctrl-alt-space', 'f5'] },
  dictationLanguage: { kind: 'enum', values: ['auto', 'it', 'en'] },
  dictationPolish: { kind: 'bool' },
  dictationAutoSend: { kind: 'bool' },
  dictationSounds: { kind: 'bool' },
  dictationKeepLoaded: { kind: 'enum', values: ['ten-minutes', 'always'] },
  updateChannel: { kind: 'enum', values: ['auto', 'off', 'stable', 'beta'] },
  openTasksInApp: { kind: 'bool' },
  openNotionTasksInApp: { kind: 'bool' },
  autoFetch: { kind: 'enum', values: ['viewing', '15m', '30m', '60m', 'off'] },
  gitActions: { kind: 'enum', values: ['on', 'read-only'] },
  commitMessages: { kind: 'enum', values: ['haiku', 'sonnet', 'off'] },
  commitUsePrompts: { kind: 'bool' },
  commitLanguage: { kind: 'enum', values: ['commits', 'english'] },
  commitCoAuthor: { kind: 'bool' },
  commitNothingStaged: { kind: 'enum', values: ['ask', 'stage-all', 'never'] },
  showDocker: { kind: 'enum', values: ['auto', 'always', 'never'] },
  dockerSocket: { kind: 'dockerEngine' },
  dockerOthers: { kind: 'bool' },
  dockerNotify: { kind: 'bool' },
  dockerLogLines: { kind: 'step', min: 1000, max: 20000, step: 1000 },
  showRedis: { kind: 'enum', values: ['auto', 'always', 'never'] },
  redisInstances: { kind: 'redisUrls', max: 16 },
  redisEdits: { kind: 'enum', values: ['ask', 'readonly'] },
  redisMonitor: { kind: 'bool' },
  redisQueues: { kind: 'bool' },
  redisNotify: { kind: 'bool' },
  redisScanKeys: { kind: 'step', min: 1000, max: 100000, step: 1000 },
  showDatabases: { kind: 'enum', values: ['auto', 'always', 'never'] },
  dbTimes: { kind: 'enum', values: ['local', 'utc', 'stored'] },
  dbPageSize: { kind: 'enum', values: ['50', '100', '250', '500'] },
  dbTimeoutSec: { kind: 'step', min: 5, max: 120, step: 5 }
};

const snap = (v: number, step: number) => Math.round(Math.round(v / step) * step * 100) / 100;

/** Context for values that depend on the machine: the shells listed in /etc/shells (main only). */
export interface SettingsContext { shells?: readonly string[] }

/** The value if valid for the field (line height rounded to the step), otherwise undefined. */
function valid(f: Field, v: unknown, ctx: SettingsContext): unknown {
  switch (f.kind) {
    case 'profile':
      if (!isProfileKeyShape(v)) return undefined;
      // A shell that is not (or no longer) listed: back to the default. Without a list only the shape is checked.
      return v === 'atelier' || v === 'user' || !ctx.shells || ctx.shells.includes(v) ? v : undefined;
    case 'triggers': return normalizeTriggers(v);
    case 'claudeAccounts': return normalizeAccounts(v);
    case 'claudeFlags': return normalizeFlags(v);
    case 'paths': return Array.isArray(v) ? [...new Set(v.filter(isSettingPath))].slice(0, f.max) : undefined;
    case 'path': return v === '' || isSettingPath(v) ? v : undefined;
    case 'dockerEngine': return v === '' || isDockerEngineSetting(v) ? v : undefined;
    case 'redisUrls': return Array.isArray(v) ? [...new Set(v.flatMap((x) => (typeof x === 'string' ? [normalizeCustom(x)] : [])).filter((x): x is string => !!x))].slice(0, f.max) : undefined;
    case 'text': return isSettingText(v, f.max) ? v : undefined;
    case 'fontFamily': return isFontFamily(v) ? v : undefined;
    case 'accountChoice': return v === 'session' || (typeof v === 'string' && ACCOUNT_ID.test(v)) ? v : undefined;
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'enum': return typeof v === 'string' && f.values.includes(v) ? v : undefined;
    case 'int': return typeof v === 'number' && Number.isInteger(v) && v >= f.min && v <= f.max ? v : undefined;
    case 'step': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
      const s = snap(v, f.step);
      return s >= f.min && s <= f.max ? s : undefined;
    }
  }
}

/** From the file (whatever it contains) to valid settings: field by field, unknown keys dropped. */
export function normalizeSettings(raw: unknown, ctx: SettingsContext = {}): Settings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(SETTINGS_FIELDS) as (keyof Settings)[]) {
    const v = valid(SETTINGS_FIELDS[key], src[key], ctx);
    // Defaults that are lists or objects are copied: nothing downstream can change the shared constant.
    const d = DEFAULT_SETTINGS[key];
    out[key] = v === undefined ? (d && typeof d === 'object' ? structuredClone(d) : d) : v;
  }
  const s = out as unknown as Settings;
  // A removed account's flags go with it: a new account that takes its id back starts with none.
  s.claudeFlags = pruneFlags(s.claudeFlags, s.claudeAccounts.list.map((a) => a.id));
  return s;
}

export function applyPatch(s: Settings, patch: Partial<Settings>, ctx: SettingsContext = {}): Settings {
  return normalizeSettings({ ...s, ...patch }, ctx);
}

/**
 * Each connector's "Open tasks in the <App> app" toggle: ClickUp keeps the original key. Jira has
 * no desktop app: no toggle, always the browser.
 */
export const OPEN_IN_APP_SETTING: Readonly<Record<ConnectorId, 'openTasksInApp' | 'openNotionTasksInApp' | null>> = { clickup: 'openTasksInApp', notion: 'openNotionTasksInApp', jira: null };

/** Whether a task of `source` opens in its desktop app (main picks the setting by the task's source). */
export function opensInApp(s: Settings, source: ConnectorId): boolean {
  const key = OPEN_IN_APP_SETTING[source];
  return key !== null && s[key];
}

export function zoomFactor(size: InterfaceSize): number {
  return { small: 0.9, default: 1, large: 1.1, larger: 1.25 }[size];
}

/** Windows: every window's one bar — the header, the Welcome window's bar, a pop-out's — in px. */
export const WINDOW_BAR = 46;

/**
 * Windows: the minimize / maximize / close buttons drawn over the end of
 * the window's one bar, on its own background (transparent) with Aurora's --text-2 symbols, scaled by zoom.
 */
export function windowButtons(zoom: number, row: number, symbolColor: string): { color: string; symbolColor: string; height: number } {
  return { color: '#00000000', symbolColor, height: Math.round(row * zoom) };
}

/** Position of the macOS traffic lights: centered in the header (46 px, scaled by zoom), as at zoom 1 (16, 17). */
export function trafficLights(zoom: number): { x: number; y: number } {
  return { x: Math.round(16 * zoom), y: Math.round(23 * zoom - 6) };
}
