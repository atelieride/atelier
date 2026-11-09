/**
 * Launch flags: `claude` flags the user adds to new sessions, for all accounts and per account.
 * Pure: main expands and quotes them (shell.ts), the renderer edits them. A flag is its argv tokens: the flag, then its
 * values. Nothing here ever reaches a shell unquoted.
 */
import { ACCOUNT_ID } from './claude-accounts';
import { pathStyle } from './platform';

export type LaunchFlag = string[];
export interface AccountFlags { flags: LaunchFlag[]; shared: boolean }
export interface ClaudeFlags { all: LaunchFlag[]; accounts: Record<string, AccountFlags> }

export const DEFAULT_FLAGS: ClaudeFlags = { all: [], accounts: {} };
export const DANGER_FLAG = '--dangerously-skip-permissions';
/** Lets Claude switch to bypass mode (⇧Tab): it skips nothing by itself, but it is shown in rose too. */
const ALLOW_DANGER_FLAG = '--allow-dangerously-skip-permissions';
/** Flags per list, tokens per flag, characters per token. */
export const MAX_FLAGS = 24;
export const MAX_TOKENS = 16;
export const MAX_TOKEN = 1024;
/**
 * A list's size on the command line (listSize): the flags for all accounts and an account's own stay well under the
 * 10000 characters atelierd takes for a whole command, with the name and the config dir.
 */
export const MAX_LIST_SIZE = 3500;

export type FlagError = 'shape' | 'reserved' | 'chars' | 'long' | 'many' | 'novalue' | 'quote';

/**
 * Atelier sets these itself (model, mode, name), resumes and reads the session id itself, or they would end or change the
 * interactive session (print, formats, help) or drop the settings that carry its state hooks.
 */
const RESERVED = new Set(['--model', '--permission-mode', '--name', '-n', '--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '--print', '-p', '--output-format', '--input-format', '--settings', '--help', '-h', '--version', '-v']);

/** Flags that take no value: a word after one would reach Claude as a prompt (`--verbose hi`) or a subcommand (`--ide update`). */
const NO_VALUE = new Set(['--verbose', '--ide', '--debug', '--strict-mcp-config', DANGER_FLAG, ALLOW_DANGER_FLAG]);

const FLAG = /^(?:--[A-Za-z][A-Za-z0-9-]*(?:=[\s\S]*)?|-[A-Za-z])$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// PowerShell 5.1 mangles double quotes on the way to claude.exe; npm's claude.cmd runs through cmd, which expands % and
// !, and reads & | < > ^ in a word PowerShell leaves unquoted (no space in it); a trailing backslash escapes the quote.
const WIN_BAD = /["%!&|<>^]|\\$/;

/** The flag's name: `--add-dir=/x` → `--add-dir`. */
export const flagName = (token: string): string => token.split('=', 1)[0]!;

/** Why a flag can't be used, or null. */
export function flagError(flag: unknown): FlagError | null {
  if (!Array.isArray(flag) || flag.length === 0 || !flag.every((t) => typeof t === 'string')) return 'shape';
  const tokens = flag as string[];
  if (tokens.length > MAX_TOKENS) return 'many';
  if (tokens.some((t) => t.length > MAX_TOKEN)) return 'long';
  if (tokens.some((t) => CONTROL.test(t))) return 'chars';
  // A value starting with - would be read as a flag of its own (`--x --settings`): one is written `--x=-v`.
  if (!FLAG.test(tokens[0]!) || tokens.slice(1).some((t) => t === '' || t.startsWith('-'))) return 'shape';
  if (RESERVED.has(flagName(tokens[0]!))) return 'reserved';
  if (NO_VALUE.has(flagName(tokens[0]!)) && (tokens.length > 1 || tokens[0]!.includes('='))) return 'novalue';
  if (pathStyle() === 'win32' && tokens.some((t) => WIN_BAD.test(t))) return 'chars';
  return null;
}

const same = (a: LaunchFlag, b: LaunchFlag) => a.length === b.length && a.every((t, i) => t === b[i]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A list's characters on the command line: each token single-quoted (a quote inside takes four), one space apart. */
export function listSize(flags: readonly LaunchFlag[]): number {
  return flags.flat().reduce((n, t) => n + t.length + 3 + 3 * (t.match(/'/g)?.length ?? 0), 0);
}

/** Valid flags, each once, at most MAX_FLAGS and MAX_LIST_SIZE (a flag that doesn't fit is left out). */
function cleanList(v: unknown): LaunchFlag[] {
  const out: LaunchFlag[] = [];
  for (const f of Array.isArray(v) ? v : []) {
    if (out.length >= MAX_FLAGS) break;
    if (flagError(f) !== null || out.some((x) => same(x, f as LaunchFlag))) continue;
    if (listSize([...out, f as LaunchFlag]) <= MAX_LIST_SIZE) out.push([...(f as string[])]);
  }
  return out;
}

/** From settings (whatever they contain) to valid flags, or undefined for a value that isn't an object. */
export function normalizeFlags(v: unknown): ClaudeFlags | undefined {
  if (!isObj(v)) return undefined;
  const accounts: Record<string, AccountFlags> = {};
  for (const [id, a] of Object.entries(isObj(v.accounts) ? v.accounts : {})) {
    if (!ACCOUNT_ID.test(id) || !isObj(a)) continue;
    const entry = { flags: cleanList(a.flags), shared: a.shared !== false };
    // An entry with no flags that uses the shared ones says nothing.
    if (entry.flags.length || !entry.shared) accounts[id] = entry;
  }
  return { all: cleanList(v.all), accounts };
}

/**
 * Without the entries of accounts that no longer exist. With only
 * one account left its own flags become the flags for all accounts: Settings shows no scope then, so they stay in view.
 */
export function pruneFlags(f: ClaudeFlags, ids: readonly string[]): ClaudeFlags {
  if (ids.length === 1 && f.accounts[ids[0]!]) return { all: cleanList(effectiveFlags(f, ids[0]!)), accounts: {} };
  const gone = Object.keys(f.accounts).filter((id) => !ids.includes(id));
  if (!gone.length) return f;
  return { all: f.all, accounts: Object.fromEntries(Object.entries(f.accounts).filter(([id]) => ids.includes(id))) };
}

/** An account's flags as a session starts with them: the shared ones unless it leaves them out, then its own, each once. */
export function effectiveFlags(f: ClaudeFlags, accountId: string): LaunchFlag[] {
  const own = f.accounts[accountId];
  const list = [...(own?.shared === false ? [] : f.all), ...(own?.flags ?? [])];
  return list.filter((x, i) => list.findIndex((y) => same(x, y)) === i);
}

/** Whether the flags skip permission prompts (`--dangerously-skip-permissions`, or its `=` form). */
export function skipsPermissions(flags: readonly LaunchFlag[]): boolean {
  return flags.some((f) => flagName(f[0]!) === DANGER_FLAG);
}

/** A flag shown in rose: the one that skips permissions, and the one that lets Claude switch to skipping them. */
export function isDangerFlag(f: LaunchFlag): boolean {
  const name = flagName(f[0]!);
  return name === DANGER_FLAG || name === ALLOW_DANGER_FLAG;
}

/** The flags with `~` and `~/…` (at a token's start or right after a flag's `=`) as the home folder: quoted, the shell wouldn't. */
export function expandFlags(flags: readonly LaunchFlag[], home: string): LaunchFlag[] {
  const win = pathStyle() === 'win32';
  const tilde = (s: string) => (s === '~' ? home : s.startsWith('~/') || (win && s.startsWith('~\\')) ? home + s.slice(1) : s);
  return flags.map((f) => f.map((t, i) => {
    const eq = i === 0 ? t.indexOf('=') : -1;
    return eq < 0 ? tilde(t) : t.slice(0, eq + 1) + tilde(t.slice(eq + 1));
  }));
}

/**
 * Typed text to words, as a shell splits them without expanding anything: `'…'` and `"…"` keep what is inside (no
 * escapes), and quoted and plain parts with no space between them make one word (`--x="a b"`). An unmatched quote is
 * refused (with the word it is in) rather than guessed.
 */
function splitWords(text: string): { words: string[] } | { error: 'quote'; token: string } {
  const words: string[] = [];
  let word: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) { if (word !== null) { words.push(word); word = null; } continue; }
    if (word === null) { word = ''; start = i; }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return { error: 'quote', token: text.slice(start).split(/\s/)[0]! || text.slice(start) };
      word += text.slice(i + 1, end);
      i = end;
    } else word += c;
  }
  if (word !== null) words.push(word);
  return { words };
}

/** Typed text to flags: a word starting with `-` opens a flag, the others are its values. The first problem wins. */
export function parseFlags(text: string): { flags: LaunchFlag[] } | { error: FlagError; token: string } {
  const split = splitWords(text);
  if ('error' in split) return split;
  const flags: LaunchFlag[] = [];
  for (const t of split.words) {
    if (t.startsWith('-') && !/^-+$/.test(t)) flags.push([t]);
    else if (flags.length) flags.at(-1)!.push(t);
    else return { error: 'shape', token: t };
  }
  for (const f of flags) {
    const e = flagError(f);
    if (e) return { error: e, token: f[0]! };
  }
  return { flags };
}

/** A flag as it reads in a chip: values with spaces or quotes in single quotes. */
export function flagLabel(f: LaunchFlag): string {
  return f.map((t, i) => (i > 0 && /[\s'"]/.test(t) ? `'${t.replace(/'/g, `'\\''`)}'` : t)).join(' ');
}

/** Known flags for the field's list; the one that skips permissions last (never first). */
export const SUGGESTED_FLAGS: readonly { flag: string; value?: string; hint: string }[] = [
  { flag: '--add-dir', value: '<path>', hint: 'Lets Claude read and edit another folder too.' },
  { flag: '--mcp-config', value: '<file>', hint: 'Loads MCP servers from a JSON file.' },
  { flag: '--append-system-prompt', value: '<text>', hint: 'Adds your text to the system prompt.' },
  { flag: '--allowedTools', value: '<tools>', hint: 'Tools that run without asking, e.g. "Bash(git log:*)".' },
  { flag: '--disallowedTools', value: '<tools>', hint: 'Tools Claude may never use.' },
  { flag: '--fallback-model', value: '<model>', hint: 'The model to switch to when the main one is overloaded.' },
  { flag: '--verbose', hint: 'Full turn-by-turn output.' },
  { flag: '--ide', hint: 'Connects to your IDE on start.' },
  { flag: DANGER_FLAG, hint: 'Runs every tool without asking. Only in a sandbox you trust.' }
];
