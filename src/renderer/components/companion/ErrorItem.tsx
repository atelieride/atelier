import { useEffect, useReducer, useRef } from 'react';
import type { Binding, ThreadItem } from '@shared/companion/types';
import { Icon } from '../Icon';
import { useApp } from '../../store';
import { useAccounts } from '../../accounts';
import { t } from '../../i18n/en';
import { askAtDelay, limitBody, limitTitle, limitedBy, otherAccount, resetClock, wakeIn } from '../../companion/attention';

type ErrorEntry = Extract<ThreadItem, { kind: 'error' }>;

/**
 * An outcome that isn't an answer: an item in the thread, never a toast. A failure (Claude Code
 * not found, a timeout, an exit with its first line, a summary that didn't fit) is red-tinted with Try again; a stop (the
 * user's own, or Atelier quitting) is quiet, with Try again; an unreadable chat is a plain note, said once by main; a
 * usage limit has its own item (LimitItem). Try again asks the question it belongs to again, or catches up again.
 */
export function ErrorItem({ item, binding, question, latest, busy, onAsk, onCatchUp }: {
  item: ErrorEntry; binding: Binding; question: string | null; latest: boolean; busy: boolean; onAsk: (q: string) => void; onCatchUp: () => void;
}) {
  if (item.reason === 'chat-unreadable') {
    return (
      <div className="ask-item ask-info" data-kind="error" data-reason={item.reason}>
        <Icon name="info" size={13} stroke={1.8} /><span>{item.message}</span>
      </div>
    );
  }
  const retry = item.questionId === null ? onCatchUp : question !== null ? () => onAsk(question) : null;
  if (item.reason === 'limit') return <LimitItem item={item} binding={binding} retry={retry} latest={latest} busy={busy} />;
  const soft = item.reason === 'stopped' || item.reason === 'quit';
  return (
    <div className={`ask-item ask-err${soft ? ' is-soft' : ''}`} data-kind="error" data-reason={item.reason}>
      <Icon name={soft ? 'stop' : 'warning'} size={14} stroke={1.8} />
      <span className="ask-err-t">{item.message}</span>
      {retry && (
        <button type="button" className="ask-err-go" aria-disabled={busy} data-tip={busy ? t.companion.oneAtATime : undefined} onClick={() => { if (!busy) retry(); }}>
          {t.companion.tryAgain}
        </button>
      )}
    </div>
  );
}

/**
 * The time now, re-rendering once `until` (the reset) passes: "Ask at" turns into Try again. Checked at least once a
 * minute and when the window comes back (focus, visible), so a Mac that slept past the reset never shows a dead "Ask
 * at". Nothing moves on screen meanwhile.
 */
function useNow(until: number | null): number {
  const [n, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const wait = until === null ? null : wakeIn(until + 50, Date.now());
    if (wait === null) return;
    const timer = setTimeout(tick, wait);
    const wake = () => tick();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => { clearTimeout(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [until, n]);
  return Date.now();
}

/**
 * The usage limit: which account hit which limit, when it resets, that only Ask is paused (the session
 * keeps working). On the latest one: **Ask with <other account>** (another configured account not at its own limit;
 * the thread's account picker moves to it) and **Ask at 14:10** (asks again at the reset while Atelier runs, "Will ask
 * at 14:10 · Cancel" meanwhile); once the reset passed, Try again.
 */
function LimitItem({ item, binding, retry, latest, busy }: { item: ErrorEntry; binding: Binding; retry: (() => void) | null; latest: boolean; busy: boolean }) {
  const id = binding.terminalId;
  const accounts = useAccounts();
  const defaultDir = useApp((s) => s.claudeDefaultDir);
  const usage = useApp((s) => s.usage);
  // The thread's account now: only for an item saved before main recorded the run's own.
  const current = useApp((s) => s.askThreads[binding.sessionId]?.account ?? s.settings.askAccount);
  const sessionDir = useApp((s) => s.terminals.find((x) => x.id === id)?.configDir ?? binding.configDir);
  const title = useApp((s) => s.terminals.find((x) => x.id === id)?.title ?? binding.title);
  const waiting = useApp((s) => (s.askAt[binding.sessionId]?.itemId === item.id ? s.askAt[binding.sessionId]! : null));
  const resetMs = item.resetsAt === undefined ? null : item.resetsAt * 1000;
  const now = useNow(resetMs);
  const who = limitedBy(item, current, sessionDir ?? null, accounts, defaultDir);
  const other = latest && retry ? otherAccount(accounts, usage, who.account, defaultDir, now / 1000) : null;
  const canWait = latest && retry !== null && askAtDelay(item.resetsAt, now) !== null;
  const clock = resetMs === null ? '' : resetClock(resetMs, now);
  const st = () => useApp.getState();
  // Ask at and Cancel take each other's place: the keyboard follows to the one that appears.
  const box = useRef<HTMLDivElement>(null);
  const focusNext = (selector: string) => requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true }));
  return (
    <div ref={box} className="ask-item ask-err is-limit" data-kind="error" data-reason="limit">
      <p className="ask-lim-t"><Icon name="warning" size={14} stroke={1.8} />{limitTitle(who.name, item.window)}</p>
      <p className="ask-lim-d">{limitBody({ resetMs, title, now })}</p>
      {waiting ? (
        <div className="ask-lim-wait" role="status">
          <Icon name="clock" size={13} stroke={1.8} /><span>{t.companion.willAskAt(resetClock(waiting.at, now))}</span>
          <span className="ask-lim-sep" aria-hidden="true">·</span>
          <button type="button" className="ask-lim-cancel" onClick={() => { st().cancelAskAt(binding.sessionId); focusNext('.ask-lim-at'); }}>{t.companion.cancel}</button>
        </div>
      ) : (other || canWait || (latest && retry)) && (
        <div className="ask-lim-btns">
          {other && (
            <button type="button" className="ask-btn is-primary" aria-disabled={busy} data-tip={busy ? t.companion.oneAtATime : t.companion.askWithTip(other.name)}
              onClick={() => { if (!busy) st().askWith(id, item.id, other.id); }}>
              {t.companion.askWith(other.name)}
            </button>
          )}
          {canWait ? (
            <button type="button" className="ask-btn ask-lim-at" data-tip={t.companion.askAtTip} onClick={() => { st().askAtReset(id, item.id); focusNext('.ask-lim-cancel'); }}>
              <Icon name="clock" size={13} stroke={1.8} />{t.companion.askAt(clock)}
            </button>
          ) : retry && (
            <button type="button" className="ask-btn" aria-disabled={busy} data-tip={busy ? t.companion.oneAtATime : undefined} onClick={() => { if (!busy) retry(); }}>
              {t.companion.tryAgain}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
