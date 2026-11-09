// Relations: this table in the middle, the tables it points to on
// the left (N:1), those pointing at it on the right (1:N), a self-reference as a loop; nodes are buttons over the
// edges (Tab order: the left column top to bottom, then the right) that open their table — a click the preview, a
// double click or Enter a kept tab, Space the preview, ⌥-click to the side, a right-click the table's menu. The
// diagram (relations.ts lays it out) is Structure's Relations card and, bigger, the Relations view; it fits the width
// it is given, measured, its columns as wide as their names need (measured too: follow-up 1), and grows downwards (the
// card scrolls) rather than piling nodes up. Lazy, with the table's chunk and its stylesheet.
import './structure.css';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DbFk, DbRelations } from '@shared/databases';
import { tdt } from '../i18n/db-table';
import { edgePaths, layoutRelations, relationsGeometry, type RelEdge, type RelNeed, type RelNode, type RelSide } from './relations';
import { readPart, useStruct } from './structure-data';
import { PartFailed, Skeleton, tableLink } from './structure-ui';
import type { DbTabRef } from './tabs';

const s = tdt.struct;

/** The element's width and height as drawn, `guess` until measured (a markup render, a hidden tab). */
function useBox(guess: { w: number; h: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(guess);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0) setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

const SIDES: readonly RelSide[] = ['left', 'center', 'right'];
let pen: CanvasRenderingContext2D | null | undefined;

/** `text`'s width in `el`'s font, on a canvas (a hidden tab's nodes measure too). */
function textWidth(el: Element, text: string): number {
  pen ??= document.createElement('canvas').getContext('2d');
  if (!pen) return 0;
  const cs = getComputedStyle(el);
  pen.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return pen.measureText(text).width;
}

/** The layout sizes text in 1/64 px steps, rounding up: a canvas width this much wider always holds it. */
const LAYOUT_ROUNDING = 0.1;
const px = (v: string) => Number.parseFloat(v) || 0;

/**
 * What each side's nodes need for their names whole (relationsGeometry's `needs`, follow-up 1), read from the nodes as
 * drawn: the widest name in its own font, and around it the node's padding and border, the 1:N mark and its gap; the
 * view's second lines (the keys' columns) as `sub`.
 */
function measureNeeds(plane: HTMLElement): Record<RelSide, RelNeed> {
  const out: Record<RelSide, RelNeed> = { left: { text: 0, chrome: 0 }, center: { text: 0, chrome: 0 }, right: { text: 0, chrome: 0 } };
  for (const node of plane.querySelectorAll<HTMLElement>('.dbr-node')) {
    const side = SIDES.find((s) => node.classList.contains(`is-${s}`));
    const name = node.querySelector('.dbr-node-name');
    if (!side || !name) continue;
    const cs = getComputedStyle(node);
    const mark = node.querySelector('.dbr-node-n');
    const via = node.querySelector('.dbr-node-via');
    const need = out[side];
    need.text = Math.max(need.text, textWidth(name, name.textContent ?? '') + LAYOUT_ROUNDING);
    if (via) need.sub = Math.max(need.sub ?? 0, textWidth(via, via.textContent ?? '') + LAYOUT_ROUNDING);
    need.chrome = Math.max(need.chrome, px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)
      + (mark ? px(cs.columnGap) + textWidth(mark, mark.textContent ?? '') : 0));
  }
  return out;
}

const sameNeeds = (a: Record<RelSide, RelNeed>, b: Record<RelSide, RelNeed>) =>
  SIDES.every((s) => Math.abs(a[s].text - b[s].text) < 0.05 && Math.abs(a[s].chrome - b[s].chrome) < 0.05 && Math.abs((a[s].sub ?? 0) - (b[s].sub ?? 0)) < 0.05);

const fkLine = (fk: DbFk) => s.fkLine(fk.from.table, fk.from.columns.join(', '), fk.to.table, fk.to.columns.join(', '));
/** A node's keys, each as `from.cols → to.cols` (and whether nothing indexes the referencing side). */
function keysOf(n: RelNode, edges: RelEdge[]): string {
  return edges.filter((e) => e.from === n.key || e.to === n.key).map((e) => fkLine(e.fk) + (e.fk.indexed || n.side === 'left' ? '' : ` (${s.noIndex})`)).join('; ');
}

/**
 * The diagram: edges in an SVG behind, nodes as buttons over it. `big`: the Relations view's (taller nodes with their
 * columns inside, wider columns). `width`/`height`: the box's guess until it is measured.
 */
export function RelDiagram({ tab, rels, big = false, width, height }: { tab: DbTabRef; rels: DbRelations; big?: boolean; width: number; height: number }) {
  const [ref, box] = useBox({ w: width, h: height });
  const plane = useRef<HTMLDivElement>(null);
  const [needs, setNeeds] = useState<Record<RelSide, RelNeed>>();
  const nodeH = big ? 46 : 34;
  const g = relationsGeometry(box.w, { maxNode: big ? 240 : 200, needs });
  // The view fills its height (less its column heads), the card keeps its own.
  const l = useMemo(() => layoutRelations({ schema: tab.schema, name: tab.name }, rels, big ? Math.max(box.h - 8, 240) : height, { nodeH }), [tab.schema, tab.name, rels, big, box.h, height, nodeH]);
  // The names' widths, read once their nodes are drawn and before the paint (the first frame already fits them), again
  // when the nodes change: each column as wide as its names need while the width holds them (follow-up 1).
  useLayoutEffect(() => {
    if (!plane.current) return;
    const next = measureNeeds(plane.current);
    setNeeds((was) => (was && sameNeeds(was, next) ? was : next));
  }, [l, big]);
  const paths = edgePaths(l, g, { nodeH });
  const mid = l.nodes.find((n) => n.side === 'center')!;
  const selfKeys = l.edges.filter((e) => e.self).map((e) => e.label);
  return (
    <div ref={ref} className={`dbr-box${big ? ' is-big' : ''}`}>
      <div ref={plane} className="dbr-plane" style={{ width: g.width, height: l.height }}>
        <svg className="dbr-edges" width={g.width} height={l.height} viewBox={`0 0 ${g.width} ${l.height}`} aria-hidden="true">
          {paths.map((p) => <path key={p.key} d={p.d} className={`dbr-edge${p.self ? ' is-self' : ''}${p.edge.fk.indexed || p.self ? '' : ' is-loose'}`} />)}
        </svg>
        <div className="dbr-node is-center" style={{ left: g.x.center, top: mid.y - nodeH / 2, width: g.nodeW.center, height: nodeH }}
          data-tip={selfKeys.length ? `${tab.schema}.${tab.name}\n${s.self(selfKeys.join(', '))}` : `${tab.schema}.${tab.name}`}>
          <span className="dbr-node-name">{tab.name}</span>
          {big && selfKeys.length > 0 && <span className="dbr-node-via">{s.self(selfKeys.join(', '))}</span>}
        </div>
        {l.nodes.filter((n) => n.side !== 'center').map((n) => {
          const tip = s.nodeTip(n.label, keysOf(n, l.edges));
          return (
            <button key={n.key} type="button" className={`dbr-node is-${n.side}`} style={{ left: g.x[n.side], top: n.y - nodeH / 2, width: g.nodeW[n.side], height: nodeH }}
              data-tip={tip} aria-label={tip} {...tableLink(tab.connId, { schema: n.schema, name: n.name })}>
              {big
                ? <span className="dbr-node-text"><span className="dbr-node-name">{n.label}</span><span className="dbr-node-via">{n.via.join(' · ')}</span></span>
                : <span className="dbr-node-name">{n.label}</span>}
              {n.side === 'right' && <em className="dbr-node-n" aria-hidden="true">{s.many}</em>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The Relations view: the same diagram, bigger, with its columns' heads. A view can't hold a foreign key, nor be pointed at: it says so. */
export function RelationsView({ tab, width }: { tab: DbTabRef; width: number }) {
  const rel = useStruct((st) => st.tabs[tab.key]?.relations);
  const rels = rel?.v;
  const left = rels ? new Set(rels.out.filter((f) => !(f.to.schema === tab.schema && f.to.table === tab.name)).map((f) => `${f.to.schema}\0${f.to.table}`)).size : 0;
  const right = rels ? new Set(rels.in.filter((f) => !(f.from.schema === tab.schema && f.from.table === tab.name)).map((f) => `${f.from.schema}\0${f.from.table}`)).size : 0;
  const empty = rels !== undefined && rels.out.length + rels.in.length === 0;
  return (
    <div className={`dbr-view${rel?.loading && rels ? ' is-busy' : ''}`} role="region" aria-busy={rel?.loading || undefined} aria-label={s.diagramLabel(tab.name)}>
      {rels && !empty && (
        <div className="dbr-heads">
          <span className="dbr-head" data-tip={s.referencesTip}><span className="section-label">{s.references}</span><span className="dbs-count">{left}</span></span>
          <span className="dbs-sp" />
          <span className="dbr-head" data-tip={s.referencedByTip}><span className="section-label">{s.referencedBy}</span><span className="dbs-count">{right}</span></span>
        </div>
      )}
      {rel?.p ? <div className="dbr-pad"><PartFailed title={s.failed.relations} p={rel.p} onRetry={() => void readPart(tab.key, tab, 'relations', true)} /></div>
        : !rels ? <div className="dbr-pad"><Skeleton rows={3} className=" is-diagram" /></div>
        : empty ? <p className="dbr-none">{tab.kind === 'view' || tab.kind === 'matview' ? s.viewNoRelations : s.noRelations}</p>
        : <RelDiagram tab={tab} rels={rels} big width={Math.max(0, width - 48)} height={420} />}
    </div>
  );
}
