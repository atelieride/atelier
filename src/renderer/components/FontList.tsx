import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fontStack } from '@shared/terminal-font';
import { activeOnLoad, fontChoices, useInstalledFonts, type FontChoice } from '../terminal/installed-fonts';
import { stepActive } from '../palette-query';
import { keepFontPreview, previewTerminalFont } from '../settings-live';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';

const NONE: readonly string[] = [];

/**
 * Browsing the terminal fonts, for the Settings popover and the palette sheet:
 * the active font is on screen at once (every terminal, Settings' preview), Enter or a click keeps it, Esc goes back.
 * Closed any other way (another sheet, the window's state), the preview goes.
 */
export function useFontBrowse(onClose: (kept: boolean) => void) {
  const current = useApp((s) => s.settings.terminalFontFamily);
  const { fonts, reading, retry } = useInstalledFonts();
  const mono = fonts && fonts !== 'failed' ? fonts.mono : NONE;
  const [query, setQuery] = useState('');
  const choices = useMemo(() => fontChoices(mono, query), [mono, query]);
  const [active, setActive] = useState(current);
  const kept = useRef(false);
  useEffect(() => () => { if (!kept.current) previewTerminalFont(null); }, []);

  const index = choices.flat.findIndex((c) => c.family === active);
  const show = (family: string | undefined) => {
    if (!family) return;
    setActive(family);
    previewTerminalFont(family === current ? null : family);
  };
  // Typed before the installed fonts arrived: the search found nothing then, its best match is selected now.
  useEffect(() => {
    const next = activeOnLoad(query, choices.flat, active);
    if (next) show(next);
  }, [mono]); // only when the list itself changes
  const move = (delta: 1 | -1) => {
    const n = choices.flat.length;
    if (!n) return;
    // From a font that isn't listed (a search moved past it, a saved font that isn't installed): the first or last.
    show(choices.flat[index === -1 ? (delta === 1 ? 0 : n - 1) : stepActive(index, delta, n)]!.family);
  };
  // The best match is shown, so Enter keeps what is on screen.
  const search = (q: string) => {
    setQuery(q);
    show(fontChoices(mono, q).flat[0]?.family);
  };
  const keep = (family: string | undefined) => {
    if (!family) return;
    kept.current = true;
    if (family === current) previewTerminalFont(null);
    // The font stays on screen until main sends the saved settings back with it: nothing flickers.
    else { keepFontPreview(); void window.atelier.settings.set({ terminalFontFamily: family }); }
    onClose(true);
  };
  const back = () => {
    previewTerminalFont(null);
    onClose(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); }
    else if (e.key === 'Enter') { e.preventDefault(); keep(choices.flat[index]?.family); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  };
  return { current, fonts, reading, retry, query, search, choices, index, show, keep, back, onKey, total: 1 + mono.length };
}

export type FontBrowse = ReturnType<typeof useFontBrowse>;

/** Scrolls `list` so `row` shows (the first row with its section's title); scrollIntoView would move the page too. */
function keepInView(list: HTMLElement | null, row: HTMLElement | null, first: boolean): void {
  if (!list || !row) return;
  if (first) { list.scrollTop = 0; return; }
  const l = list.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < l.top) list.scrollTop -= l.top - r.top + 4;
  else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + 4;
}

/** The list both pickers show: Atelier's font, the installed monospaced ones, and why there may be none. */
export function FontList({ b, idPrefix, variant }: { b: FontBrowse; idPrefix: string; variant: 'pop' | 'sheet' }) {
  // The arrows can walk past the visible rows: the list (and only the list, never the page) scrolls to the active one.
  useEffect(() => { keepInView(document.getElementById(`${idPrefix}-scroll`), document.getElementById(`${idPrefix}-${b.index}`), b.index === 0); }, [b.index, idPrefix]);
  const { choices, fonts, current } = b;
  const row = (c: FontChoice, i: number) => {
    const inUse = c.family === current;
    const stack = fontStack(c.family);
    const hint = [c.bundled ? t.fontPick.defaultHint : '', inUse ? t.fontPick.inUse : ''].filter(Boolean).join(' · ');
    return (
      <button key={c.family} id={`${idPrefix}-${i}`} type="button" role="option" aria-selected={i === b.index} tabIndex={-1}
        aria-label={hint ? `${c.family}, ${hint}` : c.family}
        className={`palette-item font-item ${i === b.index ? 'is-active' : ''} ${inUse ? 'is-current' : ''}`}
        onMouseMove={() => { if (i !== b.index) b.show(c.family); }} onClick={() => b.keep(c.family)}>
        {variant === 'sheet'
          ? <span className={`palette-cmd font-glyph ${inUse ? 'is-current' : ''}`}>{inUse ? <Icon name="check" size={11} stroke={2} /> : 'Aa'}</span>
          : <span className="font-check">{inUse && <Icon name="check" size={12} stroke={2} />}</span>}
        <span className="font-name" style={{ fontFamily: stack }}>{c.family}</span>
        {variant === 'sheet' && hint && <span className="font-hint">{hint}</span>}
        <span className="font-sample" style={{ fontFamily: stack }} aria-hidden="true">{t.fontPick.sample}</span>
        {variant === 'pop' && c.bundled && <span className="font-tag">{t.fontPick.default}</span>}
      </button>
    );
  };
  const nothing = fonts !== null && fonts !== 'failed' && choices.flat.length === 0;
  const installedTitle = variant === 'pop' ? t.fontPick.installed : t.fontPick.installedShort;
  // Only the sections and their options are in the listbox; what explains an empty or missing list sits after it.
  return (
    <div className={`palette-list font-list is-${variant}`} id={`${idPrefix}-scroll`}>
      <div role="listbox" id={`${idPrefix}-list`} aria-label={t.fontPick.list}>
        {choices.bundled.length > 0 && (
          <div role="group" aria-label={t.fontPick.bundled}>
            <div className="palette-section" aria-hidden="true">{t.fontPick.bundled}</div>
            {choices.bundled.map((c, i) => row(c, i))}
          </div>
        )}
        {choices.installed.length > 0 && (
          <div role="group" aria-label={installedTitle}>
            <div className="palette-section has-glyph" aria-hidden="true">
              {installedTitle}<span className="palette-count mono">{choices.installed.length}</span>
            </div>
            {choices.installed.map((c, i) => row(c, i + choices.bundled.length))}
          </div>
        )}
      </div>
      {(fonts === null || (fonts === 'failed' && b.reading)) && (
        <>
          <div className="palette-section">{installedTitle}</div>
          <p className="font-reading" role="status">{t.fontPick.reading}</p>
        </>
      )}
      {fonts === 'failed' && !b.reading && (
        <div className="font-failed" role="note">
          <Icon name="info" size={14} stroke={1.8} />
          <span>{t.fontPick.failed}</span>
          {/* The focus stays in the search field: the keys keep working, and nothing falls to <body> when it goes. */}
          <button type="button" className="btn-ghost" onMouseDown={(e) => e.preventDefault()} onClick={b.retry}>{t.fontPick.retry}</button>
        </div>
      )}
      {nothing && (
        <div className="font-empty" role="status">
          <span>{t.fontPick.empty(b.query.trim())}</span>
          <small>{t.fontPick.emptyWhy}</small>
        </div>
      )}
    </div>
  );
}
