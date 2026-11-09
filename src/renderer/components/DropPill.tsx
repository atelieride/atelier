import { useApp } from '../store';
import { t } from '../i18n/en';
import { Icon } from './Icon';

/** Finder files over the window, not over a terminal: a soft ring and "Drop to open". */
export function DropPill() {
  const on = useApp((s) => s.fileDrag);
  if (!on) return null;
  return (
    <>
      <div className="file-drop-ring" aria-hidden />
      <div className="file-drop-dock" aria-live="polite">
        <div className="file-drop-pill"><Icon name="folderOpen" size={14} />{t.openAny.drop}</div>
      </div>
    </>
  );
}
