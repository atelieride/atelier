import mark from '../../assets/brand/mark.svg?raw';

let n = 0;

/**
 * The mark's colors as the theme's (--mark-a, --mark-b, --mark-lambda), Aurora's where no theme sets them; as styles,
 * since presentation attributes don't read custom properties. The file itself stays Aurora's (the website, the app
 * icon's sources).
 */
const themed = (svg: string) => svg
  .replace('stop-color="#8B5CF6"', 'style="stop-color: var(--mark-a, #8B5CF6)"')
  .replace('stop-color="#EC4899"', 'style="stop-color: var(--mark-b, #EC4899)"')
  .replace('stroke="#FFFFFF"', 'style="stroke: var(--mark-lambda, #FFFFFF)"');

/** The mark as SVG, with a unique gradient id for every copy on the page, in the theme's colors. */
export function markSvg(size: number): string {
  const id = `atl-g-${++n}`;
  return themed(mark.replace(/ATL_G/g, id).replace('width="72" height="72"', `width="${size}" height="${size}"`));
}

/**
 * The mark's paint seen through `view` (a box in its 72-unit square), stretched to whatever box holds it, at
 * `opacity`: the launch animation's plates, each showing the part of the mark it covers. In the theme's colors.
 */
export function markPaint(view: { x: number; y: number; w: number; h: number }, opacity: number): string {
  const id = `atl-g-${++n}`;
  const defs = /<defs>[\s\S]*?<\/defs>/.exec(mark)?.[0] ?? '';
  // The paint's own frame (the mark's group offset), and a fill wider than the mark so any view is covered.
  const group = /<g transform="[^"]*">/.exec(mark)?.[0] ?? '<g>';
  return themed(`<svg viewBox="${view.x} ${view.y} ${view.w} ${view.h}" preserveAspectRatio="none">${defs}${group}`
    + `<rect x="-72" y="-72" width="216" height="216" fill="url(#ATL_G)" opacity="${opacity}"/></g></svg>`).replace(/ATL_G/g, id);
}
