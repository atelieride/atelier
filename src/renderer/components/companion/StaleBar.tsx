import { Icon } from '../Icon';
import { t } from '../../i18n/en';

/** The files a tooltip lists before "+N more". */
const TIP_MAX = 8;

/**
 * Under the latest answer when the session changed files after it: how many, which
 * (tooltip), and Refresh, which asks the question again. It waits while another answer runs (one at a time).
 */
export function StaleBar({ files, busy, onRefresh }: { files: string[]; busy: boolean; onRefresh: (() => void) | null }) {
  const more = files.length - TIP_MAX;
  const tip = [...files.slice(0, TIP_MAX), ...(more > 0 ? [t.companion.moreFiles(more)] : [])].join('\n');
  return (
    <div className="ask-stale" data-copy="skip">
      <Icon name="resume" size={14} stroke={1.7} />
      <span className="ask-stale-t" data-tip={tip}>{t.companion.staleAnswer(files.length)}</span>
      {onRefresh && (
        <button type="button" className="ask-stale-go" aria-disabled={busy} data-tip={busy ? t.companion.oneAtATime : undefined}
          onClick={() => { if (!busy) onRefresh(); }}>
          {t.companion.refresh}
        </button>
      )}
    </div>
  );
}
