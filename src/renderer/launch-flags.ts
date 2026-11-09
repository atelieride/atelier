import { accountById, hasAccounts, type ClaudeAccounts } from '@shared/claude-accounts';
import { MAX_FLAGS, MAX_LIST_SIZE, SUGGESTED_FLAGS, effectiveFlags, flagName, listSize, normalizeFlags, parseFlags, skipsPermissions, type ClaudeFlags, type FlagError, type LaunchFlag } from '@shared/claude-flags';
import { useApp } from './store';

// Settings › Claude › Launch flags: the edits as pure steps on the setting, always in
// normalizeFlags' form (main's schema takes nothing else). The command preview is main's (claude.launchPreview).

/** 'all' (the flags for all accounts) or an account's id. */
export type FlagScope = string;
export type AddError = FlagError | 'dup' | 'full' | 'empty' | 'size';

const same = (a: LaunchFlag, b: LaunchFlag) => a.length === b.length && a.every((t, i) => t === b[i]);
const norm = (f: ClaudeFlags): ClaudeFlags => normalizeFlags(f)!;

/** A scope still worth showing: an account that is gone, or the only one there is, is all accounts. */
export function scopeOf(scope: FlagScope, accounts: ClaudeAccounts): FlagScope {
  return scope !== 'all' && hasAccounts(accounts) && accountById(accounts, scope) ? scope : 'all';
}

/** The scope's own flags (an account's without the shared ones). */
export function scopeFlags(f: ClaudeFlags, scope: FlagScope): LaunchFlag[] {
  return scope === 'all' ? f.all : f.accounts[scope]?.flags ?? [];
}

function withScopeFlags(f: ClaudeFlags, scope: FlagScope, flags: LaunchFlag[]): ClaudeFlags {
  if (scope === 'all') return norm({ ...f, all: flags });
  return norm({ ...f, accounts: { ...f.accounts, [scope]: { flags, shared: f.accounts[scope]?.shared ?? true } } });
}

/** Typed text added to the scope, or why not (with the token it is about). */
export function addTyped(f: ClaudeFlags, scope: FlagScope, text: string): { next: ClaudeFlags } | { error: AddError; token: string } {
  const r = parseFlags(text);
  if ('error' in r) return r;
  if (!r.flags.length) return { error: 'empty', token: '' };
  const list = scopeFlags(f, scope);
  const dup = r.flags.find((x, i) => list.some((y) => same(x, y)) || r.flags.findIndex((y) => same(x, y)) < i);
  if (dup) return { error: 'dup', token: dup[0]! };
  if (list.length + r.flags.length > MAX_FLAGS) return { error: 'full', token: r.flags[0]![0]! };
  if (listSize([...list, ...r.flags]) > MAX_LIST_SIZE) return { error: 'size', token: r.flags[0]![0]! };
  return { next: withScopeFlags(f, scope, [...list, ...r.flags]) };
}

export function removeAt(f: ClaudeFlags, scope: FlagScope, index: number): ClaudeFlags {
  return withScopeFlags(f, scope, scopeFlags(f, scope).filter((_, i) => i !== index));
}

/** Whether an account also uses the flags for all accounts. */
export function withShared(f: ClaudeFlags, id: string, shared: boolean): ClaudeFlags {
  return norm({ ...f, accounts: { ...f.accounts, [id]: { flags: f.accounts[id]?.flags ?? [], shared } } });
}

/** What a badge says about an account's flags. */
export function flagSummary(flags: readonly LaunchFlag[]): { count: number; danger: boolean } {
  return { count: flags.length, danger: skipsPermissions(flags) };
}

/** Known flags for the field: those not in the list yet (a flag with a value can be there more than once). */
export function suggestionsFor(list: readonly LaunchFlag[], draft: string) {
  const q = (draft.trim().split(/\s+/)[0] ?? '').toLowerCase();
  return SUGGESTED_FLAGS.filter((s) => (s.value || !list.some((f) => flagName(f[0]!) === s.flag)) && s.flag.toLowerCase().includes(q));
}

/** The accounts whose sessions skip permissions (Permission mode doesn't apply to them): all of them, some, or none. */
export function permissionOverride(f: ClaudeFlags, accounts: ClaudeAccounts): { all: true } | { names: string[] } | null {
  const skip = accounts.list.filter((a) => skipsPermissions(effectiveFlags(f, a.id)));
  return !skip.length ? null : skip.length === accounts.list.length ? { all: true } : { names: skip.map((a) => a.name) };
}

/** Settings › Claude on a scope's flags: the account badge, its menu, New Session's Edit…, the palette. */
export function openLaunchFlags(scope: FlagScope = 'all'): void {
  const st = useApp.getState();
  st.setLaunchFlagsScope(scope);
  st.setSettingsOpen('claude');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>('.lf-section');
    el?.scrollIntoView({ block: 'start' });
    el?.querySelector<HTMLInputElement>('.lf-input')?.focus();
  }));
}
