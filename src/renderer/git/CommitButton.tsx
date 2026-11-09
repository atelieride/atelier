import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { kbd } from '../kbd';

/**
 * The drawer's split button: "✓ Commit 3 files ⌘↵", "Commit 3" once the panel is narrow,
 * and ▾ with the other ways to commit. Disabled stays hoverable (aria-disabled) so its tooltip says why.
 */
export function CommitButton({ count, block, busy, onCommit, menu, label }: { count: number; block: string | null; busy: boolean; onCommit: () => void; menu: () => MenuItem[]; label?: { full: string; short: string } }) {
  const off = !!block || busy;
  const full = label?.full ?? (count > 0 ? t.git.drawer.commitFiles(count) : t.git.drawer.label);
  const short = label?.short ?? (count > 0 ? t.git.drawer.commitShort(count) : t.git.drawer.label);
  return (
    <div className={`git-commit-split ${off ? 'is-disabled' : ''}`}>
      <button type="button" className="git-commit-main" aria-disabled={off || undefined} data-tip={block ?? undefined}
        onClick={() => { if (!off) onCommit(); }}>
        {busy ? <i className="git-spin" aria-hidden="true" /> : <Icon name="check" size={13} stroke={2.4} />}
        <span className="git-commit-full">{full}</span>
        <span className="git-commit-short">{short}</span>
        <span className="git-commit-keys mono">{kbd('⌘↵')}</span>
      </button>
      <button type="button" className="git-commit-more" aria-label={t.git.drawer.more} data-tip={t.git.drawer.more}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); useApp.getState().openMenu({ x: r.right, y: r.top - 6 }, menu()); }}>
        <Icon name="chevronDown" size={12} stroke={2} />
      </button>
    </div>
  );
}
