import { useEffect, useMemo } from 'react';
import { DEFAULT_ACCOUNT_ID, MAX_ACCOUNTS, accountOf, accountsFor, hasAccounts, isAccountDir, launchDir, newAccountId, normalizeAccounts, type ClaudeAccount, type ClaudeAccounts } from '@shared/claude-accounts';
import type { TerminalInfo } from '@shared/protocol';
import type { UsageEntry } from '@shared/session';
import { t } from './i18n/en';
import { usageParts } from './selectors';
import { useApp } from './store';
import { isBelow } from '@shared/paths';

/** The Claude accounts as they apply on this machine (one at the default dir is the default itself). */
export function useAccounts(): ClaudeAccounts {
  const a = useApp((s) => s.settings.claudeAccounts);
  const d = useApp((s) => s.claudeDefaultDir);
  return useMemo(() => (d ? accountsFor(a, d) : a), [a, d]);
}

/** The next account round the list (Tab: 1, Shift+Tab: -1); an id no longer listed starts from the default. */
export function cycleAccount(a: ClaudeAccounts, current: string, step: 1 | -1): string {
  const i = a.list.findIndex((x) => x.id === current);
  if (i < 0) return a.list[0]!.id;
  return a.list[(i + step + a.list.length) % a.list.length]!.id;
}

/**
 * An account's last known 5h/7d limits, from the status lines of its sessions: by its dir,
 * the default account's by the default dir (unknown until main says). None while never seen, or over.
 */
export function accountUsage(usage: readonly UsageEntry[], acc: ClaudeAccount, defaultDir: string | null, now = Date.now() / 1000): ReturnType<typeof usageParts> {
  const dir = launchDir(acc) ?? defaultDir;
  if (!dir) return [];
  return usageParts(usage.find((e) => e.configDir === dir)?.usage ?? null, now);
}

/** How a session's Claude account reads: its name and color (1–8), or an unknown dir's folder name (no color). */
export interface AccountTag { name: string; color: number | null; isDefault: boolean }

/**
 * The account a session runs as, from the config dir atelierd reports. Nothing until the
 * default dir is known (main tells it at start), so a default session never flashes as an unknown one.
 */
export function accountTag(configDir: string | undefined | null, a: ClaudeAccounts, defaultDir: string | null): AccountTag | null {
  if (!configDir || !defaultDir) return null;
  const acc = accountOf(configDir, a, defaultDir);
  if (acc) return { name: acc.name, color: acc.color, isDefault: acc.id === a.list[0]!.id };
  return { name: configDir.split('/').filter(Boolean).at(-1) ?? configDir, color: null, isDefault: false };
}

/** A row of the meter's popover: one account (or unknown dir) with live limits. */
export interface MeterAccount { dir: string; name: string; color: number | null; current: boolean; parts: ReturnType<typeof usageParts> }

/** Every account with live 5h/7d limits for the meter's popover: the accounts' order, then unknown dirs; `selected` marked. */
export function meterAccounts(usage: readonly UsageEntry[], a: ClaudeAccounts, defaultDir: string | null, selected: string | undefined, now = Date.now() / 1000): MeterAccount[] {
  if (!defaultDir) return [];
  const rank = (dir: string) => { const acc = accountOf(dir, a, defaultDir); return acc ? a.list.indexOf(acc) : a.list.length; };
  return usage.flatMap((e) => {
    const parts = e.configDir ? usageParts(e.usage, now) : [];
    const tag = accountTag(e.configDir, a, defaultDir);
    return e.configDir && tag && parts.length ? [{ dir: e.configDir, name: tag.name, color: tag.color, current: e.configDir === selected, parts }] : [];
  }).sort((x, y) => rank(x.dir) - rank(y.dir));
}

/**
 * Config dirs seen in this window's sessions that no account has and that weren't dismissed:
 * each once, with the first session seen with it. Nothing until the default dir is known.
 */
export function detectedDirs(terminals: readonly TerminalInfo[], a: ClaudeAccounts, defaultDir: string | null): { dir: string; session: string }[] {
  if (!defaultDir) return [];
  const out = new Map<string, string>();
  for (const x of terminals) {
    const dir = x.configDir;
    if (!dir || out.has(dir) || a.dismissed.includes(dir) || accountOf(dir, a, defaultDir) || !isAccountDir(dir)) continue;
    out.set(dir, x.title);
  }
  return [...out].map(([dir, session]) => ({ dir, session }));
}

/** A folder as people write it: `~/…` under the home (once known). */
export function tildeDir(dir: string, home: string | null): string {
  return home && (dir === home || isBelow(home, dir)) ? `~${dir.slice(home.length)}` : dir;
}

/**
 * An account's folder on the New Session card: `full` as Settings writes it (its tooltip), `short` keeping the last two
 * parts of a deeper one (`~/…/Claude/work`), what tells two accounts apart in a narrow card. The default's once known.
 */
export function accountFolder(acc: ClaudeAccount, defaultDir: string | null, home: string | null): { short: string; full: string } | null {
  const dir = launchDir(acc) ?? defaultDir;
  if (!dir) return null;
  const full = tildeDir(dir, home);
  const root = full.startsWith('~/') ? '~' : '';
  const parts = full.slice(root.length).split('/').filter(Boolean);
  return { short: parts.length <= 2 ? full : `${root}/…/${parts.slice(-2).join('/')}`, full };
}

/** Dirs already offered by a toast in this window: once per dir per run (Settings keeps offering them). */
const offered = new Set<string>();

/**
 * A config dir seen in a session that no account has: a toast offers it once, its action
 * opens Settings › Claude where the offer waits.
 */
export function useAccountOffers(): void {
  const accounts = useAccounts();
  const terminals = useApp((s) => s.terminals);
  const defaultDir = useApp((s) => s.claudeDefaultDir);
  const home = useApp((s) => s.home);
  // Before the settings arrive every account but the default looks unknown: nothing is offered yet.
  const loaded = useApp((s) => s.settingsLoaded);
  useEffect(() => {
    if (!loaded) return;
    for (const d of detectedDirs(terminals, accounts, defaultDir)) {
      if (offered.has(d.dir)) continue;
      offered.add(d.dir);
      useApp.getState().showToast(t.accounts.seenToast(tildeDir(d.dir, home)), { label: t.accounts.addShort, run: () => useApp.getState().setSettingsOpen('claude') }, 'info');
    }
  }, [terminals, accounts, defaultDir, home, loaded]);
}

/** A folder typed in Settings: `~` and `~/…` from the home (once known), anything else as typed. */
export function expandDir(text: string, home: string | null): string {
  const s = text.trim();
  if (!home) return s;
  return s === '~' ? home : s.startsWith('~/') ? `${home}${s.slice(1)}` : s;
}

export type AccountFormError = 'name' | 'dir' | 'default' | 'taken';

/** What is wrong with an account form, or null (editing: the account's own id; the default has no folder). */
export function accountFormError(f: { name: string; dir: string }, a: ClaudeAccounts, defaultDir: string | null, editing?: string): AccountFormError | null {
  const name = f.name.trim();
  if (!name || name.length > 40) return 'name';
  if (editing === DEFAULT_ACCOUNT_ID) return null;
  if (!isAccountDir(f.dir)) return 'dir';
  if (f.dir === defaultDir) return 'default';
  if (a.list.some((x) => x.id !== editing && x.dir === f.dir)) return 'taken';
  return null;
}

/** The accounts with one added (no `editing`) or changed; the default keeps no folder. Always normal. */
export function saveAccount(a: ClaudeAccounts, f: { name: string; dir: string; color: number }, editing?: string): ClaudeAccounts {
  const name = f.name.trim();
  const list = editing
    ? a.list.map((x) => (x.id === editing ? { ...x, name, color: f.color, dir: x.id === DEFAULT_ACCOUNT_ID ? '' : f.dir } : x))
    : [...a.list, { id: newAccountId(name, a), name, dir: f.dir, color: f.color }];
  return normalizeAccounts({ ...a, list }) ?? a;
}

/**
 * The accounts without one (never the default); new sessions go back to the default if they started with it. Its
 * folder counts as dismissed: its running sessions would otherwise offer it back at once.
 */
export function removeAccount(a: ClaudeAccounts, id: string): ClaudeAccounts {
  const gone = a.list.find((x) => x.id === id);
  if (!gone || id === DEFAULT_ACCOUNT_ID) return a;
  return normalizeAccounts({ ...a, list: a.list.filter((x) => x.id !== id), dismissed: [...a.dismissed, gone.dir] }) ?? a;
}

/** Room for another account (the default and up to 8 others). */
export function canAddAccount(a: ClaudeAccounts): boolean {
  return a.list.length < MAX_ACCOUNTS;
}

/** New Session: plain Tab picks the next account, Shift+Tab the previous; with ⌃, ⌘ or ⌥ it stays a shortcut. */
export function accountStep(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): 1 | -1 | null {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return null;
  return e.shiftKey ? -1 : 1;
}

/**
 * New Session's arrow keys on the account cards, a grid of `columns`: ←/→ the previous and next card (wrapping, as Tab),
 * ↑/↓ the one above and below (the last when the row below is shorter). Null: not an arrow, or nowhere to go.
 */
export function accountArrow(key: string, index: number, count: number, columns: number): number | null {
  if (count <= 0) return null;
  // The current one gone meanwhile (Settings in another window): from the first card.
  if (index < 0) index = 0;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'ArrowUp') return index - columns >= 0 ? index - columns : null;
  if (key === 'ArrowDown') return (Math.floor(index / columns) + 1) * columns < count ? Math.min(index + columns, count - 1) : null;
  return null;
}

/** The offer to add a dir as an account, dismissed for good. */
export function dismissDir(a: ClaudeAccounts, dir: string): ClaudeAccounts {
  return normalizeAccounts({ ...a, dismissed: [...a.dismissed, dir] }) ?? a;
}

/** A row of a task's account step in the palette: the account, and its last known limits or else its folder. */
export interface AccountChoice { id: string; name: string; color: number; hint: string }

/**
 * A task's account step: every account in the Settings order, each hinted by its last
 * known 5h/7d limits (what picking an account is for) or, never seen, its folder; `initial` is the row of the account
 * set for new sessions (the first when it is no longer listed).
 */
export function accountChoices(a: ClaudeAccounts, usage: readonly UsageEntry[], defaultDir: string | null, home: string | null, now = Date.now() / 1000): { rows: AccountChoice[]; initial: number } {
  const rows = a.list.map((acc) => {
    const parts = accountUsage(usage, acc, defaultDir, now);
    const hint = parts.length ? parts.map((p) => `${p.key} ${p.pct}%`).join(' · ') : accountFolder(acc, defaultDir, home)?.short ?? '';
    return { id: acc.id, name: acc.name, color: acc.color, hint };
  });
  return { rows, initial: Math.max(0, a.list.findIndex((x) => x.id === a.newSession)) };
}

/** Palette: one "New session as <account>" per Claude account, only with two or more. */
export function paletteAccountCommands(a: ClaudeAccounts): { key: string; label: string; account: string; color: number }[] {
  if (!hasAccounts(a)) return [];
  return a.list.map((x) => ({ key: `new-session-account:${x.id}`, label: t.cmd.newSessionAs(x.name), account: x.id, color: x.color }));
}
