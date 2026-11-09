// Scheduled prompts' actions in the renderer: the composer's opening, delete with Undo, Send
// Now, the news toasts. atelierd owns the list; every change goes through main and comes back in the next list.
import type { ScheduleResult } from '@shared/api';
import type { ScheduleNotice } from '@shared/schedule-notices';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import type { Usage, UsageEntry } from '@shared/session';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { visibleKeys, type Split } from './split';
import { t } from './i18n/en';
import { clockOf, dayLabel, reasonText } from './schedule-view';
import { copyText } from './clipboard';

const st = () => useApp.getState();

/** Why that terminal can't take a scheduled prompt now (atelierd without the feature, not a Claude session), or null. */
export function scheduleBlock(term: TerminalInfo | undefined): string | null {
  if (!st().daemon.schedulesAvailable) return t.sched.unavailable;
  if (!term?.session) return t.sched.notClaude;
  return null;
}

/** The limits of a terminal's Claude account (its config dir's entry; an older atelierd's single one). */
export function usageOf(term: TerminalInfo | undefined, list: readonly UsageEntry[]): Usage | null {
  const dir = term?.configDir ?? null;
  return list.find((e) => e.configDir === dir)?.usage ?? list.find((e) => e.configDir === null)?.usage ?? null;
}

/** Opens the composer for a session (Schedule Prompt…), maybe with text (Send Later to…). */
export function openScheduleSheet(terminalId: string, text?: string): void {
  const term = st().terminals.find((x) => x.id === terminalId);
  const why = scheduleBlock(term);
  if (why) { st().showToast(why); return; }
  st().setScheduleSheet({ terminalId, ...(text ? { text } : {}) });
}

/** File › Schedule Prompt… (⌘⌥↵), the palette: the session in front (selected, or the focused split pane's). */
export function scheduleSelected(): void {
  const s = st();
  const pane = s.split.panes.length > 1 ? s.split.panes[s.split.focus]?.front ?? null : null;
  const id = pane?.startsWith('t:') ? pane.slice(2) : s.selectedId;
  if (!id) { s.showToast(t.sched.notClaude); return; }
  openScheduleSheet(id);
}

/** The composer on a prompt to edit (its session, its text and time). */
export function editSchedule(p: ScheduledPrompt): void {
  st().setScheduleSheet({ terminalId: p.terminalId, editId: p.id });
}

/** A refusal in words (a toast); true when it went through. */
export function reportResult(r: ScheduleResult): boolean {
  if (r.ok) return true;
  st().showToast(t.sched.errors[r.error] ?? t.sched.errors.fallback!);
  return false;
}

const call = (p: Promise<ScheduleResult>) => p.catch((): ScheduleResult => ({ ok: false, error: 'fallback' }));

/** Delete, with Undo in its toast (a prompt is cheap to write again, but it's still yours). */
export async function deleteSchedule(p: ScheduledPrompt): Promise<void> {
  if (!reportResult(await call(window.atelier.schedules.remove(p.id)))) return;
  st().showToast(t.sched.deleted, { label: t.sched.undo, run: () => void call(window.atelier.schedules.restore(p)).then(reportResult) }, 'info');
}

export async function fireSchedule(id: string, force?: 'usage'): Promise<void> {
  reportResult(await call(window.atelier.schedules.fire(id, force)));
}

export async function snoozeSchedule(id: string, minutes = 10): Promise<void> {
  reportResult(await call(window.atelier.schedules.snooze(id, minutes)));
}

export function copySchedule(p: ScheduledPrompt): void {
  void copyText(p.text);
}

/** The session a prompt belongs to, selected (Show). */
export function showScheduleSession(p: ScheduledPrompt): void {
  const s = st();
  if (!s.terminals.some((x) => x.id === p.terminalId)) return;
  s.setActivity('sessions', { keepHidden: true });
  s.select(p.terminalId);
}

/** That terminal is on screen in this window: the selected tab, or a split pane. */
export function terminalShown(s: { activeTab: string; selectedId: string | null; split: Split }, id: string): boolean {
  if (s.split.panes.length > 1) return visibleKeys(s.split).includes(`t:${id}`);
  return s.activeTab === 'term' && s.selectedId === id;
}

/**
 * The countdown's routing in this window: a prompt of this project that just armed counts down here when
 * the window is focused and shows its session; a focused window that doesn't show it sends it at once. Unfocused
 * windows leave it alone (main fires it when no window of the project is focused; atelierd sends it at the end of the
 * countdown anyway). Returns the unsubscribe.
 */
export function installScheduleRouting(focused: () => boolean = () => document.hasFocus()): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.schedules === prev.schedules || s.popout || !s.project) return;
    const was = new Set(prev.schedules.filter((x) => x.status === 'armed').map((x) => x.id));
    const now = Date.now();
    for (const p of s.schedules) {
      if (p.status !== 'armed' || was.has(p.id) || p.fired || (p.armedUntil ?? 0) <= now || p.projectRoot !== s.project.root) continue;
      // Only the focused window decides: an unfocused one may sit beside the one counting down (main fires the prompt
      // when no window of the project is focused).
      if (focused() && !terminalShown(s, p.terminalId)) void fireSchedule(p.id);
    }
  });
}

/** A prompt of this project sent, skipped, missed or moved: one toast, with Show. */
export function scheduleNoticeToast(n: ScheduleNotice): void {
  const p = n.prompt;
  const name = st().terminals.find((x) => x.id === p.terminalId)?.title ?? p.title;
  const text = n.kind === 'sent' ? t.sched.notice.sent(name)
    : n.kind === 'moved' ? t.sched.notice.moved(`${dayLabel(p.at, Date.now()) === t.sched.today ? '' : `${dayLabel(p.at, Date.now())} `}${clockOf(p.at)}`)
    : n.kind === 'missed' ? t.sched.notice.missed(reasonText(p.reason))
    : t.sched.notice.skipped(reasonText(p.reason));
  st().showToast(text, { label: t.sched.show, run: () => showScheduleSession(p) }, n.kind === 'sent' ? 'info' : undefined);
}
