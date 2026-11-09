// The segmented control (Settings, the Databases sheet): like a native radio group, a single Tab stop (the chosen
// option), arrows move and choose. Its own small module, so a lazy chunk can use it without Settings.
import { radioNext } from '../radio';

/** cls: the option's own class; dot: a dot before its label, by class; tip: its tooltip. */
export interface SegOption<V extends string> { value: V; label: string; cls?: string; dot?: string; tip?: string }

/** className: the group's own look; labelClass: each label in a span of that class (one that ellipsizes). */
export function Segmented<V extends string>({ label, value, options, onChange, disabled = false, className, labelClass }: {
  label: string; value: V; options: SegOption<V>[]; onChange: (v: V) => void; disabled?: boolean; className?: string; labelClass?: string;
}) {
  return (
    <div className={className ? `set-seg ${className}` : 'set-seg'} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={(e) => {
      if (disabled) return;
      const next = radioNext(options.map((o) => o.value), value, e.key);
      if (next === null) return;
      e.preventDefault();
      onChange(next);
      (e.currentTarget.querySelector(`[data-value="${CSS.escape(next)}"]`) as HTMLElement | null)?.focus();
    }}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} data-value={o.value} disabled={disabled}
          className={`set-seg-opt${o.cls ? ` ${o.cls}` : ''}${o.value === value ? ' is-on' : ''}`} data-tip={o.tip} onClick={() => onChange(o.value)}>
          {o.dot && <i className={o.dot} aria-hidden="true" />}{labelClass ? <span className={labelClass}>{o.label}</span> : o.label}
        </button>
      ))}
    </div>
  );
}
