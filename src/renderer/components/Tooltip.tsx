import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { placeTip } from '../menu-model';
import { useApp } from '../store';

interface Tip { text: string; kbd?: string; el: { left: number; right: number; top: number; bottom: number } }

/** Aurora tooltip for every element with data-tip (and data-kbd), after 400 ms; plus terminal links. */
export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const linkTip = useApp((s) => s.linkTip);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    const hide = () => { if (timer) clearTimeout(timer); timer = null; current = null; setTip(null); if (useApp.getState().linkTip) useApp.getState().setLinkTip(null); };
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]') ?? null;
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        setTip({ text: el.dataset.tip ?? '', kbd: el.dataset.kbd, el: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
      }, 400);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    return () => { hide(); document.removeEventListener('mouseover', over); document.removeEventListener('mousedown', hide, true); document.removeEventListener('wheel', hide, { capture: true }); window.removeEventListener('blur', hide); };
  }, []);

  // A terminal link: a point under the pointer stands for the element.
  const shown: Tip | null = linkTip ? { text: linkTip.text, el: { left: linkTip.x, right: linkTip.x, top: linkTip.y, bottom: linkTip.y + 10 } } : tip;
  useLayoutEffect(() => {
    if (!shown || !box.current) { setPos(null); return; }
    const r = box.current.getBoundingClientRect();
    setPos(placeTip(shown.el, r.width, r.height, window.innerWidth, window.innerHeight, 6));
  }, [shown?.text, shown?.el.left, shown?.el.top]);

  if (!shown || !shown.text) return null;
  return (
    <div ref={box} className="tooltip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
      {shown.text.includes('\n') ? (
        // A rich tip (e.g. the PR chip): one line per row, the first one as its heading.
        <span className="tooltip-lines">{shown.text.split('\n').map((line, i) => <span key={i} className={i === 0 ? 'tooltip-line is-head' : 'tooltip-line'}>{line}</span>)}</span>
      ) : (
        <span className="tooltip-text">{shown.text}</span>
      )}
      {shown.kbd && <span className="tooltip-kbd mono">{shown.kbd}</span>}
    </div>
  );
}
