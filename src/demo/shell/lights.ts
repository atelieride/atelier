import { h } from './dom';

// The window's traffic lights, drawn by the shell where the app leaves them room (the
// top bar's .traffic-space) and where macOS puts them: 12 px, 8 px apart, 20 px in, centred in the 45 px top bar.
// Red leaves the demo, yellow goes back into the page, green is the browser's full screen. Hovering the group shows
// the glyphs, as on a Mac.

const SVG_NS = 'http://www.w3.org/2000/svg';
const GLYPHS = {
  close: { d: 'M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8', fill: false },
  min: { d: 'M2.8 6h6.4', fill: false },
  max: { d: 'M3.2 3.2h3.9L3.2 7.1zM8.8 8.8H4.9l3.9-3.9z', fill: true }
} as const;

function glyph(kind: keyof typeof GLYPHS): SVGSVGElement {
  const g = GLYPHS[kind];
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', g.d);
  if (g.fill) path.setAttribute('fill', 'currentColor');
  else { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.3'); path.setAttribute('stroke-linecap', 'round'); }
  svg.append(path);
  return svg;
}

export function createLights(layer: HTMLElement, d: { exit(): void; minimize(): void; fullscreen(): void }) {
  const light = (kind: keyof typeof GLYPHS, label: string, run: () => void) => {
    const b = h('button', { type: 'button', class: `dm-light is-${kind}`, 'aria-label': label, title: label }, glyph(kind));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', run);
    return b;
  };
  const max = light('max', 'Full screen', d.fullscreen);
  const group = h('div', { class: 'dm-lights', role: 'group', 'aria-label': 'Window' },
    light('close', 'Exit demo', d.exit), light('min', 'Back to the page', d.minimize), max);
  layer.append(group);
  return {
    setFullscreen(on: boolean) {
      const label = on ? 'Exit full screen' : 'Full screen';
      max.setAttribute('aria-label', label);
      max.title = label;
      group.classList.toggle('is-fullscreen', on);
    }
  };
}
