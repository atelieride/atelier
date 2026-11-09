import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import changelog from '../../../CHANGELOG.md?raw';
import { CHANGELOG_URL, changeCount, whatsNewSections } from '@shared/whats-new';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Notes } from './Notes';

/**
 * After an update, once: the CHANGELOG sections since the version of the previous launch, newest
 * open, older ones collapsed; also from Atelier › What's New… and the palette. The changelog ships inside the app, so
 * skipped versions are there too. Escape, the backdrop or "Got it" close it.
 */
export function WhatsNew({ since }: { since: string | null }) {
  const close = () => useApp.getState().setWhatsNew(null);
  const [version, setVersion] = useState<string | null>(() => useApp.getState().updateStatus?.version ?? null);
  useEffect(() => { if (!version) void window.atelier.appInfo().then((i) => { if (i) setVersion(i.version); }).catch(() => {}); }, [version]);
  const { sections, more } = useMemo(() => (version ? whatsNewSections(changelog, since, version) : { sections: [], more: 0 }), [since, version]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The newest version starts open.
  useEffect(() => { if (sections[0]) setOpen(new Set([sections[0].version])); }, [sections]);
  const toggle = (v: string) => setOpen((o) => { const n = new Set(o); if (n.has(v)) n.delete(v); else n.add(v); return n; });
  const done = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { done.current?.focus(); }, []);
  // As in Settings: Esc closes and Tab stays inside the sheet, wherever the focus was; nothing reaches the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = sheet.current;
      if (!root) return;
      // A menu or another dialog in front handles its own keys.
      const focus = document.activeElement as HTMLElement | null;
      if (focus?.closest('.ctx-menu') || (focus?.closest('[role="dialog"]') && !root.contains(focus))) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      const inside = root.contains(document.activeElement);
      if (!inside) { e.preventDefault(); e.stopPropagation(); items[0]?.focus(); return; }
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Edge fades only where there is more to scroll.
  const body = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = () => { const b = body.current; if (b) setEdges({ top: b.scrollTop > 2, bottom: b.scrollTop + b.clientHeight < b.scrollHeight - 2 }); };
  useLayoutEffect(measure, [sections, open]);
  const full = () => void window.atelier.openUrl(CHANGELOG_URL);

  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={close}>
      <div ref={sheet} className="wn" role="dialog" aria-modal="true" aria-label={t.wn.label} onMouseDown={(e) => e.stopPropagation()}>
        <header className="wn-head">
          <span className="wn-mark"><Logo size={26} /></span>
          <div className="wn-titles">
            <h2>{t.wn.title}</h2>
            {since && <span className="wn-from">{t.wn.updatedFrom(since)}</span>}
          </div>
          {version && <span className="wn-version mono" data-tip={t.wn.current}>{version}</span>}
        </header>
        <div ref={body} className={`wn-body ${edges.top ? 'has-top' : ''} ${edges.bottom ? 'has-bottom' : ''}`} onScroll={measure}>
          {sections.length === 0 && <p className="wn-empty">{t.wn.empty}</p>}
          {sections.map((s, i) => {
            const isOpen = open.has(s.version);
            return (
              <section key={s.version} className={`wn-rel ${isOpen ? 'is-open' : ''}`}>
                <button type="button" className="wn-rel-head" aria-expanded={isOpen} onClick={() => toggle(s.version)}>
                  <Icon name="chevron" size={11} stroke={2.2} />
                  <span className="wn-rel-version mono">{s.version}</span>
                  {i === 0 && <span className="wn-latest">{t.wn.latest}</span>}
                  {!isOpen && changeCount(s.body) > 0 && <span className="wn-count">{t.wn.changes(changeCount(s.body))}</span>}
                </button>
                {isOpen && <Notes text={s.body} className="wn-notes" />}
              </section>
            );
          })}
          {more > 0 && <button type="button" className="wn-more link-btn" onClick={full}>{t.wn.more(more)} · {t.wn.full}</button>}
        </div>
        <footer className="wn-foot">
          <button type="button" className="link-btn" onClick={full}>{t.wn.full}<Icon name="chevron" size={10} stroke={2.2} /></button>
          <span className="grow" />
          <button ref={done} type="button" className="btn-primary" onClick={close}>{t.wn.done}</button>
        </footer>
      </div>
    </div>
  );
}
