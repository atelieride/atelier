import { parseInline, type Span } from '@shared/companion/answer';
import { AnswerLink } from './AnswerLink';

/**
 * One run of an answer's text: plain, bold, italic or code. An answer's body writes bold as `strong` (its emphasis color);
 * a line elsewhere (a verdict's label, a card) as `b`, in its own color.
 */
export function SpanView({ s, strong = false }: { s: Span; strong?: boolean }) {
  switch (s.t) {
    case 'text': return <>{s.s}</>;
    case 'bold': return strong ? <strong>{s.s}</strong> : <b>{s.s}</b>;
    case 'italic': return <em>{s.s}</em>;
    case 'code': return <code>{s.s}</code>;
  }
}

/** A link's label, run by run. */
export const LinkLabel = ({ label, strong }: { label: readonly Span[]; strong?: boolean }) => <>{label.map((s, k) => <SpanView key={k} s={s} strong={strong} />)}</>;

/**
 * A line the model wrote, with its closed inline subset: bold, italic, code and links. A file reference stays code here
 * (the answers' file chips resolve it against the project). `links` false draws a link as its label alone, for a line
 * inside a control (a Detail's toggle): a link never sits inside a button.
 */
export function InlineText({ text, links = true }: { text: string; links?: boolean }) {
  return (
    <>
      {parseInline(text).map((i, k) => {
        switch (i.t) {
          case 'file': return <code key={k}>{i.raw}</code>;
          case 'link': return links ? <AnswerLink key={k} url={i.url}><LinkLabel label={i.label} /></AnswerLink> : <LinkLabel key={k} label={i.label} />;
          default: return <SpanView key={k} s={i} />;
        }
      })}
    </>
  );
}
