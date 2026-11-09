import type { MouseEvent } from 'react';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { copyText } from '../clipboard';
import { prGlyph, prShown, prTip } from '../pr-view';
import type { MenuItem } from '../menu-model';
import { Icon } from './Icon';
import { afterLeavingApp } from '../pane-focus';

/**
 * The pull request of a session's branch and its CI: `#123` with the PR state glyph and a CI dot (green
 * passing, rose failing, amber pending; none without checks). Click opens the PR, ⌥-click its checks; the context menu
 * also copies the link. Main opens only the https URL gh gave it for that repo and branch.
 */
export function PrChip({ id }: { id: string }) {
  const entry = useApp((s) => s.prs.terminals[id]);
  const enabled = useApp((s) => s.settings.prStatus);
  const pr = prShown(entry, enabled);
  if (!pr || !entry) return null;
  const open = (checks: boolean) => { void window.atelier.prs.open(entry.root, entry.branch, checks); afterLeavingApp(); };
  const glyph = prGlyph(pr);
  const tip = prTip(pr);
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      { id: 'pr-open', label: t.pr.open, icon: glyph, run: () => open(false) },
      { id: 'pr-checks', label: t.pr.openChecks, icon: 'check', run: () => open(true) },
      'sep',
      { id: 'pr-copy', label: t.pr.copyLink, run: () => void copyText(pr.url) }
    ];
    useApp.getState().openMenu(e, items);
  };
  return (
    <button type="button" className={`pr-chip mono pr-${glyph} ci-${pr.ci.state}`} aria-label={tip.join('. ')} data-tip={tip.join('\n')}
      onClick={(e) => { e.stopPropagation(); open(e.altKey); }} onContextMenu={menu} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="pr-glyph"><Icon name={glyph} size={12} stroke={1.7} /></span>
      #{pr.number}
      {pr.ci.state !== 'none' && <i className="pr-ci" aria-hidden />}
    </button>
  );
}
