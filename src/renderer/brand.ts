import mark from '../../assets/brand/mark.svg?raw';

let n = 0;

/**
 * The mark as SVG, with a unique gradient id for every copy on the page. Its colors are the theme's (--mark-a,
 * --mark-b, --mark-lambda), Aurora's where no theme sets them; as styles, since presentation attributes
 * don't read custom properties. The file itself stays Aurora's (the website, the app icon's sources).
 */
export function markSvg(size: number): string {
  const id = `atl-g-${++n}`;
  return mark.replace(/ATL_G/g, id).replace('width="72" height="72"', `width="${size}" height="${size}"`)
    .replace('stop-color="#8B5CF6"', 'style="stop-color: var(--mark-a, #8B5CF6)"')
    .replace('stop-color="#EC4899"', 'style="stop-color: var(--mark-b, #EC4899)"')
    .replace('stroke="#FFFFFF"', 'style="stroke: var(--mark-lambda, #FFFFFF)"');
}
