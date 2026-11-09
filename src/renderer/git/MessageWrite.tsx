import type { MessageTweak } from '@shared/git-write';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { type GitWrite, sparkleMode, tweaksLeft, writeMeta } from './message';

/**
 * ✦ at the top-right of the message field: it glows while the field is empty and stays quiet
 * otherwise; Stop while Claude writes; ↻ (write again) once the message is in.
 */
export function Sparkle({ w, empty, staged, onWrite, onStop }: { w: GitWrite | null; empty: boolean; staged: number; onWrite: () => void; onStop: () => void }) {
  const mode = sparkleMode({ w, empty });
  const v = t.git.write;
  if (mode === 'stop') {
    return (
      <button type="button" className="git-sparkle is-stop" aria-label={v.stop} data-tip={v.stopTip} onClick={onStop}>
        <Icon name="stop" size={12} stroke={2} />
      </button>
    );
  }
  const none = staged === 0;
  const label = mode === 'again' ? v.again : v.write;
  return (
    <button type="button" className={`git-sparkle ${mode === 'glow' && !none ? 'is-glow' : ''} ${mode === 'again' ? 'is-again' : ''}`} aria-label={label}
      aria-disabled={none || undefined} data-tip={none ? v.stageFirst : mode === 'again' ? v.againTip : v.writeTip}
      onClick={() => { if (!none) onWrite(); }}>
      <Icon name={mode === 'again' ? 'resume' : 'sparkle'} size={13} stroke={1.8} />
    </button>
  );
}

/**
 * The lines under the field while ✦ is about: "✦ writing · Esc to stop" or "✦ Haiku · 1.8 s" with the tweak pills
 * (each rewrites once; they go as soon as you type), main's notes, and "Staged files changed · Rewrite".
 */
export function WriteLines({ w, stale, onTweak, onRewrite }: { w: GitWrite | null; stale: boolean; onTweak: (kind: MessageTweak) => void; onRewrite: () => void }) {
  const meta = writeMeta(w);
  const tweaks = tweaksLeft(w);
  const notes = w?.phase === 'ready' ? w.notes ?? [] : [];
  if (!meta && !stale) return null;
  return (
    <div className="git-write">
      {meta && (
        <div className="git-write-row">
          <span className={`git-write-meta ${w?.phase === 'writing' ? 'is-writing' : ''}`}>{meta}</span>
          {tweaks.length > 0 && (
            <span className="git-write-tweaks" role="group" aria-label={t.git.write.tweaks}>
              {tweaks.map((k) => <button key={k} type="button" className="git-write-pill" onClick={() => onTweak(k)}>{t.git.write.tweak[k]}</button>)}
            </span>
          )}
        </div>
      )}
      {notes.map((n) => <div key={n} className="git-write-note"><Icon name="info" size={11} stroke={1.8} /><span>{n}</span></div>)}
      {stale && (
        <div className="git-notice is-warn git-write-stale" role="status">
          <Icon name="warning" size={12} stroke={2} /><span className="git-notice-text">{t.git.write.stale}</span>
          <button type="button" className="git-notice-action" onClick={onRewrite}>{t.git.write.rewrite}</button>
        </div>
      )}
    </div>
  );
}
