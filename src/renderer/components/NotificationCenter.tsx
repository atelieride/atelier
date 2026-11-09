import { useEffect, useLayoutEffect, useRef } from 'react';
import { noteDays, unreadNotes, type NoteEntry } from '@shared/notifications';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { relativeTime } from '../history';
import { noteDetail, noteTitle } from '../notes';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { containerOf, openContainer } from '../docker/actions';
import { openQueue } from '../redis/actions';
import { useRedis } from '../redis/store';

const STATE = { waiting: 'waiting', done: 'done', error: 'error', trigger: null, container: null, job: null } as const;

function Entry({ e, alive }: { e: NoteEntry; alive: boolean }) {
  const first = e.sessions[0]!;
  const group = e.sessions.length > 1;
  const title = noteTitle(e, t.notes.group, t.notes.trigger);
  const detail = noteDetail(e, t.notes.kind);
  const open = () => {
    const st = useApp.getState();
    st.noteOpened(e.id);
    st.setNotesOpen(false);
    if (e.container) {
      // A failed container: its Inspect ("Why it stopped"), or its logs when it is unhealthy.
      if (!containerOf(e.container.id)) { st.showToast(t.notes.containerGone); return; }
      openContainer(e.container.id, e.container.reason === 'unhealthy' ? 'logs' : 'inspect');
      return;
    }
    if (e.job) {
      // A failed job: its queue's failed jobs.
      const job = e.job;
      if (!useRedis.getState().status?.queues?.some((q) => q.id === job.queue)) { st.showToast(t.notes.queueGone); return; }
      st.subjectSeen(e.sessions[0]!.id);
      openQueue(job.queue, 'failed');
      return;
    }
    const target = e.sessions.find((s) => e.unseen.includes(s.id) && st.terminals.some((x) => x.id === s.id)) ?? e.sessions.find((s) => st.terminals.some((x) => x.id === s.id));
    if (!target) { st.showToast(t.notes.gone); return; }
    st.setActivity('sessions', { keepHidden: true });
    st.select(target.id);
  };
  return (
    <div role="listitem">
    <button type="button" className={`note-row kind-${e.kind} ${e.unseen.length ? 'is-unread' : ''} ${alive ? '' : 'is-gone'}`} onClick={open}>
      <span className="note-avatar">
        {e.kind === 'container'
          ? <span className="note-whale" aria-hidden="true"><Icon name="whale" size={15} /></span>
          : e.kind === 'job' ? <span className="note-whale note-redis" aria-hidden="true"><Icon name="redis" size={15} /></span>
          : <Avatar title={first.title} color={first.color} state={STATE[e.kind]} size={24} />}
        {group && <span className="note-more mono">+{e.sessions.length - 1}</span>}
        {e.kind === 'trigger' && <span className="note-bolt"><Icon name="bolt" size={9} stroke={2.2} /></span>}
      </span>
      <span className="note-main">
        <span className="note-title">{title}{e.count && e.count > 1 ? <span className="note-count mono" aria-label={t.notes.matches(e.count)} title={t.notes.matches(e.count)}>×{e.count}</span> : null}</span>
        <span className="note-detail" title={e.kind === 'trigger' ? detail : undefined}>{detail}</span>
      </span>
      <span className="note-time mono">{relativeTime(e.at, Date.now())}</span>
    </button>
    </div>
  );
}

/** The bell's popover: entries newest first by day; click or Enter opens the session. */
export function NotificationCenter() {
  const notes = useApp((s) => s.notes);
  const triggersOnly = useApp((s) => s.notesFilter === 'triggers');
  const shown = triggersOnly ? notes.filter((e) => e.kind === 'trigger') : notes;
  const terminals = useApp((s) => s.terminals);
  const box = useRef<HTMLDivElement>(null);
  const close = () => useApp.getState().setNotesOpen(false);
  const alive = new Set(terminals.map((x) => x.id));

  // Focus on the newest entry (or the panel); back where it was when the popover closes, unless something took it.
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (box.current?.querySelector<HTMLElement>('.note-row') ?? box.current)?.focus();
    return () => {
      const now = document.activeElement;
      if (before && before.isConnected && (!now || now === document.body)) before.focus();
    };
  }, []);

  useEffect(() => {
    // The bell toggles by itself: a press on it is not "outside".
    const down = (ev: MouseEvent) => { const el = ev.target as Element | null; if (!box.current?.contains(el) && !el?.closest?.('.bell-btn')) close(); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('blur', close); };
  }, []);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    // Esc: closed, and the keyboard goes back to the bell (where the popover hangs from).
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); document.querySelector<HTMLElement>('.bell-btn')?.focus(); close(); return; }
    // Tab cycles inside the popover: focus never wanders behind it while it is open.
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, [tabindex]:not([tabindex="-1"])') ?? [])];
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === -1 || i === items.length - 1 ? 0 : i + 1);
      items[next]!.focus();
      return;
    }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('.note-row') ?? [])];
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? rows.length - 1 : ev.key === 'ArrowDown' ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
    rows[next]!.focus();
  };

  const st = useApp.getState();
  const unread = unreadNotes(shown);
  const days = noteDays(shown, Date.now(), { today: t.notes.today, yesterday: t.notes.yesterday });
  const title = triggersOnly ? t.notes.triggerTitle : t.notes.title;
  return (
    <div ref={box} className={`notes-pop ${triggersOnly ? 'is-triggers' : ''}`} role="dialog" aria-label={title} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="notes-head">
        <span className="notes-title">{title}</span>
        {unread > 0 && <span className="notes-unread mono">{t.notes.unread(unread)}</span>}
        <span className="grow" />
        <button type="button" className={`notes-filter ${triggersOnly ? 'is-on' : ''}`} aria-pressed={triggersOnly} aria-label={t.notes.onlyTriggers}
          title={triggersOnly ? t.notes.allNotes : t.notes.onlyTriggers} onClick={() => st.setNotesFilter(triggersOnly ? 'all' : 'triggers')}>
          <Icon name="bolt" size={12} stroke={2} />
        </button>
        <button type="button" className="notes-action" disabled={unread === 0} onClick={() => st.markAllNotesRead()}><Icon name="check" size={12} stroke={2} />{t.notes.markAllRead}</button>
        <button type="button" className="notes-action" disabled={shown.length === 0} onClick={() => st.clearNotes()}>{t.notes.clear}</button>
      </div>
      {shown.length === 0
        ? (triggersOnly
          ? (
            <div className="notes-empty">
              <Icon name="bolt" size={18} />{t.notes.noTriggers}
              <button type="button" className="notes-action is-link" onClick={() => { close(); st.setSettingsOpen('terminal'); }}>{t.notes.setUpTriggers}</button>
            </div>
          )
          : <p className="notes-empty"><Icon name="bell" size={18} />{t.notes.empty}</p>)
        : (
          <div className="notes-list">
            {days.map((d) => (
              <div key={d.label} role="list" aria-label={d.label}>
                <div className="notes-day section-label">{d.label}</div>
                {d.items.map((e) => <Entry key={e.id} e={e} alive={e.sessions.some((s) => alive.has(s.id))} />)}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
