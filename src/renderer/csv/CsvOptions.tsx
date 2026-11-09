// CSV viewer: the parse options popover — delimiter, header, decimal separator, lines to skip —
// each on Auto (what detection found) until chosen; kept per file.
import type { CSSProperties, KeyboardEvent } from 'react';
import { Popover } from './CsvParts';
import { MAX_SKIP } from './options';
import { AUTO_OPTIONS, type CsvOptions, type Decimal, type Delimiter, type Detected } from './types';
import { radioNext } from '../radio';
import { t } from '../i18n/en';

const DELIMS: readonly (Delimiter | 'auto')[] = ['auto', ',', ';', '\t', '|'];
const DECIMALS: readonly (Decimal | 'auto')[] = ['auto', '.', ','];

function Radios<V extends string>({ label, values, value, text, onChange }: { label: string; values: readonly V[]; value: V; text: (v: V) => string; onChange: (v: V) => void }) {
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const next = radioNext(values, value, e.key);
    if (next === null) return;
    e.preventDefault();
    onChange(next);
    (e.currentTarget.children[values.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <span className="seg csv-seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {values.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} tabIndex={value === v ? 0 : -1} className={value === v ? 'is-on' : ''} onClick={() => onChange(v)}>{text(v)}</button>
      ))}
    </span>
  );
}

export function CsvOptionsPopover({ options, detected, style, ignore, onChange, onClose }: {
  options: CsvOptions; detected: Detected; style: CSSProperties; ignore?: string; onChange: (o: CsvOptions) => void; onClose: () => void;
}) {
  const o = t.csv.options;
  const ch = (d: Delimiter) => (d === '\t' ? o.tab : d);
  const header = options.header === 'auto' ? detected.header : options.header;
  return (
    <Popover className="csv-options" style={style} label={o.title} onClose={onClose} ignore={ignore}>
      <h3>{o.title}</h3>
      <p className="csv-pop-sub">{o.sub}</p>
      <div className="csv-opt-row"><span className="csv-opt-l">{o.delimiter}</span>
        <Radios label={o.delimiter} values={DELIMS} value={options.delimiter} text={(v) => (v === 'auto' ? o.auto(ch(detected.delimiter)) : ch(v))} onChange={(delimiter) => onChange({ ...options, delimiter })} />
      </div>
      <div className="csv-opt-row"><span className="csv-opt-l">{o.header}</span>
        <button type="button" role="switch" aria-checked={header} aria-label={o.header} className="csv-switch"
          onClick={() => onChange({ ...options, header: !header === detected.header ? 'auto' : !header })}><i /></button>
      </div>
      <div className="csv-opt-row"><span className="csv-opt-l">{o.decimal}</span>
        <Radios label={o.decimal} values={DECIMALS} value={options.decimal} text={(v) => (v === 'auto' ? o.auto(detected.decimal) : v)} onChange={(decimal) => onChange({ ...options, decimal })} />
      </div>
      <div className="csv-opt-row"><span className="csv-opt-l">{o.skip}</span>
        <span className="csv-step">
          <button type="button" aria-label={o.fewer} disabled={options.skip <= 0} onClick={() => onChange({ ...options, skip: Math.max(0, options.skip - 1) })}>−</button>
          <span aria-live="polite">{options.skip}</span>
          <button type="button" aria-label={o.more} disabled={options.skip >= MAX_SKIP} onClick={() => onChange({ ...options, skip: Math.min(MAX_SKIP, options.skip + 1) })}>+</button>
        </span>
        <span className="csv-opt-d">{o.skipHint}</span>
      </div>
      <div className="csv-pop-sep" />
      <div className="csv-opt-foot"><span>{o.readOnly}</span><span className="grow" /><button type="button" className="csv-link" onClick={() => onChange(AUTO_OPTIONS)}>{o.reset}</button></div>
    </Popover>
  );
}
