import { basename } from 'node:path';
import type { TerminalInfo } from '@shared/protocol';
import { isLimitPaused, isWaiting } from '@shared/session-view';
import { effectiveState } from '@shared/background';

export interface DockEntry { id: string; projectRoot: string; kind: 'waiting' | 'error' | 'done'; label: string }

const MAX = 8;
// No control or format characters (bidi, line separators): the title may come from repo content.
export const clean = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim();
// Cut by characters, not UTF-16 units: an emoji is never split.
export const short = (s: string, n: number) => { const c = Array.from(s); return c.length > n ? `${c.slice(0, n - 1).join('')}…` : s; };

export type AttentionKind = DockEntry['kind'];

/**
 * The sessions to look at, most urgent first: waiting for you (the longest wait first), then stopped by an error, then
 * finished, not yet seen (the most recent first). The Dock menu, the Jump List and the tray icons read this one rule.
 */
export function pickAttention(list: TerminalInfo[]): { term: TerminalInfo; kind: AttentionKind }[] {
  const pick = (kind: AttentionKind) => list
    // The effective state: a done session whose background work counts is still working.
    // A session paused at a usage limit waits for Claude Code's continuation: nothing to look at yet.
    .filter((t) => (kind === 'waiting' ? isWaiting(t.session) : effectiveState(t) === kind && t.session!.unread && !isLimitPaused(t.session)))
    // Whoever has waited longest is the most urgent; among errors and finished ones the most recent counts.
    .sort((a, b) => (kind === 'waiting' ? a.session!.updatedAt - b.session!.updatedAt : b.session!.updatedAt - a.session!.updatedAt))
    .map((term) => ({ term, kind }));
  return [...pick('waiting'), ...pick('error'), ...pick('done')];
}

/** A project's folder name, for menus. */
export const folderName = (projectRoot: string): string => clean(basename(projectRoot));

/** A session's label in menus: its title and project folder, cleaned (the title may come from repo content). */
export function attentionLabel(t: TerminalInfo): string {
  return `${short(clean(t.title), 48)} · ${folderName(t.projectRoot)}`;
}

function eligible(list: TerminalInfo[]): DockEntry[] {
  return pickAttention(list).map(({ term: t, kind }): DockEntry => ({ id: t.id, projectRoot: t.projectRoot, kind, label: attentionLabel(t) }));
}

/** Dock menu entries: sessions waiting for you, then stopped by an error, then finished, not yet seen (all projects). */
export function dockEntries(list: TerminalInfo[]): DockEntry[] {
  return eligible(list).slice(0, MAX);
}

/** How many sessions to look at stay out of the menu (the "+N more" row, which jumps to the next one with ⌘J). */
export function dockOverflow(list: TerminalInfo[]): number {
  return Math.max(0, eligible(list).length - MAX);
}
