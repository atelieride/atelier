import { t } from '../i18n/en';
import { Icon } from '../components/Icon';
import { GIT_FOR_WINDOWS } from './missing';

/** Windows without Git: why the git views are empty, and where to get it. */
export function GitMissing() {
  return (
    <div className="scm-empty" role="status">
      <span className="scm-empty-icon"><Icon name="git" size={20} /></span>
      <p className="scm-empty-title">{t.scm.gitMissing}</p>
      <p className="scm-empty-body">{t.scm.gitMissingBody}</p>
      <button type="button" className="btn-ghost sm" onClick={() => void window.atelier.openUrl(GIT_FOR_WINDOWS)}>{t.scm.gitMissingGet}</button>
    </div>
  );
}
