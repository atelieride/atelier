import type { Segment } from './checklist';

// The shell's DOM, written by hand (it runs before React, beside it, never inside it): a few small helpers.

type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

/** A keycap as the app draws it (.kbd). */
export const kbd = (text: string) => h('kbd', { class: 'kbd dm-kbd' }, text);

export function renderSegments(segs: readonly Segment[]): Node[] {
  return segs.map((s) => (s.kind === 'kbd' ? kbd(s.text) : s.kind === 'code' ? h('code', { class: 'dm-code' }, s.text) : document.createTextNode(s.text)));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A stroked 20×20 icon, as components/Icon.tsx draws them. */
export function icon(d: string, size = 14, stroke = 1.7): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export const ICONS = {
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  check: 'M5 10.5l3.2 3.2L15 7',
  chevronUp: 'M6 12l4-4 4 4',
  chevronRight: 'M8 6l4 4-4 4',
  download: 'M10 3.5v9M6.5 9l3.5 3.5L13.5 9M4.5 16h11',
  exit: 'M8 4.5H5.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H8M12 7l3 3-3 3M15 10H8',
  mac: 'M4 5.5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 11.5zM8 16h4M10 13v3'
} as const;

/** Whether the visitor asked for less motion (the OS, or the app's own setting on <html>). */
export const reducedMotion = () => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
