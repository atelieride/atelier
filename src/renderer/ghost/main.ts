// The tear-off ghost: a static page main fills in while a tab is dragged outside the
// project window — the pop-out-to-be, its bar with the tab's glyph and title, its view's snapshot or a hint. Not an app
// page: no preload, no IPC. Main calls window.__ghost with JSON-encoded values; text goes in with textContent only.
import '../theme.css';
import '../themes.css';
import '../themes-docsy.css';
import './ghost.css';
import { loadFonts, loadThemeFonts } from '../fonts';
import { initialOf } from '../avatar';
import { t } from '../i18n/en';

type GhostIcon = 'session' | 'session-tile' | 'terminal' | 'file' | 'view';
interface GhostInfo { title: string; icon: GhostIcon; color?: string; reduced?: boolean; theme?: string }

const SVG = 'http://www.w3.org/2000/svg';
// Paths from components/Icon.tsx (20×20, stroked).
const PATHS: Record<Exclude<GhostIcon, 'session' | 'session-tile'> | 'sessions' | 'grip' | 'window', string> = {
  sessions: 'M3.5 4.5h13v9h-8l-5 3.5z',
  terminal: 'M4 6l4 4-4 4M10 15h6',
  file: 'M6 2.5h5.5L15.5 6.5V17.5H6zM11.5 2.5v4h4',
  view: 'M3.5 4.5h13v11h-13zM3.5 8h13',
  grip: 'M7.5 5h.01M12.5 5h.01M7.5 10h.01M12.5 10h.01M7.5 15h.01M12.5 15h.01',
  window: 'M3 6h11v11H3zM9 3h8v8M17 3l-7 7'
};

function icon(name: keyof typeof PATHS, size: number, stroke: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(...kids);
  return e;
};

const glyph = el('span', 'ghost-glyph');
const title = el('span', 'ghost-title');
const shot = el('img', 'ghost-shot');
shot.alt = '';
const hint = el('div', 'ghost-hint', el('span', 'ghost-hint-icon', icon('window', 18, 1.7)), el('span', '', t.popout.ghostHint));
const body = el('div', 'ghost-body', hint, shot);
const card = el('div', 'ghost',
  el('div', 'ghost-bar',
    el('span', 'ghost-lights', el('i', ''), el('i', ''), el('i', '')),
    el('span', 'ghost-grip', icon('grip', 14, 2.6)),
    glyph, title),
  body);

function fill(info: GhostInfo): void {
  // Settings › Reduce motion (the system setting is read by the stylesheet too).
  if (info.reduced) document.documentElement.dataset.motion = 'reduced';
  // The theme of the window the tab leaves (one of the theme ids: main's schema checked it).
  if (info.theme) document.documentElement.dataset.theme = info.theme;
  // A theme with a face of its own (Docsy's Poppins): the card waits for it rather than swap fonts
  // under the pointer. Once fetched, it resolves before the next frame.
  card.classList.add('is-fonts-pending');
  void loadThemeFonts().finally(() => card.classList.remove('is-fonts-pending'));
  title.textContent = info.title;
  glyph.replaceChildren();
  glyph.className = 'ghost-glyph';
  if (info.icon === 'session') {
    const av = el('span', 'ghost-avatar', initialOf(info.title));
    // A CSS colour from main's schema; set through the CSSOM, never as markup.
    if (info.color) av.style.setProperty('--id', info.color);
    glyph.append(av);
  } else if (info.icon === 'session-tile') {
    // Session avatars off: the tile the tab shows.
    glyph.append(el('span', 'ghost-tile', icon('sessions', 12, 2)));
  } else {
    glyph.append(icon(info.icon, 14, 1.9));
  }
}

function snapshot(url: string): void {
  if (!url.startsWith('data:image/')) return;
  shot.onload = () => body.classList.add('has-shot');
  shot.src = url;
}

(window as { __ghost?: unknown }).__ghost = { fill, snapshot };
void loadFonts().catch(() => {}).finally(() => document.body.append(card));
