import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { shortPath } from '../usage';
import { t } from '../i18n/en';
import { welcomeNext } from '../welcome-nav';

export function Welcome() {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { void window.atelier.recentProjects().then(setRecent).catch(() => {}); }, []);
  // ↑/↓, Home, End walk "Open Folder" and the recent folders; Enter opens the focused one (a button).
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const items = [...(card.current?.querySelectorAll<HTMLButtonElement>('[data-welcome-item]') ?? [])];
      const active = document.activeElement;
      const at = items.findIndex((el) => el === active);
      // Only from one of the items or from nowhere: a sheet or a field keeps its own keys.
      if (at < 0 && active && active !== document.body) return;
      const next = welcomeNext(at < 0 ? null : at, e.key, items.length);
      if (next === null) return;
      e.preventDefault();
      items[next]!.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Forgetting a recent folder (its × or Delete): the list answers with the recents left. From the keyboard the focus
  // goes on to the row that took its place (the last one, or Open Folder when none is left).
  const refocus = useRef<number | null>(null);
  const forget = (p: string, keyboard: boolean) => {
    const at = recent.indexOf(p);
    void window.atelier.forgetRecent(p).then((left) => {
      if (keyboard) refocus.current = at;
      setRecent(left);
    }).catch(() => {});
  };
  useEffect(() => {
    const at = refocus.current;
    if (at === null) return;
    refocus.current = null;
    const items = [...(card.current?.querySelectorAll<HTMLButtonElement>('[data-welcome-item]') ?? [])];
    items[Math.min(at + 1, items.length - 1)]?.focus();
  }, [recent]);
  return (
    <div className="welcome">
      <div ref={card} className="welcome-card pop">
        <Logo size={72} />
        <h1>{t.welcomeTitle}</h1>
        <p>{t.welcomeBody}</p>
        <button type="button" className="btn-primary btn-lg" data-welcome-item onClick={() => void window.atelier.openFolder()}>
          <Icon name="folderOpen" size={15} />{t.openFolder}
        </button>
        {recent.length > 0 && (
          <div className="welcome-recent">
            <span className="section-label">{t.recent}</span>
            {recent.map((p, i) => (
              <div key={p} className="recent-item enter" style={{ animationDelay: `${i * 30}ms` }}>
                <button
                  type="button" className="recent-row" data-welcome-item aria-keyshortcuts="Delete Backspace"
                  onClick={() => void window.atelier.openRecent(p)}
                  onKeyDown={(e) => {
                    if (e.altKey || e.ctrlKey || e.shiftKey || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
                    e.preventDefault();
                    // A held key would go on down the list (the focus moves to the next row): one folder per press.
                    if (!e.repeat) forget(p, true);
                  }}
                >
                  <Icon name="files" size={14} />
                  <span className="recent-name">{p.split('/').filter(Boolean).at(-1)}</span>
                  <span className="recent-path mono">{shortPath(p)}</span>
                </button>
                {/* Out of the Tab and arrow walk (a press never takes the focus from the rows): from the keyboard, Delete
                    on the row does the same. A double click forgets one folder, not the next one too as it moves up. */}
                <button
                  type="button" className="recent-forget" tabIndex={-1} aria-label={t.forgetRecent} title={t.forgetRecent}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { if (e.detail <= 1) forget(p, false); }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
