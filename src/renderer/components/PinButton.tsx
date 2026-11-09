import { Icon } from './Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';

/**
 * Pin toggle of a sidebar row: shown on hover or focus (filled once pinned), over the end of the title line, so it never
 * takes room from the title; the row shows that it is pinned with a PinBadge on its avatar.
 * kept: shown at rest too — a pinned session row without avatars,
 * whose pin has nowhere else to show; it then counts in the room the title line keeps (data-keep).
 */
export function PinButton({ id, pinned, session, kept = false }: { id: string; pinned: boolean; session: boolean; kept?: boolean }) {
  const tip = session ? (pinned ? t.unpinSession : t.pinSession) : (pinned ? t.unpinTerminal : t.pinTerminal);
  return (
    <button type="button" className={`row-pin ${pinned ? 'is-pinned' : ''}${kept ? ' is-kept' : ''}`} {...(kept ? { 'data-keep': '' } : {})} aria-pressed={pinned}
      aria-label={session ? t.pinSession : t.pinTerminal} data-tip={tip}
      onClick={(e) => { e.stopPropagation(); useApp.getState().togglePinned(id); }}><Icon name="pin" size={13} stroke={1.8} /></button>
  );
}
