// A line of the JSON view's tree: its number, its indent, a fold, its key
// and value as the JSON navigation colors (a URL a link with its real target in the tooltip), the dim hint (unix time,
// "2 items", a folded preview), "JSON in a string · Parse" or "parsed", and its hover actions — Copy, Path, SQL, Filter,
// + Column — taking the value's tail, never over it (json-tools.css). Its own module; lazy,
// with the table's chunk.
import type { MouseEvent } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import type { JsonRow } from './json';

/** What a line's buttons do (the view's). */
export interface RowActs {
  pick(r: JsonRow): void;
  toggle(id: string): void;
  copy(r: JsonRow): void;
  path(r: JsonRow): void;
  sql(r: JsonRow): void;
  filter(r: JsonRow): void;
  column(r: JsonRow): void;
  isColumn(r: JsonRow): boolean;
  reach(r: JsonRow): boolean;
  hasPath(r: JsonRow): boolean;
  url(url: string): void;
  parse(r: JsonRow): void;
  unparse(r: JsonRow): void;
  menu(e: MouseEvent, r: JsonRow): void;
}

/** A small icon button of a line's hover actions; off, its reason in the tooltip. */
function Act({ icon, tip, off, onClick }: { icon: IconName; tip: string; off?: string | false; onClick: () => void }) {
  return (
    <button type="button" tabIndex={-1} className="dbj-act" aria-label={tip} data-tip={off || tip} aria-disabled={off ? true : undefined}
      onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); if (!off) onClick(); }}>
      <Icon name={icon} size={12} />
    </button>
  );
}

/** One line: its number, its indent, a fold, its key and value as the JSON navigation colors, the hint, the actions. */
export function Line({ id, r, n, sel, hit, cur, act }: { id: string; r: JsonRow; n: number; sel: boolean; hit: boolean; cur: boolean; act: RowActs }) {
  const j = tdt.json;
  const cls = ['dbj-row', `is-${r.role}`, sel ? 'is-sel' : '', hit ? 'is-hit' : '', cur ? 'is-cur' : '', r.parsedFromString ? 'is-parsed' : ''].filter(Boolean).join(' ');
  // Each level's step: 14 px, 8 in a narrow tree (json-tools.css --dbj-indent); never more than 40% of the line.
  const indent = <span className="dbj-ind" style={{ width: `min(calc(${r.depth} * var(--dbj-indent, 14px)), 40%)` }} />;
  if (r.role === 'close') {
    return <div className={cls} aria-hidden="true"><span className="dbj-no">{n}</span>{indent}<span className="dbj-tw" /><span className="dbj-p">{r.text}</span>{r.comma && <span className="dbj-p">,</span>}</div>;
  }
  if (r.role === 'more') {
    return (
      <div id={id} className={cls} role="treeitem" aria-level={r.depth + 1} aria-selected={sel} onClick={() => act.pick(r)}>
        <span className="dbj-no">{n}</span>{indent}<span className="dbj-tw" />
        <button type="button" tabIndex={-1} className="dbj-more" data-tip={j.moreTip} onMouseDown={(e) => e.preventDefault()}>{j.more(r.count ?? 0)}</button>
      </div>
    );
  }
  const open = r.role === 'open';
  const vcls = r.masked ? 'is-mask' : open ? (r.folded ? 'is-fo' : 'is-p') : r.kind === 'string' ? 'is-s' : r.kind === 'number' ? 'is-n' : r.kind === 'object' || r.kind === 'array' ? 'is-p' : 'is-l';
  const reach = act.reach(r);
  const shownCol = reach && act.isColumn(r);
  // A JSON null: is JSON null; a container: the path exists.
  const filterTip = r.kind === 'null' ? j.act.filterNull : r.kind === 'object' || r.kind === 'array' ? j.act.filterExists : j.act.filter;
  const why = r.parsedFromString ? j.act.inString : false;
  return (
    <div id={id} className={cls} role="treeitem" aria-level={r.depth + 1} aria-selected={sel} aria-expanded={open ? !r.folded : undefined}
      onClick={() => act.pick(r)} onDoubleClick={() => { if (open) act.toggle(r.id); }} onContextMenu={(e) => act.menu(e, r)}>
      <span className="dbj-no">{n}</span>
      {indent}
      {open ? (
        <button type="button" tabIndex={-1} className={`dbj-tw is-btn${r.folded ? '' : ' is-open'}`} aria-label={r.folded ? j.unfold : j.fold}
          onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); act.toggle(r.id); }}>
          <Icon name="chevron" size={10} stroke={2} />
        </button>
      ) : <span className="dbj-tw" />}
      {typeof r.key === 'string' && (
        // Keys first: whole up to 10 characters (quotes included), never narrower than that — the value gives way.
        <><span className="dbj-k" data-tip={r.key} style={{ minWidth: `${Math.min(JSON.stringify(r.key).length, 10)}ch` }}>{JSON.stringify(r.key)}</span><span className="dbj-p">: </span></>
      )}
      {r.url && !r.masked ? (
        // The link's target as the browser gets it (normalized, punycode), whatever the text says.
        <button type="button" tabIndex={-1} className="dbj-v is-s dbj-url" data-tip={j.linkTip(r.url)} onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); act.url(r.url!); }}>{r.text}</button>
      ) : <span className={`dbj-v ${vcls}`} data-tip={r.role === 'leaf' && r.text.length > 24 ? r.text : undefined}>{r.text}</span>}
      {r.comma && (!open || r.folded) && <span className="dbj-p">,</span>}
      {r.hint && <span className="dbj-hint">{r.folded ? `▸ ${r.hint}` : r.hint}</span>}
      {r.jsonString && (
        <button type="button" tabIndex={-1} className="dbj-chip" data-tip={j.parseTip} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); act.parse(r); }}>
          {j.parse}
        </button>
      )}
      {r.parsed && (
        <button type="button" tabIndex={-1} className="dbj-chip is-parsed" data-tip={j.parsedTip} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); act.unparse(r); }}>
          {j.parsed}
        </button>
      )}
      <span className="dbj-acts">
        <Act icon="copy" tip={j.act.copy} onClick={() => act.copy(r)} />
        <Act icon="path" tip={j.act.path} off={!act.hasPath(r) && j.root} onClick={() => act.path(r)} />
        <Act icon="code" tip={j.act.sql} onClick={() => act.sql(r)} />
        <Act icon="filter" tip={filterTip} off={why || (!reach && j.act.noFilter)} onClick={() => act.filter(r)} />
        <Act icon="jsonBranch" tip={shownCol ? j.act.columnShown : j.act.column} off={why || (!reach && j.act.noColumn) || (shownCol && j.act.columnShown)} onClick={() => act.column(r)} />
      </span>
    </div>
  );
}
