// The index of /features: marks the entry of the section being read with
// aria-current="location". Only an enhancement: without it the index is a list of anchors.
// The section being read is the first one crossing a band under the header (an IntersectionObserver: no work while
// scrolling inside a section). Past the last one (the closing, the footer), the last stays marked; above the first
// (the page's head), none is.
const nav = document.querySelector<HTMLElement>('nav.toc');
if (nav) {
  const entries: [HTMLElement, HTMLAnchorElement][] = [];
  for (const a of nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    const el = document.getElementById(decodeURIComponent(a.hash.slice(1)));
    if (el) entries.push([el, a]);
  }
  const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--appbar-h')) || 60;
  const top = header + 32;
  const crossing = new Set<Element>();
  let current: HTMLAnchorElement | null = null;
  const mark = () => {
    let pick = entries.find(([el]) => crossing.has(el));
    if (!pick) {
      const above = entries.filter(([el]) => el.getBoundingClientRect().top < top);
      pick = above.length === entries.length ? above.at(-1) : undefined;
    }
    const a = pick?.[1] ?? null;
    if (a === current) return;
    current?.removeAttribute('aria-current');
    a?.setAttribute('aria-current', 'location');
    current = a;
  };
  const io = new IntersectionObserver((changes) => {
    for (const c of changes) if (c.isIntersecting) crossing.add(c.target); else crossing.delete(c.target);
    mark();
  }, { rootMargin: `-${top}px 0px -60% 0px` });
  for (const [el] of entries) io.observe(el);
}
