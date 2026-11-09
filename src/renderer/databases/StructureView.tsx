// Structure: the columns (badges PK/FK/GIN/IDX, an FK's target a
// link to its table), the indexes ("never used" in amber, a partial index's WHERE, sizes as estimates), constraints and
// triggers ("No primary key" in amber when there is none) — a view shows its definition instead, a materialized view
// its definition and its indexes —, the partitions of a partitioned table; beside them (under them below
// ~720 px) the Size card (table, indexes, TOAST; rows and dead rows; "Not measured yet" before any ANALYZE or VACUUM),
// the Relations card (RelDiagram; none for views: they have no foreign keys) and the DDL card (Copy; Send Schema to
// <session>, the session's name ellipsizing). Each part (structure, relations, DDL) shows its own
// first read, its own failure with Retry. Tables scroll sideways inside their section, names ellipsize (whole in their
// tooltips), badges and buttons never shrink or wrap; the columns table is drawn again only when its structure changes
// (300 columns stay light through a resize). Lazy, with the table's chunk.
import './structure.css';
import { Fragment, memo, useMemo, type ReactNode } from 'react';
import type { DbStructure } from '@shared/databases';
import { Icon } from '../components/Icon';
import { t as en } from '../i18n/en';
import { tdt } from '../i18n/db-table';
import { kbd } from '../kbd';
import { approxRows } from './data';
import { shortType } from './grid-model';
import { copyWithToast } from './menus';
import { RelDiagram } from './RelationsView';
import { readPart, useStruct, type StructPart } from './structure-data';
import {
  columnBadges, columnNotes, constraintParts, deadShare, indexBadges, indexKeys, scansLabel, since, sizeBar, sizeLabel, sqlLines, structureLayout,
  type StructColumn
} from './structure-model';
import { PartFailed, Skeleton, tableLink } from './structure-ui';
import type { DbTabRef } from './tabs';

const s = tdt.struct;
/** The view's padding and a card's (structure.css): the Relations card's diagram gets what is left of the width. */
const VIEW_PAD = 20;
const CARD_PAD = 16;
/** Board 4's Relations card: its diagram's height (it grows with many relations; the card scrolls past MAX). */
const CARD_DIAGRAM_H = 262;

const BADGE_CLASS: Record<string, string> = { PK: 'is-pk', FK: 'is-fk', UNIQUE: 'is-uq' };

/** A section's head: its label and count. */
function Head({ label, count, children }: { label: string; count?: number; children?: ReactNode }) {
  return (
    <h3 className="dbs-sec-head">
      <span className="section-label">{label}</span>
      {count !== undefined && <span className="dbs-count">{count}</span>}
      {children && <><span className="dbs-sp" />{children}</>}
    </h3>
  );
}

/** Code as the DDL card and a view's definition show it: colored, one line each, scrolling sideways. */
function Code({ text, label }: { text: string; label: string }) {
  const lines = sqlLines(text.replace(/\n$/, ''));
  return (
    <pre className="dbs-code mono" tabIndex={0} aria-label={label}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          {line.map((t, j) => (t.k === 'ws' || t.k === 'id' || t.k === 'p' ? <Fragment key={j}>{t.s}</Fragment> : <span key={j} className={`sq-${t.k}`}>{t.s}</span>))}
        </Fragment>
      ))}
    </pre>
  );
}

/**
 * The Columns table: memoized on what it shows (its connection, schema and structure), so a resize or another part's
 * read draws none of its rows again; the indexes' leading columns read once for all rows (indexBadges).
 */
export const ColumnsTable = memo(function ColumnsTable({ connId, schema, v }: { connId: string; schema: string; v: DbStructure }) {
  const led = useMemo(() => indexBadges(v.indexes), [v.indexes]);
  return (
    <section className="dbs-sec dbs-cols">
      <Head label={s.columns} count={v.columns.length} />
      <div className="dbs-x">
        <table className="dbs-table is-cols">
          <colgroup><col className="c-name" /><col className="c-type" /><col className="c-null" /><col className="c-default" /><col className="c-notes" /></colgroup>
          <thead><tr><th>{s.th.name}</th><th>{s.th.type}</th><th>{s.th.null}</th><th>{s.th.default}</th><th>{s.th.notes}</th></tr></thead>
          <tbody>{v.columns.map((c) => <ColumnRow key={c.name} connId={connId} schema={schema} c={c} badges={columnBadges(c, led)} />)}</tbody>
        </table>
      </div>
    </section>
  );
});

function ColumnRow({ connId, schema, c, badges }: { connId: string; schema: string; c: StructColumn; badges: string[] }) {
  const notes = columnNotes(c, schema);
  return (
    <tr>
      <td>
        <div className="dbs-cell">
          <span className="dbs-name" data-tip={c.name}>{c.name}</span>
          {badges.map((b) => <span key={b} className={`dbs-badge ${BADGE_CLASS[b] ?? 'is-ix'}`} data-tip={s.badges[b] ?? s.methodTip(b.toLowerCase())}>{b}</span>)}
        </div>
      </td>
      <td><span className="dbs-type" data-tip={c.type}>{shortType(c.type)}</span></td>
      <td className={`dbs-null${c.nullable ? ' is-yes' : ''}`}>{c.nullable ? s.yes : s.no}</td>
      <td>
        {c.identity ? <span className="dbs-dim" data-tip={s.identityTip}>{s.identity}</span>
          : c.generated ? <span className="dbs-dim" data-tip={s.generatedTip(c.generated)}>{s.generated}</span>
          : c.default !== undefined ? <span className="dbs-dflt" data-tip={c.default}>{c.default}</span> : null}
      </td>
      <td>
        <div className="dbs-cell">
          {notes.map((n, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="dbs-sep" aria-hidden="true">·</span>}
              {n.kind === 'fk'
                ? (
                  <button type="button" className="dbs-fk" data-tip={s.openTip(n.target.schema === schema ? n.target.name : `${n.target.schema}.${n.target.name}`, kbd('⌥-click'))}
                    {...tableLink(connId, n.target)}>{n.text}</button>
                )
                : <span className={`dbs-note${n.kind === 'comment' ? ' is-comment' : ''}`} data-tip={n.text}>{n.text}</span>}
            </Fragment>
          ))}
        </div>
      </td>
    </tr>
  );
}

/** An index's size: an estimate from the statistics; "—" for a partitioned index (on its partitions) or nothing measured yet. */
function IndexSize({ bytes, measured }: { bytes: number | null; measured: boolean }) {
  if (bytes === null) return <td className="dbs-num dbs-dim" data-tip={s.partitionedIndex}>—</td>;
  if (!measured) return <td className="dbs-num dbs-dim" data-tip={s.unmeasured}>—</td>;
  return <td className="dbs-num dbs-dim" data-tip={s.estimateTip}>{s.estimate(sizeLabel(bytes))}</td>;
}

function Indexes({ v }: { v: DbStructure }) {
  return (
    <section className="dbs-sec dbs-idx">
      <Head label={s.indexes} count={v.indexes.length} />
      {v.indexes.length === 0 ? <p className="dbs-empty">{s.noIndexes}</p> : (
        <div className="dbs-x">
          <table className="dbs-table is-idx">
            <colgroup><col className="c-name" /><col className="c-keys" /><col className="c-method" /><col className="c-size" /><col className="c-scans" /></colgroup>
            <tbody>
              {v.indexes.map((i) => {
                const { keys, where } = indexKeys(i);
                const scans = scansLabel(i);
                return (
                  <tr key={i.name}>
                    <td>
                      <div className="dbs-cell">
                        <span className="dbs-name" data-tip={i.name}>{i.name}</span>
                        {i.unique && <span className="dbs-badge is-uq" data-tip={s.badges.UNIQUE}>UNIQUE</span>}
                      </div>
                    </td>
                    <td className="dbs-keys" data-tip={where !== null ? `${i.def}\n${s.partial}` : i.def}>{keys}{where !== null && <>{' '}<span className="dbs-dim">{`WHERE ${where}`}</span></>}</td>
                    <td className="dbs-dim">{i.method}</td>
                    <IndexSize bytes={i.bytes} measured={v.size.measured} />
                    <td className={`dbs-scans${scans.never ? ' is-never' : ''}`} data-tip={scans.never ? s.neverUsedTip : i.scans === null ? s.noScans : undefined}>{scans.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Constraints({ v }: { v: DbStructure }) {
  const pk = v.constraints.some((c) => c.kind === 'p');
  return (
    <section className="dbs-sec dbs-con">
      <Head label={s.constraints} count={v.constraints.length} />
      {v.constraints.length > 0 && (
        <div className="dbs-x">
          <table className="dbs-table is-con">
            <colgroup><col className="c-name" /><col /></colgroup>
            <tbody>
              {v.constraints.map((c) => {
                const { kw, rest } = constraintParts(c);
                return (
                  <tr key={`${c.kind}:${c.name}`}>
                    <td><span className="dbs-name" data-tip={c.name}>{c.name}</span></td>
                    <td className="dbs-condef" data-tip={c.def}>{kw && <span className="dbs-dim">{kw}</span>}{kw && ' '}{rest}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!pk && <p className="dbs-empty is-warn" data-tip={s.noPkTip}>{s.noPk}</p>}
    </section>
  );
}

function Partitions({ v }: { v: DbStructure }) {
  return (
    <section className="dbs-sec dbs-parts">
      <Head label={s.partitions} count={v.partitions.length} />
      <div className="dbs-x">
        <table className="dbs-table is-con">
          <colgroup><col className="c-name" /><col /></colgroup>
          <tbody>
            {v.partitions.map((p) => {
              // A partition in another schema than its table's is named with it.
              const label = p.schema === v.schema ? p.name : `${p.schema}.${p.name}`;
              return (
                <tr key={`${p.schema}\0${p.name}`}>
                  <td><span className="dbs-name" data-tip={`${p.schema}.${p.name}`}>{label}</span></td>
                  <td className="dbs-condef" data-tip={p.bound}>{p.bound}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SizeCard({ v }: { v: DbStructure }) {
  const measured = v.size.measured;
  const bar = measured ? sizeBar(v.size) : [];
  const now = Date.now();
  const analyzed = since(v.stats.lastAnalyze, now);
  const vacuumed = since(v.stats.lastVacuum, now);
  const dead = deadShare(v.stats);
  return (
    <section className="dbs-card dbs-size">
      <div className="dbs-size-head">
        <span className="section-label">{s.size}</span>
        <span className="dbs-sp" />
        <span className="dbs-size-total" data-tip={measured ? s.sizeTip : s.unmeasured}>{measured ? sizeLabel(v.size.total) : '—'}</span>
      </div>
      {bar.length > 0 && (
        <>
          <div className="dbs-bar">
            {bar.map((p) => <span key={p.part} className={`dbs-bar-part is-${p.part}`} style={{ width: `${p.pct}%` }} data-tip={`${s.parts[p.part]} ${s.estimate(sizeLabel(p.bytes))} · ${s.partTip[p.part]}`} />)}
          </div>
          {/* Estimates from the statistics: "~" on each, the card's tooltip says why. */}
          <div className="dbs-legend" data-tip={s.estimateTip}>
            {bar.map((p) => <span key={p.part} className="dbs-leg"><i className={`dbs-dot is-${p.part}`} />{`${s.parts[p.part]} ${s.estimate(sizeLabel(p.bytes))}`}</span>)}
          </div>
        </>
      )}
      {!measured && <p className="dbs-size-note">{s.unmeasured}</p>}
      <div className="dbs-rule" />
      <dl className="dbs-facts">
        <dt>{s.rows}</dt>
        <dd>
          <span className="mono">{v.stats.estimate === null ? '—' : `~${approxRows(v.stats.estimate)}`}</span>
          <span className="dbs-dim">{` · ${analyzed ? s.analyzed(analyzed) : s.neverAnalyzed}`}</span>
        </dd>
        <dt>{s.dead}</dt>
        <dd data-tip={v.stats.dead !== null ? s.deadTip(v.stats.dead.toLocaleString('en-US')) : undefined}>
          <span className="mono">{dead ?? '—'}</span>
          <span className="dbs-dim">{` · ${vacuumed ? s.vacuumed(vacuumed) : s.neverVacuumed}`}</span>
        </dd>
      </dl>
    </section>
  );
}

export interface StructureViewProps {
  tab: DbTabRef;
  /** The tab's width (TableView measures it): one column below ~720 px, the Relations card's diagram from it. */
  width: number;
  /** "Relations" from the card: the tab's Relations view. */
  onOpenDiagram?: () => void;
  /**
   * Send Schema to <session> (as the grid's Send to): `label`, the target session's title, null
   * with none (the press says why, with a Copy). Absent, no button.
   */
  sendSchema?: { label: string | null; run(): void };
}

export function StructureView({ tab, width, onOpenDiagram, sendSchema }: StructureViewProps) {
  const t = useStruct((st) => st.tabs[tab.key]);
  const layout = structureLayout(width);
  const retry = (part: StructPart) => () => void readPart(tab.key, tab, part, true);
  const st = t?.structure;
  const v = st?.v;
  const rel = t?.relations;
  const ddl = t?.ddl;
  // The Relations card's diagram: the side column less the card's padding, or the whole width when stacked.
  const cardW = (layout.stacked ? width - 2 * VIEW_PAD : layout.side) - 2 * CARD_PAD;
  const view = v?.kind === 'view';
  const viewLike = view || v?.kind === 'matview';
  return (
    <div className="dbs">
      {v && (
        <p className="dbs-head">
          {/* The kind and "owner" never shrink; a long owner name and the comment ellipsize (the comment first). */}
          <span className="dbs-head-kind">{`${s.kindOwner(s.kinds[v.kind])} `}</span>
          <span className="dbs-head-owner" data-tip={v.owner}>{v.owner}</span>
          {v.comment && <span className="dbs-head-comment" data-tip={v.comment}>{` · “${v.comment}”`}</span>}
        </p>
      )}
      <div className={`dbs-grid${layout.stacked ? ' is-stacked' : ''}`}>
        <div className={`dbs-main${st?.loading && v ? ' is-busy' : ''}`} aria-busy={st?.loading || undefined}>
          {st?.p ? <PartFailed title={s.failed.structure} p={st.p} onRetry={retry('structure')} />
            : !v ? <Skeleton rows={8} />
            : (
              <>
                <ColumnsTable connId={tab.connId} schema={tab.schema} v={v} />
                {viewLike && (
                  <section className="dbs-sec dbs-def">
                    <Head label={s.definition} />
                    <Code text={v.viewDef ?? ''} label={s.definition} />
                  </section>
                )}
                {v.partitions.length > 0 && <Partitions v={v} />}
                {/* A materialized view's indexes are real ones; a view has none. */}
                {!view && <Indexes v={v} />}
                {!viewLike && <Constraints v={v} />}
              </>
            )}
        </div>
        <div className="dbs-side" style={layout.stacked ? undefined : { width: `${layout.side}px` }}>
          {v && !view && <SizeCard v={v} />}
          {/* A view or a materialized view holds no foreign key and none points at it: no Relations card. */}
          {!viewLike && (
            <section className={`dbs-card dbs-rel${rel?.loading && rel.v ? ' is-busy' : ''}`} aria-busy={rel?.loading || undefined}>
              <Head label={s.relations}>
                {onOpenDiagram && <button type="button" className="dbs-link" onClick={onOpenDiagram}>{s.openDiagram}</button>}
              </Head>
              {rel?.p ? <PartFailed title={s.failed.relations} p={rel.p} onRetry={retry('relations')} />
                : !rel?.v ? <Skeleton rows={3} className=" is-diagram" />
                : rel.v.out.length + rel.v.in.length === 0 ? <p className="dbs-none">{s.noRelations}</p>
                : <RelDiagram tab={tab} rels={rel.v} width={cardW} height={CARD_DIAGRAM_H} />}
            </section>
          )}
          <section className={`dbs-card dbs-ddl${ddl?.loading && ddl.v !== undefined ? ' is-busy' : ''}`} aria-busy={ddl?.loading || undefined}>
            <Head label={s.ddl}>
              {/* Copy never wraps; Send Schema beside it, the session's name ellipsizing, whole in the tooltip. */}
              {ddl?.v !== undefined && (
                <button type="button" className="btn-ghost sm dbs-copy" data-tip={s.copyTip} onClick={() => copyWithToast(ddl.v!)}><Icon name="copy" size={12} />{s.copy}</button>
              )}
              {sendSchema && (
                <button type="button" className="btn-ghost sm dbs-send" data-tip={sendSchema.label === null ? en.docker.noSession : s.sendSchemaTip(sendSchema.label)} onClick={sendSchema.run}>
                  <Icon name="send" size={12} /><span className="dk-ellipsis">{sendSchema.label === null ? s.sendSchemaNone : s.sendSchema(sendSchema.label)}</span>
                </button>
              )}
            </Head>
            {ddl?.p ? <PartFailed title={s.failed.ddl} p={ddl.p} onRetry={retry('ddl')} />
              : ddl?.v === undefined ? <Skeleton rows={5} />
              // What it is, quietly: rebuilt from the catalog, not everything pg_dump would write.
              : <><Code text={ddl.v} label={s.ddl} /><p className="dbs-ddl-note" data-tip={s.ddlNote}>{s.ddlNote}</p></>}
          </section>
        </div>
      </div>
    </div>
  );
}
