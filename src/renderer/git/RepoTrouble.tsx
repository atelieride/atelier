// A repository git couldn't read, in Changes and Source Control: never shown as clean. Git refusing another user's
// folder (safe.directory) gets an explanation and the command that trusts it, to copy; Atelier never runs it.
import { Icon } from '../components/Icon';
import { copyText } from '../clipboard';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { dubiousOwnership, safeDirectoryCommand } from './unsafe';

export function RepoTrouble({ name, root, error, onRetry }: { name: string; root: string; error: string; onRetry?: () => void }) {
  const unsafe = dubiousOwnership(error);
  if (unsafe) {
    const cmd = safeDirectoryCommand(unsafe.path ?? root);
    const copy = () => void copyText(cmd).then((ok) => { if (ok) useApp.getState().showToast(t.scm.commandCopied, undefined, 'info'); });
    return (
      <div className="scm-error repo-trouble" role="alert">
        <span className="repo-trouble-title"><Icon name="lock" size={12} stroke={2} />{t.scm.unsafeTitle(name)}</span>
        <span className="repo-trouble-body">{t.scm.unsafeBody}</span>
        <code className="repo-trouble-cmd mono">{cmd}</code>
        <span className="repo-trouble-actions">
          <button type="button" className="btn-ghost sm" onClick={copy}><Icon name="copy" size={12} />{t.scm.copyCommand}</button>
          {onRetry && <button type="button" className="btn-ghost sm" onClick={onRetry}>{t.scm.retry}</button>}
        </span>
      </div>
    );
  }
  return (
    <div className="scm-error repo-trouble" role="alert">
      <span className="repo-trouble-title">{t.scm.unreadable(name)}</span>
      <span className="repo-trouble-body mono">{error}</span>
      {onRetry && <button type="button" className="btn-ghost sm" onClick={onRetry}>{t.scm.retry}</button>}
    </div>
  );
}
