import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import type { StageAllPlan } from './stage-all';
import './stage-all.css';

/**
 * Commit with nothing staged asks: inline in the drawer, above the split button. Not destructive, so the main button
 * takes the focus (⌘↵ then ↵ commits). Esc
 * or the × closes only the question: the drawer, its message and the index stay as they were. Cancel is the ×, so
 * Always and the answer fit on one row at the panel's default width.
 */
export function StageAllConfirm({ name, plan, push, onCancel, onAlways, onGo }: {
  name: string; plan: StageAllPlan; push: boolean; onCancel: () => void; onAlways: () => void; onGo: () => void;
}) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => { go.current?.focus({ preventScroll: true }); }, []);
  const d = t.git.drawer;
  return (
    <div className="git-ask" role="alertdialog" aria-label={d.label} aria-describedby="git-ask-text"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}>
      <p id="git-ask-text" className="git-ask-text">{d.askBefore}<b>{name}</b>{d.askAfter(plan.changes, plan.newFiles, push)}</p>
      <button type="button" className="icon-btn git-ask-close" aria-label={d.askCancel} data-tip={d.askCancel} data-kbd={kbd('Esc')} onClick={onCancel}>
        <Icon name="x" size={12} stroke={2} />
      </button>
      <div className="git-ask-actions">
        <button type="button" className="btn-ghost sm" data-tip={d.askAlwaysTip} onClick={onAlways}>{d.askAlways}</button>
        <button ref={go} type="button" className="btn-primary sm" onClick={onGo}>{push ? d.askGoPush : d.askGo}</button>
      </div>
    </div>
  );
}
