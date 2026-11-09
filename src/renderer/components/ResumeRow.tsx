import { useState } from 'react';
import type { Resumable } from '@shared/protocol';
import { Avatar } from './Avatar';
import { AccountChip } from './AccountChip';
import { Icon } from './Icon';
import { t } from '../i18n/en';
import { enterClass } from '../seen';
import { useApp } from '../store';
import { resumeMenu } from '../menus';
import { nameTip } from '../names';

/**
 * Claude session left without a process: resumed with --resume under the same name and color. A pinned one keeps its
 * pin badge, and the pin follows it to the resumed session. Without avatars the title starts the row and a pinned one
 * shows a pin mark after it (a resume row has no pin button).
 */
export function ResumeRow({ r, pinned = false, queued = false }: { r: Resumable; pinned?: boolean; queued?: boolean }) {
  const avatars = useApp((s) => s.settings.sessionAvatars);
  const [busy, setBusy] = useState(false);
  const [enter] = useState(() => enterClass(`r-${r.id}`));
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    // Shown as a (starting) session from the reply, until Claude's SessionStart arrives; task link and pin follow it.
    if (!(await useApp.getState().resume(r.id))) setBusy(false);
  };
  return (
    <div className={`resume-row ${enter} ${pinned ? 'is-pinned' : ''} ${queued ? 'is-queued' : ''}${avatars ? '' : ' no-avatar'}`} onContextMenu={(e) => useApp.getState().openMenu(e, resumeMenu(r.id, () => void resume()))}>
      {avatars && <Avatar title={r.title} color={r.color} size={22} dim pinned={pinned} />}
      <span className="resume-title" data-tip={nameTip(r.title)}>{r.title}</span>
      {!avatars && pinned && <span className="row-mark is-pin" role="img" aria-label={t.pinnedTip} data-tip={t.pinnedTip}><Icon name="pin" size={11} stroke={1.8} /></span>}
      <AccountChip configDir={r.configDir} />
      {/* Waiting its turn in Resume all. */}
      {queued ? <span className="resume-queued">{t.resumeQueued}</span> : (
        <>
          {/* A narrow sidebar keeps its icon: the name needs the room. */}
          <button type="button" className="resume-btn" aria-label={t.resume} data-tip={t.resume} onClick={() => void resume()} disabled={busy}><Icon name="resume" size={12} stroke={1.8} /><span className="resume-btn-label">{t.resume}</span></button>
          <button type="button" className="row-close is-visible" aria-label={t.dismiss} data-tip={t.dismiss} onClick={() => void window.atelier.terminals.dismiss(r.id)}><Icon name="x" size={12} stroke={1.8} /></button>
        </>
      )}
    </div>
  );
}
