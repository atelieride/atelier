import { memo } from 'react';
import type { SessionState } from '@shared/session';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from '../store';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * A session's tile when avatars are off: the Sessions view's glyph
 * in the box a plain terminal's tab already has, as the other tabs show their view's icon. Violet; amber while the
 * session waits for you, rose on an error; small ones keep a finished session's done dot, as small avatars do.
 */
export const SessionTile = memo(function SessionTile({ state, size }: { state?: SessionState | null; size: number }) {
  return (
    <span className={`session-tile${state ? ` st-${state}` : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="sessions" size={Math.round(size * 0.65)} stroke={2} />
      {state === 'done' && size < 18 && <span className="av-done-dot" />}
    </span>
  );
});

/** Where a session's avatar sits beside its name (tabs, pane headers, the session bar): the avatar, or its tile when off. */
export function SessionGlyph({ term, state, size }: { term: Pick<TerminalInfo, 'title' | 'color'>; state?: SessionState | null; size: number }) {
  const avatars = useApp((s) => s.settings.sessionAvatars);
  return avatars ? <Avatar title={term.title} color={term.color} state={state} size={size} /> : <SessionTile state={state} size={size} />;
}
