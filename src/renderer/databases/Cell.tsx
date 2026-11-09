// A grid cell: a cell view drawn as its type reads best — NULL, empty
// and whitespace never alike, numbers as grouped, booleans as a dot, times to the minute with their age, UUIDs with
// the head bright, JSON as a colored one-line preview read from its text (never parsed, so every digit stays),
// arrays and lexemes as chips ("+N" past the width), enums tinted, bytes by their kind, masked values as dots. Only
// what a cell can show is rendered: a 64 KB value is never laid out whole. A value main cut at 64 KB keeps its mark in
// view (its own box: the value gives way). The stylesheet is table.css (lazy, with the table's chunk).
import type { ReactNode } from 'react';
import { MASK, type CellView } from '@shared/pg-format';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { bytesLabel, chipsThatFit, mimeLabel, uuidTail } from './grid-model';
import { clipText, jsonPreview, type JsonTok } from './json-text';

export interface CellProps {
  view: CellView;
  /** The column's width: how many chips fit. */
  width: number;
  /** Wrap Cells: up to six lines show, so more is rendered. */
  wrap: boolean;
  /** A foreign key's value: the arrow to its table follows it. */
  fk?: boolean;
  /** The value's whole length when main cut it at 64 KB. */
  cut?: number;
}

/** Characters rendered at most: a line of the widest cell, or six wrapped lines. */
const TEXT_MAX = 400;
const WRAP_TEXT_MAX = 1200;
const JSON_MAX = 160;
const WRAP_JSON_MAX = 900;
const WRAP_CHIPS = 50;

const clip = (s: string, wrap: boolean) => clipText(s, wrap ? WRAP_TEXT_MAX : TEXT_MAX);

// A JSON cell's tokens, once per view (Grid keeps one view per loaded value) and width mode.
const previews = new WeakMap<CellView, Map<number, JsonTok[] | null>>();
function previewOf(v: Extract<CellView, { k: 'json' }>, max: number): JsonTok[] | null {
  let byMax = previews.get(v);
  if (!byMax) { byMax = new Map(); previews.set(v, byMax); }
  if (!byMax.has(max)) byMax.set(max, jsonPreview(v.raw, max));
  return byMax.get(max) ?? null;
}

function chips(items: readonly { text: string; pos?: string; nul?: boolean }[], width: number, wrap: boolean): ReactNode {
  if (items.length === 0) return <span className="dbt-chips"><span className="dbt-ach is-more">{'{}'}</span></span>;
  const n = wrap ? Math.min(items.length, WRAP_CHIPS) : chipsThatFit(items.map((x) => (x.pos ? { text: x.text, pos: x.pos } : x.text)), width);
  return (
    <span className="dbt-chips">
      {items.slice(0, n).map((x, i) => (x.nul
        ? <span key={i} className="dbt-ach is-null">NULL</span>
        : <span key={i} className="dbt-ach">{x.text}{x.pos ? <i>{x.pos}</i> : null}</span>))}
      {n < items.length && <span className="dbt-ach is-more">{`+${items.length - n}`}</span>}
    </span>
  );
}

function body(v: CellView, width: number, wrap: boolean, cut: boolean): ReactNode {
  switch (v.k) {
    case 'null': return <span className="dbt-nul">NULL</span>;
    case 'empty': return <span className="dbt-emp">{tdt.grid.empty}</span>;
    case 'blank': return <span className="dbt-blank">{'␣'.repeat(Math.min(3, v.count))}<span className="dbt-blank-n">{tdt.grid.spaces(v.count)}</span></span>;
    case 'masked': return <span className="dbt-mask">{MASK}</span>;
    case 'num': return <span className={v.neg ? 'dbt-num is-neg' : 'dbt-num'}>{v.text}</span>;
    case 'bool': return <span className={`dbt-bool ${v.on ? 'is-t' : 'is-f'}`}><i />{v.on ? 'true' : 'false'}</span>;
    case 'time': return <span className="dbt-time" data-tip={v.title}>{v.text}{v.rel ? <span className="dbt-rel">{v.rel}</span> : null}</span>;
    case 'uuid': return <span className="dbt-uu" data-tip={v.head + v.tail}><span className="dbt-uu-h">{v.head}</span><span className="dbt-uu-t">{uuidTail(v.tail)}</span></span>;
    case 'json': {
      // A cut value is no longer JSON: its text.
      const toks = cut ? null : previewOf(v, wrap ? WRAP_JSON_MAX : JSON_MAX);
      if (!toks) return <span className="dbt-text">{clip(v.raw, wrap)}</span>;
      return <span className="dbt-json">{toks.map((t, i) => <span key={i} className={`dbt-j${t.t}`}>{t.s}</span>)}</span>;
    }
    case 'array': return chips(v.items.map((x) => (x === null ? { text: 'NULL', nul: true } : { text: x })), width, wrap);
    case 'lexemes': return chips(v.items.map((x) => ({ text: x.word, pos: x.pos })), width, wrap);
    case 'enum': return <span className={`dbt-en t${v.tint}`}>{v.text}</span>;
    case 'bytes':
      return (
        <span className="dbt-bytes">
          <span className="dbt-hex">{`\\x${v.head}${v.size > v.head.length / 2 ? '…' : ''}`}</span>
          {v.mime ? <span className="dbt-ach">{mimeLabel(v.mime)}</span> : null}
          <span className="dbt-size">{bytesLabel(v.size)}</span>
        </span>
      );
    case 'range': {
      const m = /^([[(])([\s\S]*)([\])])$/.exec(v.text);
      if (!m) return <span className="dbt-range">{clip(v.text, wrap)}</span>;
      return <span className="dbt-range"><span className="dbt-jp">{m[1]}</span>{clip(m[2]!, wrap)}<span className="dbt-jp">{m[3]}</span></span>;
    }
    case 'geo': return <span className="dbt-geo">{v.text}</span>;
    case 'text': return <span className="dbt-text">{clip(v.text, wrap)}</span>;
  }
}

export function Cell({ view, width, wrap, fk, cut }: CellProps) {
  const b = body(view, width, wrap, cut !== undefined);
  const shown = fk && view.k !== 'null' && view.k !== 'masked' ? <span className="dbt-fkv">{b}<Icon name="fkArrow" size={12} /></span> : b;
  if (cut === undefined) return shown;
  // The value gives way (ellipsized in its box), the mark never does.
  return (
    <span className="dbt-cutbox">
      <span className="dbt-cutv">{shown}</span>
      <span className="dbt-cut" data-tip={tdt.grid.cutTip(bytesLabel(cut))}>…</span>
    </span>
  );
}
