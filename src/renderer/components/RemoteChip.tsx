import type { TerminalInfo } from '@shared/protocol';
import { t } from '../i18n/en';
import { afterLeavingApp } from '../pane-focus';
import { remoteUrl } from '../remote-view';
import { Icon } from './Icon';

/** Opens a session with Remote Control on at claude.ai/code, in the browser; the keyboard comes back to its pane. */
export function openRemote(term: TerminalInfo): void {
  const url = remoteUrl(term.session?.remote);
  if (!url) return;
  void window.atelier.openUrl(url);
  afterLeavingApp();
}

/**
 * Remote Control on: a wifi glyph alone (its name only for screen readers, the tip says the rest), and a click opens
 * the session at claude.ai/code (where it goes on, as in the Claude app). A button in the session bar; in the sidebar
 * row (inside the row's own button) a plain span with a mouse-only click, like the Background chips: the keyboard goes
 * through the row's menu (Open on claude.ai).
 */
export function RemoteChip({ term, side }: { term: TerminalInfo; side: 'below' | 'right' }) {
  if (!remoteUrl(term.session?.remote)) return null;
  const body = <><Icon name="remote" size={13} stroke={1.9} /><span className="sr-only">{t.remote.chip}</span></>;
  if (side === 'below') {
    return <button type="button" className="remote-chip" aria-label={t.remote.open} data-tip={t.remote.tip} onClick={(e) => { e.stopPropagation(); openRemote(term); }}>{body}</button>;
  }
  return (
    <span className="remote-chip" data-tip={t.remote.tip}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); openRemote(term); }}
      onDoubleClick={(e) => e.stopPropagation()}>
      {body}
    </span>
  );
}
