import { Fragment } from 'react';
import { parseInline } from '@shared/companion/answer';

/**
 * A line the model wrote, with its closed inline subset: bold, italic and code. A file
 * reference stays code here (the answers' file chips resolve it against the project).
 */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((i, k) => {
        switch (i.t) {
          case 'text': return <Fragment key={k}>{i.s}</Fragment>;
          case 'bold': return <b key={k}>{i.s}</b>;
          case 'italic': return <em key={k}>{i.s}</em>;
          case 'code': return <code key={k}>{i.s}</code>;
          case 'file': return <code key={k}>{i.raw}</code>;
        }
      })}
    </>
  );
}
