// Ask companion: what asks for your attention around a session's Ask — the
// card while the session needs you, the usage limit item, the ended note, the sidebar mark and the palette's hints.
// Pure: the panel, the row and the palette only render these.
import type { TerminalInfo } from '@shared/protocol';
import type { UsageEntry } from '@shared/session';
import { waitKind, waitTarget, type WaitKind } from '@shared/session-view';
import { accountById, accountOf, launchDir, type ClaudeAccount, type ClaudeAccounts } from '@shared/claude-accounts';
import type { LimitWindow, Thread, ThreadItem } from '@shared/companion/types';
import { splitPath } from '@shared/paths';
// Not accounts.ts' accountUsage: that module holds hooks on the store, and the store's slice uses this one.
import { usageParts } from '../selectors';
import { clockTime } from '../work-view';
import { visibleKeys, type Split } from '../split';
import type { TabKey } from '../tabs-model';
import { t } from '../i18n/en';

type ErrorEntry = Extract<ThreadItem, { kind: 'error' }>;

/** The terminals whose tab is on screen in this window's layout: every pane of a split, else the one in front. */
export function shownIn(st: { split: Split; activeTab: string; selectedId: string | null; activeKey(): TabKey | null }): Set<string> {
  const keys = st.split.panes.length > 1 ? visibleKeys(st.split) : st.activeTab === 'term' && st.selectedId ? [`t:${st.selectedId}`] : [];
  return new Set(keys.filter((k): k is string => !!k?.startsWith('t:')).map((k) => k.slice(2)));
}

/**
 * The terminal's tab lives in another window: a pop-out's, seen from the main window, or any but a
 * pop-out's own tab, seen from that pop-out. Its Ask is hosted there, never here.
 */
export function livesElsewhere(st: { poppedOut: readonly string[]; popout: { key: string } | null }, terminalId: string): boolean {
  const key = `t:${terminalId}`;
  return st.popout ? st.popout.key !== key : st.poppedOut.includes(key);
}

/** The bound conversation is over: Claude exited, the terminal runs another one (after /clear), or it is gone. */
export function sessionEnded(term: TerminalInfo | undefined, sessionId: string): boolean {
  return !term || term.session?.sessionId !== sessionId;
}

export interface NeedsYou { kind: 'question' | 'permission'; title: string; line: string | null }

/**
 * The card pinned above the thread while the bound session waits for you: a permission (with what
 * for, the session bar's line) or a question (an atelierd without states2 doesn't say which: a question). Nothing
 * while it works, sits at its prompt or stopped on an error, and nothing for another conversation.
 */
export function needsYou(term: TerminalInfo | undefined, sessionId: string): NeedsYou | null {
  const s = term?.session;
  if (!term || !s || s.sessionId !== sessionId) return null;
  const kind = waitKind(s);
  if (!kind) return null;
  const permission = kind === 'permission';
  return { kind: permission ? 'permission' : 'question', title: permission ? t.companion.needsPermission(term.title) : t.companion.isAsking(term.title), line: waitTarget(s.activity) };
}

/** Help me decide's question: the run finds what the session asks in its chat. */
export function helpDecideQuestion(title: string): string {
  return t.companion.helpDecideQuestion(title);
}

/** "Personal hit its 5-hour limit" (the weekly one, or just its usage limit when Claude didn't say which). */
export function limitTitle(account: string, window: LimitWindow | undefined): string {
  return t.companion.limitTitle(account, window);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A reset time as the item says it: "14:10" today, "Tue 09:05" another day (a weekly limit). Local, 24 h. */
export function resetClock(ms: number, now: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date(now).toDateString() ? clockTime(ms) : `${DAYS[d.getDay()]} ${clockTime(ms)}`;
}

/** "It resets at 14:10. auth-refactor keeps working; only Ask is paused." (the reset left out when unknown). */
export function limitBody(o: { resetMs: number | null; title: string; now: number }): string {
  const paused = t.companion.onlyAskPaused(o.title);
  if (o.resetMs === null) return paused;
  const clock = resetClock(o.resetMs, o.now);
  return `${o.resetMs > o.now ? t.companion.resets(clock) : t.companion.reset(clock)} ${paused}`;
}

/** Asking the very second it resets could still be refused: a few seconds after it. */
export const ASK_AT_GRACE_MS = 3000;
/** The longest a browser timer waits (2^31 − 1 ms, about 24.8 days); later than that, no Ask at. */
const TIMER_MAX = 2 ** 31 - 1;

/** A wait for a reset is checked at least this often: a sleeping Mac runs a long timer late (minute.ts' rule). */
export const WAKE_STEP_MS = 60_000;

/** How long to sleep before checking a wait for `at` again: the rest, at most a minute; null once it is due. */
export function wakeIn(at: number, now: number): number | null {
  return at <= now ? null : Math.min(WAKE_STEP_MS, at - now);
}

/** Ask at HH:MM: how long until it asks again, from the limit's reset (epoch seconds); null: no such button. */
export function askAtDelay(resetsAt: number | undefined, now: number): number | null {
  if (resetsAt === undefined) return null;
  const ms = resetsAt * 1000 - now;
  if (ms <= 0 || ms + ASK_AT_GRACE_MS > TIMER_MAX) return null;
  return ms + ASK_AT_GRACE_MS;
}

/**
 * The account that answers the thread (and so the one that hit a limit): its choice, or the session's own for
 * 'session' — by the session's config dir, the default account while that isn't known (as main runs it). A dir no
 * account has is named by its folder, as the session's account chip does.
 */
export function askAccount(choice: string, sessionDir: string | null, accounts: ClaudeAccounts, defaultDir: string | null): { account: ClaudeAccount | null; name: string } {
  if (choice !== 'session') {
    const acc = accountById(accounts, choice);
    return { account: acc, name: acc?.name ?? choice };
  }
  if (!sessionDir) return { account: accounts.list[0]!, name: accounts.list[0]!.name };
  const acc = defaultDir ? accountOf(sessionDir, accounts, defaultDir) : null;
  return { account: acc, name: acc?.name ?? (splitPath(sessionDir).filter(Boolean).at(-1) ?? sessionDir) };
}

/**
 * The account a limit item is about: the one its run used (main records it), so an older item keeps naming it after the
 * thread moves to another account; an item saved before that names the thread's account now (`current`).
 */
export function limitedBy(item: ErrorEntry, current: string, sessionDir: string | null, accounts: ClaudeAccounts, defaultDir: string | null): { account: ClaudeAccount | null; name: string } {
  return askAccount(item.account ?? current, sessionDir, accounts, defaultDir);
}

/** An account at 100% of one of its live windows (its sessions' status lines say so), as the usage meter reads it. */
function atLimit(usage: readonly UsageEntry[], acc: ClaudeAccount, defaultDir: string | null, nowSec: number): boolean {
  const dir = launchDir(acc) ?? defaultDir;
  return !!dir && usageParts(usage.find((e) => e.configDir === dir)?.usage ?? null, nowSec).some((p) => p.pct >= 100);
}

/**
 * Ask with <other account>: the first configured account, in Settings' order, other than the one that hit
 * its limit and not at its own; none with a single account.
 */
export function otherAccount(accounts: ClaudeAccounts, usage: readonly UsageEntry[], current: ClaudeAccount | null, defaultDir: string | null, nowSec = Date.now() / 1000): ClaudeAccount | null {
  if (accounts.list.length < 2) return null;
  return accounts.list.find((a) => a.id !== current?.id && !atLimit(usage, a, defaultDir, nowSec)) ?? null;
}

/**
 * The thread's latest outcome, when it is a usage limit that hasn't reset yet (or whose reset is unknown): the composer
 * shows its account at 100%. A question asked since doesn't lift it; an answer, a Catch me up or another error does.
 */
export function activeLimit(thread: Thread | null, now: number): ErrorEntry | null {
  const last = thread?.items.findLast((i) => i.kind !== 'question');
  if (last?.kind !== 'error' || last.reason !== 'limit') return null;
  return last.resetsAt === undefined || last.resetsAt * 1000 > now ? last : null;
}

/**
 * The palette's hint on an "Ask about" row, one by priority: an answer you haven't seen (violet),
 * the session waiting for you (amber), working; nothing at rest.
 */
export function askHint(o: { unseen: boolean; wait: WaitKind | null; working: boolean }): { text: string; tone: 'ask' | 'waiting' | null } | null {
  const h = t.companion.hint;
  if (o.unseen) return { text: h.answer, tone: 'ask' };
  if (o.wait) return { text: h[o.wait], tone: 'waiting' };
  return o.working ? { text: h.working, tone: null } : null;
}

/** The sidebar's Ask mark: an outcome not seen yet, unless its panel is open and on screen. */
export function askMarked(o: { unseen: boolean; open: boolean; shown: boolean }): boolean {
  return o.unseen && !(o.open && o.shown);
}
