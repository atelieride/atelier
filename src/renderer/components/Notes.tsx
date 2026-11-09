import type { ReactNode } from 'react';
import { inlineMarkdown, noteBlocks } from '@shared/whats-new';

/** One line of release notes: **bold** and `code` as elements, the rest as text — never HTML. */
export function Inline({ text }: { text: string }) {
  return <>{inlineMarkdown(text).map((x, i) => (x.kind === 'bold' ? <strong key={i}>{x.text}</strong> : x.kind === 'code' ? <code key={i} className="mono">{x.text}</code> : x.text))}</>;
}

/** Release notes (a CHANGELOG section): headings, paragraphs and bullets (Settings › About, What's new). */
export function Notes({ text, className = 'upd-notes-body' }: { text: string; className?: string }) {
  const blocks: ReactNode[] = noteBlocks(text).map((b, i) => (
    b.kind === 'ul' ? <ul key={i}>{b.items.map((x, j) => <li key={j}><Inline text={x} /></li>)}</ul>
      : b.kind === 'h' ? <div key={i} className="upd-notes-h"><Inline text={b.text} /></div>
        : <p key={i}><Inline text={b.text} /></p>
  ));
  return <div className={className}>{blocks}</div>;
}
