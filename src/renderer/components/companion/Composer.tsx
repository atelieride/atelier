import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { COMPANION_QUESTION_MAX, type Binding, type CompanionModel, type Thread } from '@shared/companion/types';
import { accountTag, useAccounts } from '../../accounts';
import { Icon } from '../Icon';
import { useApp } from '../../store';
import { t } from '../../i18n/en';
import { kbd } from '../../kbd';
import type { MenuItem } from '../../menu-model';
import { MODEL_LABEL, askPlaceholder, runPhase } from '../../companion/view';
import { takeAskFocus } from '../../companion/actions';
import { activeLimit } from '../../companion/attention';

const MODELS: CompanionModel[] = ['haiku', 'sonnet', 'opus'];
/** The field grows with the question up to about six lines, then scrolls. */
const FIELD_MAX = 132;

/** A picker's menu above its pill (the composer sits at the panel's bottom). */
function openAbove(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  useApp.getState().openMenu({ x: r.left, y: r.top - 4 }, items);
}

/**
 * The question field: Enter asks, ⇧Enter is a new line; under it the thread's model and
 * account pickers (the account one only with several accounts), Catch me up once the thread has something in it and
 * Send, or Stop while Ask answers. Send and Catch me up wait while a run of this thread is
 * on (one at a time); the field stays editable.
 */
export function Composer({ binding, title, thread, onCatchUp }: { binding: Binding; title: string; thread: Thread | null; onCatchUp: (() => void) | null }) {
  const id = binding.terminalId;
  const sid = binding.sessionId;
  const field = useRef<HTMLTextAreaElement>(null);
  // A half-typed question waits in the store for the next open (Esc, a tab switch, a split remount it). Saved as it is
  // typed: a host mounting again in the same commit reads it before this one's cleanup would run.
  const [text, setText] = useState(() => useApp.getState().askDrafts[sid] ?? '');
  useEffect(() => { useApp.getState().setAskDraft(sid, text); }, [sid, text]);
  const [focused, setFocused] = useState(false);
  const phase = useApp((s) => runPhase(s.askRuns, sid));
  const pick = useApp((s) => s.askPick[sid]);
  const defaultModel = useApp((s) => s.settings.askModel);
  const defaultAccount = useApp((s) => s.settings.askAccount);
  const configDir = useApp((s) => s.terminals.find((x) => x.id === id)?.configDir ?? binding.configDir);
  const defaultDir = useApp((s) => s.claudeDefaultDir);
  const accounts = useAccounts();
  const model = pick?.model ?? thread?.model ?? defaultModel;
  const account = pick?.account ?? thread?.account ?? defaultAccount;

  // Opened from the button or ⌘I: the keyboard comes here (a panel shown again, after a tab switch, leaves it).
  useLayoutEffect(() => { if (takeAskFocus(id)) field.current?.focus({ preventScroll: true }); }, [id]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, FIELD_MAX)}px`;
  }, [text]);

  const busy = phase !== 'idle';
  const canSend = !busy && text.trim().length > 0;
  const send = () => {
    const q = text.trim();
    if (!canSend) return;
    setText('');
    // Refused (main said why, in the notice): the question comes back unless something was typed meanwhile.
    void useApp.getState().askQuestion(id, q).then((ok) => { if (!ok) setText((cur) => (cur === '' ? q : cur)); });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  const sessionName = accountTag(configDir, accounts, defaultDir)?.name ?? accounts.list[0]?.name ?? t.companion.sessionAccountPlain;
  const chosen = account === 'session' ? null : accounts.list.find((a) => a.id === account) ?? null;
  const dotColor = chosen ? chosen.color : accounts.list.find((a) => a.name === sessionName)?.color ?? null;
  // The thread's last run hit its account's limit: that account reads rose, at 100%, until it resets
  // or another account is picked.
  const limit = activeLimit(thread, Date.now());
  const atLimit = limit !== null && account === (limit.account ?? thread?.account ?? defaultAccount);
  const accountName = chosen?.name ?? sessionName;
  const pickModel = (e: React.MouseEvent<HTMLButtonElement>) => openAbove(e.currentTarget, MODELS.map((m) => ({
    id: m, label: MODEL_LABEL[m], icon: m === model ? 'check' as const : undefined, run: () => useApp.getState().setAskPick(sid, { model: m })
  })));
  const pickAccount = (e: React.MouseEvent<HTMLButtonElement>) => openAbove(e.currentTarget, [
    { id: 'session', label: t.companion.sessionAccount(sessionName), icon: account === 'session' ? 'check' as const : undefined, run: () => useApp.getState().setAskPick(sid, { account: 'session' }) },
    'sep',
    ...accounts.list.map((a): MenuItem => ({ id: a.id, label: a.name, icon: a.id === account ? 'check' as const : undefined, run: () => useApp.getState().setAskPick(sid, { account: a.id }) }))
  ]);

  return (
    <div className={`ask-comp${focused ? ' is-focus' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); field.current?.focus(); } }}>
      <textarea ref={field} rows={1} value={text} maxLength={COMPANION_QUESTION_MAX} aria-label={t.companion.askAboutTitle(title)} placeholder={askPlaceholder(thread, title)}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      <div className="ask-comp-row">
        <button type="button" className="ask-pick" aria-haspopup="menu" aria-label={`${t.companion.model}: ${MODEL_LABEL[model]}`} data-tip={t.companion.pickerTip(t.companion.model)} onClick={pickModel}>
          <Icon name="sparkle" size={11} stroke={1.8} />{MODEL_LABEL[model]}<Icon name="chevronDown" size={11} stroke={1.8} />
        </button>
        {accounts.list.length > 1 && (
          <button type="button" className={`ask-pick${atLimit ? ' is-limit' : ''}`} aria-haspopup="menu"
            aria-label={`${t.companion.account}: ${accountName}${atLimit ? `, ${t.companion.atLimitTip(accountName)}` : ''}`}
            data-tip={atLimit ? t.companion.atLimitTip(accountName) : t.companion.pickerTip(t.companion.account)} onClick={pickAccount}
            style={dotColor && !atLimit ? ({ '--acct': `var(--person-${dotColor})` } as CSSProperties) : undefined}>
            <i className="ask-acct-dot" aria-hidden="true" /><span className="ask-pick-t">{atLimit ? `${accountName} · ${t.companion.atLimit}` : accountName}</span><Icon name="chevronDown" size={11} stroke={1.8} />
          </button>
        )}
        {onCatchUp && (
          <button type="button" className="ask-cu" aria-label={t.companion.catchUp} aria-disabled={busy} data-tip={busy ? t.companion.oneAtATime : t.companion.catchUpTip}
            onClick={() => { if (!busy) onCatchUp(); }}>
            <Icon name="resume" size={12} stroke={1.8} /><span className="ask-cu-t">{t.companion.catchUp}</span>
          </button>
        )}
        {busy ? (
          <button type="button" className="ask-send is-stop" aria-label={t.companion.stop} data-tip={t.companion.stop} onClick={() => useApp.getState().stopAsk(id)}>
            <Icon name="stop" size={13} stroke={2} />
          </button>
        ) : (
          <button type="button" className="ask-send" aria-label={t.companion.send} aria-disabled={!canSend} data-tip={canSend ? t.companion.send : undefined} data-kbd={canSend ? kbd('↵') : undefined} onClick={send}>
            <Icon name="arrowUp" size={14} stroke={2} />
          </button>
        )}
      </div>
    </div>
  );
}
