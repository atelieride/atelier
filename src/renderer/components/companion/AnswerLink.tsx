import type { ReactNode } from 'react';
import { useApp } from '../../store';
import { copyText } from '../../clipboard';
import { t } from '../../i18n/en';

/** Whether the selection holds some of the element's words (a drag over them ends in a click on it too). */
function selectsIn(el: Element): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && (el.contains(sel.anchorNode) || el.contains(sel.focusNode));
}

/**
 * A link in an answer: an http(s) URL the answer parser read, as the browser reads it. Its tooltip shows that real
 * target whatever the label says; a click, Enter or Open Link hands it to the user's browser through main, which checks
 * it again, and the app's window never navigates. Not draggable, and a mouse drag over its words only selects them.
 */
export function AnswerLink({ url, children }: { url: string; children: ReactNode }) {
  const open = () => void window.atelier.openUrl(url).catch(() => {});
  return (
    <a className="ask-link" href={url} data-tip={t.companion.linkTip(url)} aria-description={t.companion.opensInBrowser} draggable={false}
      onClick={(e) => {
        e.preventDefault();
        // A keyboard click (Enter: no mouse detail) always opens; a mouse one that ends a selection inside it doesn't.
        if (e.detail > 0 && selectsIn(e.currentTarget)) return;
        open();
      }}
      onAuxClick={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        useApp.getState().openMenu(e, [
          { id: 'ask-link-open', label: t.companion.openLink, icon: 'externalLink', run: open },
          { id: 'ask-link-copy', label: t.companion.copyLink, run: () => void copyText(url) }
        ]);
      }}>
      {children}<span className="ask-ext" aria-hidden="true">↗</span>
    </a>
  );
}
