// The header in one row: merged with the page at the top, a frosted fill and a
// line once it scrolls; the Changelog dot; the search sheet. Everything here is an enhancement: without it the header
// stays merged, the pages are links and the search button does nothing.
import { changelogDot } from '../lib/changelog-dot';
import { activePage } from '../lib/header';
import { search, type Hit, type Range, type SearchItem } from '../lib/search';

const bar = document.querySelector<HTMLElement>('header.appbar');
const sheet = document.querySelector<HTMLDialogElement>('dialog.search-sheet');
if (bar) initBar(bar);
if (bar && sheet) initSearch(bar, sheet);
if (bar) bar.dataset.ready = '';

function initBar(bar: HTMLElement) {
  // The fill and the line once the page has left the top (a page opened mid-way, at a section or on reload, too).
  const onScroll = () => bar.classList.toggle('is-scrolled', window.scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // The Changelog dot: kept in this browser only; storage may be unavailable (private windows), then no dot. Computed
  // again when Back restores a page from the cache: the changelog may have been opened in between.
  const link = bar.querySelector<HTMLElement>('a[data-page="changelog"]');
  const dot = link?.querySelector<HTMLElement>('.dot');
  const latest = bar.dataset.latest;
  const updateDot = () => {
    if (!link || !dot || !latest) return;
    let show = false;
    try {
      const KEY = 'atelier.changelog-seen';
      const d = changelogDot(localStorage.getItem(KEY), latest, activePage(location.pathname) === 'changelog');
      if (d.store) localStorage.setItem(KEY, d.store);
      show = d.show;
    } catch { /* no storage: no dot */ }
    dot.hidden = !show;
    if (show) link.setAttribute('aria-description', 'New since your last visit'); else link.removeAttribute('aria-description');
  };
  updateDot();
  addEventListener('pageshow', (e) => { if (e.persisted) updateDot(); });
}

function initSearch(bar: HTMLElement, sheet: HTMLDialogElement) {
  const input = sheet.querySelector<HTMLInputElement>('input')!;
  const list = sheet.querySelector<HTMLElement>('.sheet-list')!;
  const button = bar.querySelector<HTMLButtonElement>('button.search')!;
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
    const kbd = button.querySelector('.kbd');
    if (kbd) kbd.textContent = 'Ctrl K';
  }
  const status = sheet.querySelector<HTMLElement>('.sheet-status')!;
  const note = sheet.querySelector<HTMLElement>('.sheet-note')!;
  let index: Promise<SearchItem[] | null> | null = null;
  // null: the index could not be fetched (the next open tries again).
  const load = () => (index ??= fetch('/search.json')
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<SearchItem[]>; })
    .catch(() => { index = null; return null; }));
  let state: 'loading' | 'ready' | 'failed' = 'loading';
  let items: SearchItem[] = [];
  let hits: Hit[] = [];
  let sel = 0;

  const RINGS: Record<string, string> = { Overview: 'var(--violet)', Features: 'var(--working)', Changelog: 'var(--pink)', Download: 'var(--done)' };
  const el = (tag: string, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const marked = (cls: string, text: string, range: Range | null) => {
    const e = el('span', cls);
    if (!range) { e.textContent = text; return e; }
    e.append(text.slice(0, range[0]), el('mark', undefined, text.slice(range[0], range[1])), text.slice(range[1]));
    return e;
  };
  const glyph = (item: SearchItem) => {
    if (item.href === '/support') {
      // The one page with a heart: filled, white on the brand gradient; it beats while selected.
      const g = el('span', 'sheet-glyph is-heart');
      g.innerHTML = '<svg width="11" height="11" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 17.2s-7.2-4.2-7.2-9.3A3.9 3.9 0 0 1 10 5.9a3.9 3.9 0 0 1 7.2 2c0 5.1-7.2 9.3-7.2 9.3z"/></svg>';
      return g;
    }
    if (item.href.startsWith('https://github.com/')) {
      // The code: GitHub's mark, light on dark like the site.
      const g = el('span', 'sheet-glyph is-github');
      g.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';
      return g;
    }
    if (item.group === 'Pages') {
      const g = el('span', 'sheet-glyph is-page', item.label[0]);
      g.style.setProperty('--ring', RINGS[item.label] ?? 'var(--violet)');
      return g;
    }
    if (item.group === 'Features') return el('span', 'sheet-glyph is-feature', '#');
    if (item.group === 'Changelog') return item.latest ? el('span', 'sheet-glyph is-new', '★') : el('span', 'sheet-glyph', 'v');
    if (item.group === 'Shortcuts') return el('span', 'sheet-glyph', '⌘');
    return el('span', 'sheet-glyph', '+');
  };

  const select = (i: number) => {
    sel = hits.length ? (i + hits.length) % hits.length : 0;
    list.querySelectorAll('[role="option"]').forEach((o, j) => o.setAttribute('aria-selected', String(j === sel)));
    const on = list.querySelector<HTMLElement>(`#sheet-opt-${sel}`);
    if (on) { input.setAttribute('aria-activedescendant', on.id); on.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const message = (title: string, text: string) => {
    const m = el('div', 'sheet-empty');
    m.append(el('b', undefined, title), el('span', undefined, text));
    return m;
  };
  const render = () => {
    const q = input.value.trim();
    const groups = state === 'ready' ? search(items, input.value) : [];
    hits = groups.flatMap((g) => g.hits);
    list.replaceChildren();
    input.setAttribute('aria-expanded', String(hits.length > 0));
    if (!hits.length) {
      const m = state === 'loading' ? message('Loading…', 'The index is on its way.')
        : state === 'failed' ? message('Search is unavailable', 'Check your connection and open it again.')
        : q ? message(`No results for “${q}”`, 'Try a feature or a version, like “split” or “beta.7”.') : null;
      note.replaceChildren(...(m ? [m] : []));
      status.textContent = m ? `${m.firstChild?.textContent ?? ''}.` : '';
      select(0);
      return;
    }
    note.replaceChildren();
    status.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'}`;
    let i = 0;
    for (const [n, g] of groups.entries()) {
      const group = el('div', 'sheet-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-labelledby', `sheet-sec-${n}`);
      const head = el('div', 'sheet-section', g.title);
      head.id = `sheet-sec-${n}`;
      group.append(head);
      list.append(group);
      for (const h of g.hits) {
        const o = el('div', h.item.href === '/support' ? 'sheet-item is-support' : 'sheet-item');
        o.id = `sheet-opt-${i}`;
        o.setAttribute('role', 'option');
        o.dataset.i = String(i++);
        o.append(glyph(h.item), marked('sheet-label', h.item.label, h.label));
        if (h.item.keys) {
          const caps = el('span', 'sheet-caps');
          for (const k of h.item.keys) caps.append(el('kbd', 'kbd', k));
          o.append(caps);
        } else if (h.item.href === '/support') {
          o.append(el('span', 'sheet-hint is-love', 'keeps Atelier free'));
        } else if (h.item.group !== 'Pages') {
          o.append(marked(`sheet-hint${h.item.group === 'Changelog' ? ' is-version' : ''}`, h.item.hint, h.hint));
        }
        group.append(o);
      }
    }
    select(0);
  };

  const open = async () => {
    if (sheet.open) return;
    input.value = '';
    sheet.showModal();
    input.focus();
    if (state !== 'ready') { state = 'loading'; render(); }
    const got = await load();
    if (got) { items = got; state = 'ready'; } else state = 'failed';
    if (sheet.open) render();
  };
  const go = (item: SearchItem) => {
    sheet.close();
    const url = new URL(item.href, location.href);
    const here = (p: string) => p.replace(/\.html$/, '').replace(/\/index$/, '/');
    if (here(url.pathname) !== here(location.pathname)) { location.href = url.href; return; }
    if (!url.hash) { history.replaceState(null, '', url.pathname); scrollTo({ top: 0 }); return; }
    // Setting the hash it already has does nothing: scroll there ourselves (scroll-padding and smooth scroll apply).
    if (url.hash === location.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
    else location.hash = url.hash;
  };

  button.addEventListener('click', open);
  button.addEventListener('pointerenter', load, { once: true });
  button.addEventListener('focus', load, { once: true });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); select(sel + (e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); const h = hits[sel]; if (h) go(h.item); }
  });
  list.addEventListener('pointermove', (e) => {
    const o = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (o && Number(o.dataset.i) !== sel) select(Number(o.dataset.i));
  });
  list.addEventListener('click', (e) => {
    const o = (e.target as Element).closest<HTMLElement>('[role="option"]');
    const h = o ? hits[Number(o.dataset.i)] : undefined;
    if (h) go(h.item);
  });
  // A click outside the sheet lands on the dialog itself: close, unless it began inside (a drag selecting the query).
  let downOnBackdrop = false;
  sheet.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === sheet; });
  sheet.addEventListener('click', (e) => { if (e.target === sheet && downOnBackdrop) sheet.close(); });
  addEventListener('keydown', (e) => {
    // The live demo is opening or open: every key is the app's. Its keys stay in its
    // iframe, and the stage hands any stray one back to it; this is the belt to those braces.
    if (e.repeat || 'demo' in document.documentElement.dataset) return;
    // The sheet's own field does not count: right after Esc it can still hold the focus while the sheet is closed.
    const typing = e.target instanceof HTMLElement && !sheet.contains(e.target)
      && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (sheet.open) sheet.close(); else void open();
    } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !sheet.open) {
      e.preventDefault();
      void open();
    }
  });
}
