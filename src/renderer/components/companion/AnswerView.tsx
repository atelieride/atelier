import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { parseAnswer, type AnswerBlock, type Inline } from '@shared/companion/answer';
import { changedAfter } from '@shared/companion/stale';
import type { CompanionModel, ThreadItem } from '@shared/companion/types';
import { Icon } from '../Icon';
import { FileIcon } from '../FileIcon';
import { useApp } from '../../store';
import { t } from '../../i18n/en';
import { chipLookups, resolveChip, type ChipTarget, type RunView } from '../../companion/model';
import { MODEL_LABEL, answerMeta, liveMarkdown, meterOf } from '../../companion/view';
import { InlineText, LinkLabel, SpanView } from './InlineText';
import { AnswerLink } from './AnswerLink';
import { Trace } from './Trace';
import { AnswerActions } from './AnswerActions';
import { StaleBar } from './StaleBar';

type AnswerItem = Extract<ThreadItem, { kind: 'answer' }>;
type FileRef = Extract<Inline, { t: 'file' }>;
type Verdict = Extract<AnswerBlock, { k: 'verdict' }>;

/** The files a header's tooltip lists before "+N more" (as the Catch me up card's source line). */
const READ_TIP_MAX = 8;
const NO_FILES = '';

/**
 * A finished answer: "✦ Ask · model · read N files", the Markdown as Atelier draws it
 * (verdict chip, steps, folded Details, file chips), under the latest one the stale bar, then its actions.
 */
export function AnswerView({ item, sessionId, terminalId, cwd, question, latest, busy, onAsk }: {
  item: AnswerItem; sessionId: string; terminalId: string; cwd: string; question: string | null; latest: boolean; busy: boolean; onAsk: (q: string) => void;
}) {
  // Joined, so the selector's result compares by value while attributions come and go.
  const changed = useApp((s) => (latest ? changedAfter(s.attributions, sessionId, item.at).join('\n') : NO_FILES));
  const blocks = useMemo(() => parseAnswer(item.markdown), [item.markdown]);
  const more = item.read.length - READ_TIP_MAX;
  const readTip = item.read.length ? [...item.read.slice(0, READ_TIP_MAX), ...(more > 0 ? [t.companion.moreFiles(more)] : [])].join('\n') : undefined;
  const meta = answerMeta(item);
  return (
    <article className={`ask-item ask-ans${latest ? ' is-latest' : ''}`} data-kind="answer">
      <AnswerHeader parts={meta.map((text) => ({ text, tip: readTip !== undefined && text === t.companion.read(item.read.length) ? readTip : undefined, stopped: !!item.stopped && text === t.companion.stopped }))} />
      <AnswerBody blocks={blocks} cwd={cwd} folds={item.questionId} />
      {changed && <StaleBar files={changed.split('\n')} busy={busy} onRefresh={question === null ? null : () => onAsk(question)} />}
      <AnswerActions markdown={item.markdown} terminalId={terminalId} question={question} busy={busy} onAsk={onAsk} />
    </article>
  );
}

/**
 * An answer on its way: its header says it is reading until text arrives; the trace of what it
 * reads (for the eyes: the header tells screen readers), then the text as it streams, a caret at its end. A run waiting
 * for a free slot says so instead.
 */
export function LiveAnswer({ run, cwd, model }: { run: RunView; cwd: string; model: CompanionModel }) {
  const blocks = useMemo(() => parseAnswer(liveMarkdown(run.text)), [run.text]);
  const reading = !run.queued && blocks.length === 0;
  const parts = [{ text: MODEL_LABEL[model] }, ...(run.queued ? [{ text: t.companion.waitingTurn }] : reading ? [{ text: t.companion.reading }] : [])];
  return (
    <article className={`ask-item ask-ans is-live${run.queued ? ' is-queued' : ''}`} data-kind="live" aria-busy="true">
      <AnswerHeader parts={parts} />
      {!run.queued && <Trace run={run} />}
      {blocks.length > 0 ? <AnswerBody blocks={blocks} cwd={cwd} folds={run.questionId} tail={<span className="ask-caret" aria-hidden="true" />} />
        : reading && <div className="ask-bars" aria-hidden="true"><i /><i /></div>}
    </article>
  );
}

function AnswerHeader({ parts }: { parts: { text: string; tip?: string; stopped?: boolean }[] }) {
  return (
    <header className="ask-ans-hd" data-copy="skip">
      <span className="ask-spark" aria-hidden="true"><Icon name="sparkle" size={12} stroke={1.2} /></span>
      <b>{t.companion.ask}</b>
      {parts.map((p) => (
        <Fragment key={p.text}>
          {' · '}
          <span className={p.stopped ? 'ask-ans-stopped' : undefined} data-tip={p.tip}>{p.text}</span>
        </Fragment>
      ))}
    </header>
  );
}

// --- the Markdown ----------------------------------------------------------------------------------------------------

/** Where each referenced path leads (undefined while main is asked; null: it stays code). */
type Chips = Record<string, Omit<ChipTarget, 'line'> | null | undefined>;

/** Lookups answered in the last seconds: an answer that lands draws the chips its streaming text already had. */
const recent = new Map<string, { at: number; v: Omit<ChipTarget, 'line'> | null }>();
const RECENT_MS = 10_000;

function remember(key: string, v: Omit<ChipTarget, 'line'> | null): void {
  const now = Date.now();
  for (const [k, r] of recent) if (now - r.at >= RECENT_MS) recent.delete(k);
  recent.set(key, { at: now, v });
}

function fileRefs(blocks: readonly AnswerBlock[], out: FileRef[] = []): FileRef[] {
  const take = (inline: readonly Inline[]) => { for (const i of inline) if (i.t === 'file') out.push(i); };
  for (const b of blocks) {
    if (b.k === 'para') take(b.inline);
    else if (b.k === 'list') b.items.forEach(take);
    else if (b.k === 'detail') fileRefs(b.body, out);
  }
  return out;
}

/** Each referenced path looked up once per answer (main checks it is a file inside the project). */
function useChips(blocks: readonly AnswerBlock[], cwd: string): Chips {
  const paths = useMemo(() => [...new Set(fileRefs(blocks).map((r) => r.path))], [blocks]);
  const keyOf = (path: string) => `${cwd}\u0000${path}`;
  const [chips, setChips] = useState<Chips>(() => {
    const now = Date.now();
    const known: Chips = {};
    for (const p of paths) { const r = recent.get(keyOf(p)); if (r && now - r.at < RECENT_MS) known[p] = r.v; }
    return known;
  });
  // One set of lookups per folder, disposed only when the view goes (or its folder changes): a lookup on its way when a
  // newer path streams in still lands.
  const lookups = useMemo(() => chipLookups(async (path) => {
    const found = await resolveChip({ t: 'file', path, from: null, to: null, raw: path }, cwd, (c, d) => window.atelier.files.resolve(c, d));
    const v = found ? { path: found.path, rel: found.rel } : null;
    remember(keyOf(path), v);
    return v;
  }, (path, v) => setChips((cur) => ({ ...cur, [path]: v })), Object.keys(chips)), [cwd]);
  useEffect(() => () => lookups.dispose(), [lookups]);
  useEffect(() => lookups.ask(paths), [paths.join('\n'), lookups]); // keyed by the paths, not by each new parse of the same text
  return chips;
}

/**
 * The Details opened or closed by hand, by answer (its question) and place: they stay so when the streamed answer lands,
 * and when the panel opens again. A few hundred at most.
 */
const folded = new Map<string, boolean>();
const FOLDS_MAX = 300;

function rememberFold(key: string, open: boolean): void {
  folded.delete(key);
  folded.set(key, open);
  if (folded.size > FOLDS_MAX) folded.delete(folded.keys().next().value!);
}

function AnswerBody({ blocks, cwd, folds, tail }: { blocks: AnswerBlock[]; cwd: string; folds: string | null; tail?: ReactNode }) {
  const chips = useChips(blocks, cwd);
  const open = useApp((s) => s.settings.askAnswers === 'detailed');
  return <Blocks blocks={blocks} chips={chips} open={open} folds={folds} tail={tail} />;
}

function Blocks({ blocks, chips, open, folds, tail }: { blocks: AnswerBlock[]; chips: Chips; open: boolean; folds: string | null; tail?: ReactNode }) {
  return (
    <>
      {blocks.map((b, k) => {
        const end = k === blocks.length - 1 ? tail : undefined;
        switch (b.k) {
          case 'verdict': return <Fragment key={k}><VerdictChip v={b} />{end}</Fragment>;
          case 'para': return <p key={k} className="ask-p"><Inlines inline={b.inline} chips={chips} />{end}</p>;
          case 'list': return b.ordered ? (
            <ol key={k} className="ask-steps">
              {b.items.map((it, i) => (
                <li key={i} className="ask-step" value={i + 1}>
                  <span className="ask-step-n mono" aria-hidden="true">{i + 1}</span>
                  <span className="ask-step-t"><Inlines inline={it} chips={chips} />{i === b.items.length - 1 ? end : null}</span>
                </li>
              ))}
            </ol>
          ) : (
            <ul key={k} className="ask-ul">
              {b.items.map((it, i) => <li key={i}><Inlines inline={it} chips={chips} />{i === b.items.length - 1 ? end : null}</li>)}
            </ul>
          );
          case 'detail': return <Detail key={k} title={b.title} body={b.body} chips={chips} open={open} fold={folds === null ? null : `${folds}:${k}`} tail={end} />;
        }
      })}
    </>
  );
}

function Inlines({ inline, chips }: { inline: readonly Inline[]; chips: Chips }) {
  return (
    <>
      {inline.map((i, k) => {
        switch (i.t) {
          case 'file': {
            const target = chips[i.path];
            return target ? <FileChip key={k} r={i} target={target} /> : <code key={k}>{i.raw}</code>;
          }
          case 'link': return <AnswerLink key={k} url={i.url}><LinkLabel label={i.label} strong /></AnswerLink>;
          default: return <SpanView key={k} s={i} strong />;
        }
      })}
    </>
  );
}

/** A path the project has: its file's name and line; a click opens it in the editor there, as `file:line` links do. */
function FileChip({ r, target }: { r: FileRef; target: Omit<ChipTarget, 'line'> }) {
  const name = r.path.split('/').at(-1) ?? r.path;
  const range = r.from === null ? null : r.to !== null && r.to !== r.from ? `:${r.from}–${r.to}` : `:${r.from}`;
  return (
    <button type="button" className="ask-fchip" aria-label={r.raw} data-tip={t.companion.openAt(target.rel, r.from, r.to)} data-copy-text={r.raw} data-copy-wrap="code"
      onClick={() => useApp.getState().openFile(target.path, target.rel, r.from, undefined, { preview: true })}>
      <FileIcon name={name} size={13} />
      <span className="ask-fchip-n">{name}</span>
      {range && <span className="ask-fchip-ln">{range}</span>}
    </button>
  );
}

const GLYPH: Record<Verdict['state'], string> = { done: 'done', 'in-progress': 'in_progress', 'not-started': 'not_started', unclear: 'unclear' };

/** The verdict line: a state-colored chip; an `n/m` in its label draws the meter. */
function VerdictChip({ v }: { v: Verdict }) {
  const meter = v.progress ? meterOf(v.progress) : null;
  return (
    <p className={`ask-verdict is-${v.state}`}>
      <span className="sr-only" data-copy-wrap="strong">{t.companion.verdict[v.state]}: </span>
      {meter ? (
        <span className={`ask-meter${meter.total > 6 ? ' is-dense' : ''}`} aria-hidden="true">
          {Array.from({ length: meter.total }, (_, i) => <i key={i} className={i < meter.filled ? 'on' : undefined} />)}
        </span>
      ) : (
        <span className={`ask-gl is-${GLYPH[v.state]}`} aria-hidden="true">
          {v.state === 'done' && <Icon name="check" size={11} stroke={2.6} />}
          {v.state === 'unclear' && '?'}
        </span>
      )}
      <span className="ask-verdict-t"><InlineText text={v.label} /></span>
    </p>
  );
}

/** A `:::detail` box: folded with Short answers, open with Detailed, or as it was left; its header is the toggle. */
function Detail({ title, body, chips, open: initial, fold, tail }: { title: string; body: AnswerBlock[]; chips: Chips; open: boolean; fold: string | null; tail?: ReactNode }) {
  const [open, setOpen] = useState(() => (fold !== null ? folded.get(fold) : undefined) ?? initial);
  const id = useId();
  const toggle = () => {
    setOpen(!open);
    if (fold !== null) rememberFold(fold, !open);
  };
  return (
    <>
      <div className={`ask-detail${open ? ' is-open' : ''}`}>
        <button type="button" className="ask-detail-hd" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle} data-copy="keep" data-copy-wrap="strong">
          <span className="ask-detail-label" data-copy="skip">{t.companion.detail}</span>{' '}
          <span className="ask-detail-t"><InlineText text={title} links={false} /></span>
          <Icon name="chevronDown" size={14} stroke={1.7} />
        </button>
        {open && <div id={id} className="ask-detail-bd"><Blocks blocks={body} chips={chips} open={false} folds={null} tail={tail} /></div>}
      </div>
      {!open && tail}
    </>
  );
}
