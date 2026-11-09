import { memo } from 'react';
import type { SessionState } from '@shared/session';
import { idStyle, initialOf } from '../avatar';
import { PinBadge } from './PinBadge';
import { Icon } from './Icon';

/**
 * Session initial on a rounded square with a ring in the identity color; the state animates it. A finished session has
 * no check on it (2026-11-02: Ready for review and the row's unread dot say it); small avatars (tabs) keep a dot.
 */
export const Avatar = memo(function Avatar({ title, color, state, size = 26, dim = false, pinned = false, auto = false }: { title: string; color: string; state?: SessionState | null; size?: number; dim?: boolean; pinned?: boolean; auto?: boolean }) {
  const initial = initialOf(title);
  return (
    <span className={`avatar ${state ? `av-${state}` : ''} ${dim ? 'is-dim' : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), ...idStyle(color) }} aria-hidden="true">
      {initial}
      {state === 'done' && size < 18 && <span className="av-done-dot" />}
      {pinned && <PinBadge />}
      {auto && <span className="av-auto"><Icon name="automation" size={9} stroke={2.2} /></span>}
    </span>
  );
});
