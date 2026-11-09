import type { TerminalInfo } from '@shared/protocol';
import { chipFor, profileKeyOf, profileLabel } from '@shared/profiles';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';

/**
 * The profile a terminal or session runs in ("zsh", "bash", "Atelier"), only when it isn't the default one: most rows
 * stay clean. Never shrinks: next to a folder chip, the folder gives way first.
 */
export function ProfileChip({ term }: { term: TerminalInfo }) {
  // With an atelierd older than profiles every terminal runs the user's zsh: nothing to tell apart.
  const label = useApp((s) => s.daemon.profilesAvailable ? chipFor({ profile: term.profile, session: !!term.session }, s.settings.terminalProfile, s.shells) : null);
  const full = useApp((s) => { const k = profileKeyOf(term.profile); return k ? profileLabel(k, s.shells) : ''; });
  if (!label) return null;
  // A crowded row shows a shell glyph alone.
  return <span className="profile-chip mono" data-tip={t.profileTip(full)}><span className="chip-glyph"><Icon name="terminal" size={10} stroke={1.9} /></span><span className="chip-text">{label}</span></span>;
}
