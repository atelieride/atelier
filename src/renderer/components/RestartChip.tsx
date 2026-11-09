import { useApp } from '../store';
import { t } from '../i18n/en';
import { hasDraft } from '../terminal/drafts';
import { panelReason } from '../session-panel';
import { Icon } from './Icon';
import { restartFromMenu } from '../restart-actions';

const NONE: readonly string[] = [];

/**
 * Restart Session's chip: sky "after this turn" while a restart waits for Claude (a
 * click cancels it), else violet "New MCP" when servers were added since the session started (a click restarts). A
 * button in the session bar; in the sidebar row (inside the row's own button) a plain span with a mouse-only click, like
 * the Scheduled chip — the keyboard goes through the row's menu (Restart Session, Don't Restart).
 */
export function RestartChip({ terminalId, side }: { terminalId: string; side: 'below' | 'right' }) {
  const armed = useApp((s) => !!s.restarts[terminalId]?.armed);
  const added = useApp((s) => s.mcpAdded[terminalId] ?? NONE);
  const running = useApp((s) => s.restarts[terminalId]?.armed === false);
  if (running || (!armed && added.length === 0)) return null;
  // Armed and held back by a draft: the chip says what it waits for.
  const tip = armed ? (hasDraft(terminalId) ? `${t.restart.armedTip}\n${panelReason('draft')}` : t.restart.armedTip) : t.restart.newTip(added);
  const run = () => (armed ? useApp.getState().cancelRestart(terminalId) : restartFromMenu(terminalId));
  const cls = `rs-chip ${armed ? 'is-armed' : 'is-new'}`;
  const body = armed
    ? <><Icon name="restart" size={11} stroke={2} /><span>{t.restart.armedChip}</span></>
    : <><Icon name="plug" size={11} stroke={1.9} /><span>{t.restart.newChip(added.length)}</span></>;
  if (side === 'below') {
    return <button type="button" className={cls} aria-label={tip.replace(/\n/g, '. ')} data-tip={tip} onClick={(e) => { e.stopPropagation(); run(); }}>{body}</button>;
  }
  return (
    <span className={cls} data-tip={tip}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); run(); }}
      onDoubleClick={(e) => e.stopPropagation()}>
      {body}
    </span>
  );
}
