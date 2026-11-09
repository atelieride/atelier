import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Binding, Thread, ThreadItem } from '@shared/companion/types';
import { Icon } from '../Icon';
import { useApp } from '../../store';
import { t } from '../../i18n/en';
import { openBelow } from '../../menus';
import { copyText } from '../../clipboard';
import { clockTime } from '../../work-view';
import { ConfirmActions, onEscCancel, useDismiss } from '../../confirms/InlineConfirm';
import { closeAsk } from '../../companion/actions';
import type { RunView } from '../../companion/model';
import { costLine, keepScroll, keptScroll, liveRuns, plainAnswer, runPhase, sessionRuns, suggestionsFor } from '../../companion/view';
import { threadCopy } from '../../companion/copy';
import { selectionCopy } from '../../companion/copy-dom';
import { useShallow } from 'zustand/react/shallow';
import { Composer } from './Composer';
import { CatchUpCard, CatchingUp } from './CatchUpCard';
import { EmptyAsk } from './EmptyAsk';
import { Suggestions } from './Suggestions';
import { AnswerView, LiveAnswer } from './AnswerView';
import { ErrorItem } from './ErrorItem';
import { NeedsYouCard } from './NeedsYouCard';
import { sessionEnded } from '../../companion/attention';

/**
 * The Ask panel: header (mark, "Ask", the session's name in a sheet, Read-only,
 * Dock in a sheet with room, ⋯, ×), the live strip, the thread (or the empty state), the suggestions after a
 * Catch me up, the composer and, while the thread is empty, the fine print. Esc anywhere in it closes it and gives the
 * terminal the keyboard.
 */
export function AskPanel({ binding, mode, onDock }: { binding: Binding; mode: 'dock' | 'sheet'; onDock: (() => void) | null }) {
  const id = binding.terminalId;
  const title = useApp((s) => s.terminals.find((x) => x.id === id)?.title ?? binding.title);
  const thread = useApp((s) => s.askThreads[binding.sessionId] ?? null);
  const phase = useApp((s) => runPhase(s.askRuns, binding.sessionId));
  // A Catch me up on its way (a run with no question): its row at the thread's end.
  const catching = useApp((s) => Object.values(s.askRuns).find((r) => r.sessionId === binding.sessionId && r.questionId === null) ?? null);
  const notice = useApp((s) => s.askNotice[id] ?? null);
  // Claude exited with Ask open: the panel stays bound to the conversation and says so under the strip.
  const ended = useApp((s) => sessionEnded(s.terminals.find((x) => x.id === id), binding.sessionId));
  const [confirming, setConfirming] = useState(false);
  const busy = phase !== 'idle';
  const empty = !thread?.items.length && !busy;
  const box = useRef<HTMLElement>(null);
  const composer = () => box.current?.querySelector<HTMLTextAreaElement>('.ask-comp textarea') ?? null;
  // A control that answered and went (New Thread's question, the Dock button) leaves the keyboard nowhere: back to
  // the composer, unless the click that answered put it somewhere else.
  const refocus = () => requestAnimationFrame(() => {
    const now = document.activeElement;
    if (!now || now === document.body) composer()?.focus({ preventScroll: true });
  });
  // A chip, Why?, a Catch me up (the empty state's, the composer's, the ⋯ menu's) asked: the composer is ready for the
  // follow-up (the chip goes).
  const ask = (q: string) => { void useApp.getState().askQuestion(id, q); composer()?.focus({ preventScroll: true }); };
  const catchUp = () => { useApp.getState().askCatchUp(id); composer()?.focus({ preventScroll: true }); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    closeAsk(id);
  };
  const more = (e: React.MouseEvent<HTMLButtonElement>) => openBelow(e.currentTarget, [
    { id: 'catch-up', label: t.companion.catchUpItem, icon: 'resume', disabled: busy, run: catchUp },
    { id: 'new-thread', label: t.companion.newThread, icon: 'plus', disabled: empty, run: () => setConfirming(true) },
    { id: 'copy-thread', label: t.companion.copyThread, icon: 'copy', disabled: !thread?.items.length, run: () => {
      if (!thread) return;
      const c = threadCopy(thread, title);
      void copyText(c.text, c.html).then((ok) => { if (ok) useApp.getState().showToast(t.companion.copied, undefined, 'info'); });
    } },
    { id: 'ask-settings', label: t.companion.askSettings, icon: 'settings', run: () => useApp.getState().setSettingsOpen('ask') },
    'sep',
    { id: 'cost', label: costLine(thread?.costUsd ?? 0), disabled: true, run: () => {} }
  ]);

  return (
    <aside ref={box} className={`ask is-${mode}`} data-terminal={id} aria-label={t.companion.askAboutTitle(title)} onKeyDown={onKeyDown}>
      <header className="ask-hd">
        <span className="ask-mk" aria-hidden="true"><Icon name="ask" size={14} stroke={1.8} /></span>
        <span className="ask-ttl">{t.companion.ask}</span>
        {mode === 'sheet' && <span className="ask-of">{title}</span>}
        <span className="ask-ro" data-tip={t.companion.readOnlyTip}><Icon name="lock" size={11} stroke={1.8} />{t.companion.readOnly}</span>
        <span className="ask-sp" />
        {onDock && (
          <button type="button" className="ask-ib is-dock" aria-label={t.companion.dock} data-tip={t.companion.dock} onClick={() => { onDock(); refocus(); }}>
            <Icon name="split" size={15} stroke={1.7} />
          </button>
        )}
        <button type="button" className="ask-ib" aria-label={t.companion.more} aria-haspopup="menu" data-tip={t.companion.more} onClick={more}>
          <Icon name="more" size={16} stroke={2.4} />
        </button>
        <button type="button" className="ask-ib" aria-label={t.companion.close} data-tip={t.companion.close} data-kbd={t.confirm.esc} onClick={() => closeAsk(id)}>
          <Icon name="x" size={15} stroke={1.7} />
        </button>
      </header>
      {confirming && <NewThreadCard onCancel={() => { setConfirming(false); refocus(); }} onConfirm={() => { setConfirming(false); useApp.getState().newAskThread(id); refocus(); }} />}
      {ended && (
        <div className="ask-endbar">
          <Icon name="resume" size={14} stroke={1.7} /><span>{t.companion.endedNote}</span>
        </div>
      )}
      <NeedsYouCard binding={binding} busy={busy} onAsk={ask} />
      {notice && (
        <div className="ask-notice" role="status">
          <Icon name="info" size={13} stroke={1.8} /><span className="ask-notice-text">{notice}</span>
          <button type="button" className="ask-ib sm" aria-label={t.companion.dismiss} data-tip={t.companion.dismiss} onClick={() => useApp.getState().clearAskNotice(id)}><Icon name="x" size={12} stroke={1.8} /></button>
        </div>
      )}
      {empty ? <EmptyAsk title={title} onAsk={ask} onCatchUp={catchUp} />
        : <ThreadView thread={thread} binding={binding} busy={busy} catching={catching} onAsk={ask} onCatchUp={() => useApp.getState().askCatchUp(id)} />}
      <Suggestions items={suggestionsFor(thread, busy)} onAsk={ask} />
      {/* Keyed by its session: a draft is always saved under the session it was typed for. */}
      <Composer key={binding.sessionId} binding={binding} title={title} thread={thread} onCatchUp={thread?.items.length ? catchUp : null} />
      {empty && <div className="ask-fine">{t.companion.fine}</div>}
    </aside>
  );
}

/** New Thread asks first, in the panel (in-app confirms): the safe answer takes the focus, Esc cancels. */
function NewThreadCard({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, onCancel);
  return (
    <div ref={box} className="ask-confirm" role="group" aria-label={t.companion.newThreadAsk} onKeyDown={onEscCancel(onCancel)}>
      <p><b>{t.companion.newThreadAsk}</b> {t.companion.newThreadBody}</p>
      <ConfirmActions confirm={t.companion.newThreadGo} onConfirm={onConfirm} onCancel={onCancel} />
    </div>
  );
}

/**
 * The thread: Catch me up cards, your questions (bubbles on the right, with their time), answers (left,
 * no bubble), errors; an answer on its way follows its question, and questions held behind it wait at the end. New
 * content (a streamed answer too) keeps the view at the bottom unless you scrolled up, and your own question always
 * shows; a Catch me up that just landed taller than the view shows from its top. It is a log that announces nothing by
 * itself (it would read every streamed word): a polite status says when an answer or an error lands.
 */
function ThreadView({ thread, binding, busy, catching, onAsk, onCatchUp }: {
  thread: Thread | null; binding: Binding; busy: boolean; catching: RunView | null; onAsk: (q: string) => void; onCatchUp: () => void;
}) {
  const { sessionId, terminalId } = binding;
  const box = useRef<HTMLDivElement>(null);
  // Shown again (a tab back, a split): where it was scrolled up to, else following the bottom.
  const kept = useRef(keptScroll(terminalId));
  const pinned = useRef(kept.current === null);
  const items = thread?.items ?? [];
  const last = items.at(-1);
  const latestCatchUp = items.findLast((i) => i.kind === 'catchup')?.id ?? null;
  const latestAnswer = items.findLast((i) => i.kind === 'answer')?.id ?? null;
  // The thread's latest outcome: a usage limit offers its ways out only there.
  const latestOutcome = items.findLast((i) => i.kind !== 'question')?.id ?? null;
  // This session's runs only (shallow): another session's streamed delta doesn't render this thread again.
  const runs = useApp(useShallow((s) => sessionRuns(s.askRuns, s.askTexts, sessionId).runs));
  const texts = useApp(useShallow((s) => sessionRuns(s.askRuns, s.askTexts, sessionId).texts));
  const live = liveRuns(thread, runs, texts, sessionId);
  const model = useApp((s) => s.askThreads[sessionId]?.model ?? s.settings.askModel);
  const questions = new Map<string, string>();
  for (const i of items) if (i.kind === 'question') questions.set(i.id, i.text);
  // What grows while an answer streams: the view follows it when it is at the bottom.
  const growth = [...Object.values(live.byQuestion).map((r) => `${r.runId}:${r.queued}:${r.trace.length}:${r.text.length}`), live.held.length].join('|');
  useLayoutEffect(() => {
    const el = box.current;
    if (el && kept.current !== null) { el.scrollTop = kept.current; kept.current = null; return; }
    if (!el || (!pinned.current && last?.kind !== 'question')) return;
    let top = el.scrollHeight;
    const card = last?.kind === 'catchup' && !catching ? el.lastElementChild : null;
    if (card) top = Math.min(top, card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8);
    el.scrollTop = top;
  }, [items.length, last?.id, catching?.runId, growth]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    keepScroll(terminalId, pinned.current ? null : el.scrollTop);
  };
  // ⌘C on a selection: Ask writes it, formatted and as plain text, instead of
  // Chromium's copy (which carries the theme's colors into documents).
  const onCopy = (e: React.ClipboardEvent) => {
    const el = box.current;
    const c = el ? selectionCopy(el, window.getSelection()) : null;
    if (!c) return;
    e.preventDefault();
    void copyText(c.text, c.html);
  };
  return (
    <>
      <div ref={box} className="ask-thread" role="log" aria-live="off" aria-label={t.companion.thread} onScroll={onScroll} onCopy={onCopy}>
        {items.map((i) => {
          switch (i.kind) {
            case 'catchup':
              return <CatchUpCard key={i.id} item={i} sessionId={sessionId} latest={i.id === latestCatchUp} busy={busy} catching={catching !== null} onAsk={onAsk} onCatchUp={onCatchUp} />;
            case 'question': {
              const run = live.byQuestion[i.id];
              return (
                <Fragment key={i.id}>
                  <Question text={i.text} meta={clockTime(i.at)} />
                  {run && <LiveAnswer key={run.runId} run={run} cwd={binding.cwd} model={model} />}
                </Fragment>
              );
            }
            case 'answer':
              return <AnswerView key={i.id} item={i} sessionId={sessionId} terminalId={terminalId} cwd={binding.cwd} question={questions.get(i.questionId) ?? null}
                latest={i.id === latestAnswer} busy={busy} onAsk={onAsk} />;
            case 'error':
              return <ErrorItem key={i.id} item={i} binding={binding} question={i.questionId === null ? null : questions.get(i.questionId) ?? null} latest={i.id === latestOutcome}
                busy={busy} onAsk={onAsk} onCatchUp={onCatchUp} />;
          }
        })}
        {live.held.map((h) => <Question key={h.runId} text={h.text} meta={t.companion.waitingCurrent} held />)}
        {catching && <CatchingUp run={catching} />}
      </div>
      <Announcer items={items} />
    </>
  );
}

/** Your question: a bubble on the right, its time under it; one held behind the current answer says so. */
function Question({ text, meta, held = false }: { text: string; meta: string; held?: boolean }) {
  return (
    <div className={`ask-item ask-q${held ? ' is-held' : ''}`} data-kind={held ? 'held' : 'question'}>
      <p className="ask-q-t" data-copy-pre="">{text}</p>
      <span className={`ask-q-meta${held ? '' : ' mono'}`} data-copy="skip">{meta}</span>
    </div>
  );
}

/** Tells a screen reader when an answer or an error lands (not the ones already there when the panel opened). */
function Announcer({ items }: { items: readonly ThreadItem[] }) {
  const outcome = items.findLast((i) => i.kind === 'answer' || i.kind === 'error') ?? null;
  const seen = useRef(outcome?.id ?? null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (!outcome || outcome.id === seen.current) return;
    seen.current = outcome.id;
    setSaid(outcome.kind === 'answer' ? t.companion.answered(plainAnswer(outcome.markdown)) : outcome.kind === 'error' ? outcome.message : '');
  }, [outcome]);
  return <span className="sr-only" role="status" aria-live="polite">{said}</span>;
}
