import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { elapsed, logPreview, type DrawerLog } from './drawer';

/** The log's lines while folded; "Full log" shows the rest in place, scrolling. */
const PREVIEW_LINES = 4;

/** Re-renders every second while `on` (an op's elapsed time). */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * The drawer's op log. Running: the op's label ("Running pre-commit · acme-store",
 * "Waiting for your signature…"), its elapsed time, Cancel, and the last lines it printed. Failed: the first lines of
 * its output, Full log in place, Retry, Commit Without Hooks after a commit's hook, a note when it ran without the
 * user's shell environment, and Dismiss. `onRetry`/`onWithoutHooks` absent: not offered.
 */
export function OpLog({ log, onCancel, onRetry, onWithoutHooks, onDismiss }: {
  log: DrawerLog; onCancel: (id: string) => void; onRetry?: () => void; onWithoutHooks?: () => void; onDismiss: () => void;
}) {
  const [full, setFull] = useState(false);
  const now = useNow(log.kind === 'running');
  if (log.kind === 'running') {
    const all = logPreview(log.output, Number.MAX_SAFE_INTEGER).lines;
    return (
      <div className="git-oplog is-running" role="status">
        <div className="git-oplog-head">
          <i className="git-spin is-working" aria-hidden="true" />
          <span className="git-oplog-title">{log.text}</span>
          <span className="git-oplog-time mono">{elapsed(now - log.startedAt)}</span>
          <button type="button" className="git-oplog-btn" onClick={() => onCancel(log.id)}>{t.git.log.cancel}</button>
        </div>
        {all.length > 0 && <pre className="git-oplog-text mono">{all.slice(-PREVIEW_LINES).join('\n')}</pre>}
      </div>
    );
  }
  const preview = logPreview(log.output, PREVIEW_LINES);
  const lines = full ? logPreview(log.output, Number.MAX_SAFE_INTEGER).lines : preview.lines;
  return (
    <div className={`git-oplog is-failed ${full ? 'is-full' : ''}`}>
      {lines.length > 0
        ? <pre className="git-oplog-text mono" tabIndex={full ? 0 : undefined}>{lines.join('\n')}</pre>
        : <p className="git-oplog-empty">{t.git.log.empty}</p>}
      {log.noShellEnv && <p className="git-oplog-note" data-tip={t.git.log.noShellEnvTip}><Icon name="info" size={11} stroke={2} />{t.git.log.noShellEnv}</p>}
      <div className="git-oplog-actions">
        {lines.length > 0 && (
          <button type="button" className="git-oplog-link" aria-expanded={full} onClick={() => setFull(!full)}>
            {full ? t.git.log.less : t.git.log.fullLog}
            {!full && preview.more > 0 && <span className="git-oplog-more mono">{t.git.log.more(preview.more)}</span>}
          </button>
        )}
        <span className="grow" />
        {onRetry && <button type="button" className="git-oplog-btn" onClick={onRetry}>{t.git.log.retry}</button>}
        {onWithoutHooks && log.withoutHooks && (
          <button type="button" className="git-oplog-btn is-primary" data-tip={t.git.log.withoutHooksTip} onClick={onWithoutHooks}>{t.git.log.withoutHooks}</button>
        )}
        <button type="button" className="icon-btn git-oplog-dismiss" aria-label={t.git.log.dismiss} data-tip={t.git.log.dismiss} onClick={onDismiss}>
          <Icon name="x" size={12} stroke={2} />
        </button>
      </div>
    </div>
  );
}
