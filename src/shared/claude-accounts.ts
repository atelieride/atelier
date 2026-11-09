/**
 * Claude accounts: a name, a Claude config dir (`CLAUDE_CONFIG_DIR`) and a color. The first
 * one is always the default account: whatever `claude` uses with no `CLAUDE_CONFIG_DIR` (its `dir` is ''). Pure:
 * main knows the real default dir and passes it where it matters.
 */
import { isCleanAbsPath, samePath } from './paths';

export interface ClaudeAccount { id: string; name: string; dir: string; color: number }
export interface ClaudeAccounts { list: ClaudeAccount[]; newSession: string; dismissed: string[] }

export const DEFAULT_ACCOUNT_ID = 'default';
/** The default and up to 8 others. */
export const MAX_ACCOUNTS = 9;
export const MAX_DISMISSED = 32;
/** Session person colors (`--person-1..8`). */
export const ACCOUNT_COLORS = 8;
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_MAX = 40;

export const DEFAULT_ACCOUNTS: ClaudeAccounts = { list: [{ id: DEFAULT_ACCOUNT_ID, name: 'Claude', dir: '', color: 1 }], newSession: DEFAULT_ACCOUNT_ID, dismissed: [] };

/** A Claude account's config dir: a clean absolute path (not used as a callback with an index: style is the platform's). */
export const isAccountDir = (p: unknown): p is string => isCleanAbsPath(p);

/** One line, trimmed, 1–40 characters; else null. */
function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return n && n.length <= NAME_MAX ? n : null;
}

const colorOf = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ACCOUNT_COLORS ? v : 1);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** From settings (whatever they contain) to valid accounts, or undefined for a value that isn't one. */
export function normalizeAccounts(v: unknown): ClaudeAccounts | undefined {
  if (!isObj(v)) return undefined;
  const raw = Array.isArray(v.list) ? v.list.filter(isObj) : [];
  const rawDefault = raw.find((a) => a.id === DEFAULT_ACCOUNT_ID);
  const first = DEFAULT_ACCOUNTS.list[0]!;
  const list: ClaudeAccount[] = [{ ...first, name: cleanName(rawDefault?.name) ?? first.name, color: rawDefault ? colorOf(rawDefault.color) : first.color }];
  const ids = new Set([DEFAULT_ACCOUNT_ID]);
  const dirs = new Set<string>();
  for (const a of raw) {
    if (list.length >= MAX_ACCOUNTS) break;
    const name = cleanName(a.name);
    if (typeof a.id !== 'string' || !ACCOUNT_ID.test(a.id) || ids.has(a.id) || !name || !isAccountDir(a.dir) || dirs.has(a.dir)) continue;
    ids.add(a.id); dirs.add(a.dir);
    list.push({ id: a.id, name, dir: a.dir, color: colorOf(a.color) });
  }
  const newSession = typeof v.newSession === 'string' && ids.has(v.newSession) ? v.newSession : DEFAULT_ACCOUNT_ID;
  const dismissed = Array.isArray(v.dismissed) ? [...new Set(v.dismissed.filter(isAccountDir))].slice(0, MAX_DISMISSED) : [];
  return { list, newSession, dismissed };
}

/** The accounts as they apply on this machine: one at the default dir is the default itself, so it's dropped. */
export function accountsFor(a: ClaudeAccounts, defaultDir: string): ClaudeAccounts {
  const list = a.list.filter((x, i) => i === 0 || !samePath(x.dir, defaultDir));
  return list.length === a.list.length ? a : { ...a, list, newSession: list.some((x) => x.id === a.newSession) ? a.newSession : DEFAULT_ACCOUNT_ID };
}

/** More than the default account: only then does account UI show up. */
export function hasAccounts(a: ClaudeAccounts): boolean {
  return a.list.length > 1;
}

/** The account a session's config dir belongs to (exact match), or null for an unknown or missing dir. */
export function accountOf(configDir: string | undefined | null, a: ClaudeAccounts, defaultDir: string): ClaudeAccount | null {
  if (!configDir) return null;
  // Windows: one folder in any case and either separator (samePath is === on macOS).
  if (samePath(configDir, defaultDir)) return a.list[0]!;
  return a.list.find((x, i) => i > 0 && samePath(x.dir, configDir)) ?? null;
}

export function accountById(a: ClaudeAccounts, id: string | undefined): ClaudeAccount | null {
  return id === undefined ? null : a.list.find((x) => x.id === id) ?? null;
}

/** The `CLAUDE_CONFIG_DIR` to launch with: none for the default account. */
export function launchDir(acc: ClaudeAccount): string | undefined {
  return acc.id === DEFAULT_ACCOUNT_ID || !acc.dir ? undefined : acc.dir;
}

/** The account a new session starts with: the one named (unknown ids refused), else the one set for new sessions.
 * Main's and the live demo's. */
export function launchAccount(a: ClaudeAccounts, id: string | undefined): { account: ClaudeAccount; dir: string | undefined } {
  const account = id === undefined ? accountById(a, a.newSession) ?? a.list[0]! : accountById(a, id);
  if (!account) throw new Error('unknown Claude account');
  return { account, dir: launchDir(account) };
}

/** A slug of the name, unique among the accounts ("Work · Team" → "work-team", a taken "ops" → "ops-2"). */
export function newAccountId(name: string, a: ClaudeAccounts): string {
  const base = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'account';
  const taken = new Set(a.list.map((x) => x.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A readable name from a config folder: `.claude_ops` → "Ops", `claude-work` → "Work", `.config/claude` → "Claude". */
export function nameFromDir(dir: string): string {
  const base = dir.split('/').filter(Boolean).at(-1) ?? '';
  const words = base.replace(/^\.+/, '').replace(/^claude(?:[-_]|$)/i, '').split(/[-_]+/).filter(Boolean).join(' ');
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Claude';
}
