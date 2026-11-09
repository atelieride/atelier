// CSV viewer: the pane's floating parts — a popover shell (outside click and Esc close it),
// the Go to Row sheet and the cell peek panel.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { groupInt, parseGoTo } from './format';
import { t } from '../i18n/en';
import { Icon } from '../components/Icon';
import { kbd } from '../kbd';

/** A floating card in the pane; closes on a click outside it or Esc (the keyboard goes back to the table). `ignore`:
 * the control that opens it (its own click toggles it). */
export function Popover({ style, label, onClose, children, className = '', ignore }: { style: CSSProperties; label: string; onClose: () => void; children: ReactNode; className?: string; ignore?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const target = e.target as Element;
      if (ref.current && !ref.current.contains(target) && !(ignore && target.closest?.(ignore))) close.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); } };
    document.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, []);
  return <div ref={ref} className={`csv-pop ${className}`} style={style} role="dialog" aria-label={label}>{children}</div>;
}

/** Go to Row (⌃G): a row number, a cell like H48213, or -1 for the last row. */
export function GoToSheet({ rows, onGo, onClose }: { rows: number; onGo: (row: number, col: number | null) => void; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <Popover className="csv-goto" style={{}} label={t.csv.goToRow} onClose={onClose}>
      <label className={`csv-goto-in ${bad ? 'is-bad' : ''}`}>
        <span className="csv-goto-p">{t.csv.goTo.label}</span>
        <input ref={input} type="text" value={value} spellCheck={false} aria-label={t.csv.goToRow} inputMode="numeric"
          onChange={(e) => { setValue(e.target.value); setBad(false); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const at = parseGoTo(value, rows);
            if (!at) { setBad(true); return; }
            onGo(at.row, at.col);
          }} />
        <span className="json-kbd">{kbd('⏎')}</span>
      </label>
      <div className="csv-goto-hint">{bad ? t.csv.goTo.invalid : t.csv.goTo.hint(groupInt(rows))}</div>
    </Popover>
  );
}

type Tok = { text: string; cls: string };

/** Pretty JSON split into colored pieces (keys, strings, numbers, literals, punctuation). */
function jsonTokens(pretty: string): Tok[] {
  const out: Tok[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])|(\s+)|(.)/g;
  for (const m of pretty.matchAll(re)) {
    if (m[1]) { out.push({ text: m[1], cls: m[2] ? 'jt-key' : 'jt-v-string' }); if (m[2]) out.push({ text: m[2], cls: 'jt-colon' }); }
    else if (m[3]) out.push({ text: m[3], cls: 'jt-v-number' });
    else if (m[4]) out.push({ text: m[4], cls: 'jt-v-boolean' });
    else if (m[5]) out.push({ text: m[5], cls: 'csv-punct' });
    else out.push({ text: m[0], cls: '' });
  }
  return out;
}

/** The cell peek (Space): the whole value, JSON pretty-printed and colored. */
export function CellPeek({ address, column, value, onCopy, onShowSource, onClose }: {
  address: string; column: string; value: string; onCopy: () => void; onShowSource: () => void; onClose: () => void;
}) {
  let pretty: string | null = null;
  let info = t.csv.peek.chars(groupInt([...value].length));
  const s = value.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const v: unknown = JSON.parse(s);
      if (v && typeof v === 'object') {
        pretty = JSON.stringify(v, null, 2);
        info = t.csv.peek.json(Array.isArray(v) ? 'array' : 'object', Array.isArray(v) ? v.length : Object.keys(v).length);
      }
    } catch { /* not JSON: shown as text */ }
  }
  return (
    <div className="csv-peek" aria-label={t.csv.peek.title} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="csv-peek-bar">
        <span className="csv-peek-lbl">{t.csv.peek.title}</span>
        <span className="csv-addr">{address}</span>
        <span className="csv-peek-meta">{column} · {info}</span>
        <span className="grow" />
        <button type="button" className="csv-peek-act" onClick={onCopy}>{t.csv.peek.copyValue} <span className="json-kbd">{kbd('⌘C')}</span></button>
        <button type="button" className="csv-peek-act" onClick={onShowSource}>{t.csv.showInSource} <span className="json-kbd">{kbd('⌥⏎')}</span></button>
        <button type="button" className="icon-btn csv-peek-x" aria-label={t.csv.peek.close} onClick={onClose}><Icon name="x" size={12} stroke={2} /></button>
      </div>
      <pre className="csv-peek-body">{pretty ? jsonTokens(pretty).map((tok, i) => <span key={i} className={tok.cls || undefined}>{tok.text}</span>) : value}</pre>
    </div>
  );
}
