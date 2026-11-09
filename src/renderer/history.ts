import type { Resumable } from '@shared/protocol';
import { HISTORY_LIMIT, type ClaudeConversation } from '@shared/history';
import { textFilter } from '@shared/fuzzy';
import { resumablesFor } from './selectors';
import { useApp } from './store';
import { t } from './i18n/en';

// The palette's resume: list — Atelier sessions left without a process, then Claude Code's own conversations.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now", "5m ago", "3h ago", "2d ago", "2w ago", then "Jul 4" ("Jul 4, 2025" in another year). */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  if (s < 35 * 86400) return `${Math.floor(s / (7 * 86400))}w ago`;
  const d = new Date(at);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${d.getFullYear()}`;
}

/** Atelier's resumable sessions of the project, then the other conversations (by session id), each newest first. */
export function resumeList(resumables: Resumable[], history: ClaudeConversation[], projectRoot: string): { sessions: Resumable[]; conversations: ClaudeConversation[] } {
  const sessions = resumablesFor(resumables, projectRoot);
  const known = new Set(sessions.map((r) => r.sessionId));
  const conversations = history.filter((c) => !known.has(c.sessionId)).sort((a, b) => b.at - a.at);
  return { sessions, conversations };
}

/**
 * Free-text search over title, first prompt, branch and folder (textScore: every word of the query, close-knit, in some
 * field; the title counts most); an empty query keeps the order, and so do equal matches (newest first).
 * Every conversation the main process sends (at most HISTORY_LIMIT) is listed: 200 plain rows render quickly.
 */
export function searchConversations(list: ClaudeConversation[], query: string, folderOf: (c: ClaudeConversation) => string | null, limit = HISTORY_LIMIT): ClaudeConversation[] {
  return textFilter(list, query, (c) => [c.title, c.prompt, c.branch, folderOf(c)], limit);
}

/** A conversation from Claude's history in a new session (`claude --resume`), shown right away from the reply. */
export async function resumeConversation(sessionId: string, account?: string): Promise<void> {
  const { size, space, popout } = useApp.getState();
  // Asked for: Sessions comes forward now; left meanwhile, it lands there without pulling them back.
  if (!popout && space !== 'sessions') useApp.getState().switchSpace('sessions');
  try {
    useApp.getState().launched(await window.atelier.claude.resume(sessionId, size.cols || 120, size.rows || 36, account));
  } catch {
    useApp.getState().showToast(t.cannotResume);
  }
  void refreshHistory();
}

/** Something to resume in this project: an Atelier session or a conversation from Claude's history. */
export function hasSomethingToResume(): boolean {
  const s = useApp.getState();
  if (!s.project) return false;
  const r = resumeList(s.resumables, s.history, s.project.root);
  return r.sessions.length + r.conversations.length > 0;
}

/** A row's hint: "active now" when its file changed in the last minute (it may run outside Atelier), else the time. */
export function conversationHint(c: ClaudeConversation, now: number): { text: string; active: boolean } {
  return c.active ? { text: t.historyActive, active: true } : { text: relativeTime(c.at, now), active: false };
}

/** resume: with nothing to list: a loading line until Claude's history first answers (no empty state flash). */
export function resumeEmptyText(loaded = useApp.getState().historyLoaded): string {
  return loaded ? t.paletteNoResume : t.paletteLoadingHistory;
}

/** Re-reads the project's conversations from Claude's history (cheap after the first time: the main process caches). */
export async function refreshHistory(): Promise<ClaudeConversation[]> {
  const list = await window.atelier.claude.history().catch(() => null);
  // A failed read answers too: what is known stays, and the loading state ends.
  useApp.getState().setHistory(list ?? useApp.getState().history);
  return useApp.getState().history;
}
