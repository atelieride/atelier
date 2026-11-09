import { useState } from 'react';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { UsageMeter } from './UsageMeter';
import { shortPath } from '../usage';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { unreadNotes } from '@shared/notifications';
import { NotificationCenter } from './NotificationCenter';
import { WindowMenu } from './MenuBar';
import { currentPlatform } from '@shared/platform';
import { kbd } from '../kbd';

type StoreMenu = ReturnType<typeof useApp.getState>['menu'];

// The header: on Windows the window's one bar, the menu behind a hamburger at its start
// and the caption buttons over its end; on macOS after the traffic lights. New is the project chip's + (mockup "B").
export function Header({ onNewMenu }: { onNewMenu: (anchor: HTMLElement) => Promise<void> }) {
  const project = useApp((s) => s.project);
  const notesOpen = useApp((s) => s.notesOpen);
  const unread = useApp((s) => unreadNotes(s.notes));
  const win = currentPlatform() === 'win32';
  // The New menu the + opened: the + shows it open while it is the store's menu.
  const [newMenu, setNewMenu] = useState<StoreMenu>(null);
  const newOpen = useApp((s) => s.menu !== null && s.menu === newMenu);
  const openNew = (el: HTMLElement) => void onNewMenu(el).then(() => setNewMenu(useApp.getState().menu));
  const plus = (
    <button type="button" className={`chip-new btn-new${newOpen ? ' is-open' : ''}`} aria-label={t.newMenu} aria-haspopup="menu" aria-expanded={newOpen}
      data-tip={newOpen ? undefined : t.newMenu} onClick={(e) => openNew(e.currentTarget)}>
      <Icon name="plus" size={13} stroke={2.4} />
    </button>
  );
  return (
    <header className={`header${win ? ' is-win' : ''}`}>
      {/* macOS: room for the traffic lights; Windows: the window menu (the caption buttons sit over the other end). */}
      {win ? <WindowMenu /> : <div className="traffic-space" />}
      {project ? (
        <div className="project-chip">
          {/* Click: the project folder in the Finder. */}
          <button type="button" className="project-reveal" aria-label={t.openInFinder} data-tip={`${t.openInFinder} · ${project.root}`}
            onClick={() => void window.atelier.revealProject()}>
            <Logo size={18} />
            <span className="project-name">{project.name}</span>
            {/* The room left after the name; too little to read, the path goes (no "/……" stub). */}
            <span className="project-path-box"><span className="project-path mono">{shortPath(project.root)}</span></span>
            <span className="project-open"><Icon name="folderOpen" size={12} /></span>
          </button>
          {plus}
        </div>
      ) : (
        <div className="project-chip">
          <span className="project-reveal"><Logo size={18} /><span className="project-name">{t.appName}</span></span>
          {plus}
        </div>
      )}
      <div className="header-center">
        <button type="button" className="search" onClick={() => useApp.getState().setPaletteOpen(true)} aria-label={t.searchLabel}>
          <Icon name="search" size={14} />
          <span className="search-placeholder">{t.search}</span>
          <span className="kbd mono">{kbd('⌘K')}</span>
        </button>
      </div>
      <UsageMeter />
      <div className="bell-wrap">
        <button type="button" className={`bell-btn ${notesOpen ? 'is-open' : ''} ${unread ? 'has-unread' : ''}`} aria-haspopup="dialog" aria-expanded={notesOpen}
          aria-label={unread ? `${t.notes.title} · ${t.notes.unread(unread)}` : t.notes.title} data-tip={notesOpen ? undefined : t.notes.tip} data-kbd={kbd('⌘⇧J')}
          onClick={() => { const st = useApp.getState(); st.setNotesOpen(!st.notesOpen); }}>
          <Icon name="bell" size={15} />
          {unread > 0 && <span className="bell-count mono" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
        </button>
        {notesOpen && <NotificationCenter />}
      </div>
    </header>
  );
}
