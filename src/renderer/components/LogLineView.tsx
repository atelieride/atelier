import { memo, useEffect, useRef, useState } from 'react';
import { parseLogLine, type LogLine } from '@shared/logline';
import { t } from '../i18n/en';
import { Icon } from './Icon';
import { idStyle } from '../avatar';

// Lines are parsed once: the same text comes back on every render.
const cache = new Map<string, LogLine>();
export function parsed(raw: string): LogLine {
  let l = cache.get(raw);
  if (!l) {
    l = parseLogLine(raw);
    if (cache.size > 20000) cache.clear();
    cache.set(raw, l);
  }
  return l;
}

const LEVEL_COLOR: Record<string, string> = { error: 'var(--error)', warn: 'var(--waiting)', ok: 'var(--done)', info: 'var(--text-4)', plain: 'var(--text-4)' };
const LEVEL_LABEL: Record<string, string> = { error: 'ERROR', warn: 'WARN', ok: 'OK', info: 'INFO', plain: '' };

/** Where an error line is pasted: the session's name (accessible name, tooltip) and its color (the button's dot). */
export interface PasteTarget { title: string; color: string }

/**
 * One log line. Too long for its card (measured on hover: thousands of lines are never measured up front), it shows a
 * chevron; a click on the line (not a drag selecting text) or on the chevron shows it whole, again (or Escape on the
 * chevron) folds it. Keyboard focus entering the card measures every line (`measure` changes). `onToggle` absent: the line can't expand (the card wraps every line).
 */
export const LogLineView = memo(function LogLineView({ raw, paste, onPaste, expanded = false, onToggle, measure: measureKey = 0 }: { raw: string; paste: PasteTarget | null; onPaste: (text: string) => void; expanded?: boolean; onToggle?: () => void; measure?: number }) {
  const l = parsed(raw);
  const text = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const measure = () => { const el = text.current; if (el && !expanded) setCut(el.scrollWidth > el.clientWidth + 1); };
  // Keyboard focus came into the card (measureKey changed): measured without a hover, so the chevron can be tabbed to.
  useEffect(() => { if (measureKey > 0) measure(); }, [measureKey]);
  const canToggle = !!onToggle && (cut || expanded);
  const toggle = () => { if (canToggle) onToggle!(); };
  return (
    <div className={`log-line lv-${l.level} ${expanded ? 'is-expanded' : ''} ${canToggle ? 'can-expand' : ''}`} onMouseEnter={measure}
      onClick={(e) => {
        // A drag that selected text is a selection, not a click.
        if ((e.target as HTMLElement).closest('button') || !window.getSelection()?.isCollapsed) return;
        toggle();
      }}>
      {l.time && <span className="log-time">{l.time}</span>}
      <span className="log-level" style={{ color: LEVEL_COLOR[l.level] }}>{LEVEL_LABEL[l.level]}</span>
      <span ref={text} className="log-text">
        {l.json
          ? l.json.map(([k, v], i) => (
              <span key={i} className="kv"><span className="kv-k">{k}=</span><span className="kv-v">{v}</span></span>
            ))
          : l.segs.map((s, i) => (
              <span key={i} style={{ color: s.color ?? undefined, fontWeight: s.bold ? 600 : undefined }}>{s.text}</span>
            ))}
      </span>
      {(canToggle || (l.level === 'error' && paste)) && (
        // Over the end of the line, shown on hover or keyboard focus: they never take room from the text.
        <span className="log-actions">
      {canToggle && (
        <button type="button" className="log-more" aria-expanded={expanded} aria-label={expanded ? t.logs.foldLine : t.logs.showLine} data-tip={expanded ? t.logs.foldLine : t.logs.showLine}
          onClick={toggle} onKeyDown={(e) => { if (e.key === 'Escape' && expanded) { e.stopPropagation(); toggle(); } }}>
          <Icon name="chevron" size={11} stroke={2} />
        </button>
      )}
      {l.level === 'error' && paste && (
        <button type="button" className="log-paste" onClick={() => onPaste(l.text)} aria-label={t.pasteInto(paste.title)} data-tip={t.pasteInto(paste.title)}>
          <i className="log-paste-dot id-dot" style={idStyle(paste.color)} aria-hidden="true" />{t.logs.paste}
        </button>
      )}
        </span>
      )}
    </div>
  );
});
