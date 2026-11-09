import { THEMES, type ThemeId } from '@shared/themes';
import { radioNext } from '../radio';
import { t } from '../i18n/en';

/**
 * Settings › Appearance › Theme: one card per theme, each drawn in its own colors (its block in
 * themes.css also matches [data-theme-preview]). A radio group: one Tab stop, arrows move and choose.
 */
export function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (v: ThemeId) => void }) {
  return (
    <div className="theme-cards" role="radiogroup" aria-label={t.set.theme} onKeyDown={(e) => {
      const next = radioNext(THEMES.map((th) => th.id), value, e.key);
      if (next === null) return;
      e.preventDefault();
      onChange(next);
      (e.currentTarget.querySelector(`[data-value="${CSS.escape(next)}"]`) as HTMLElement | null)?.focus();
    }}>
      {THEMES.map((th) => {
        const on = th.id === value;
        const badge = on ? t.set.themeInUse : th.id === 'aurora' ? t.set.themeDefault : null;
        return (
          <button key={th.id} type="button" role="radio" aria-checked={on} aria-label={th.name} tabIndex={on ? 0 : -1} data-value={th.id}
            className={`theme-card${on ? ' is-on' : ''}`} onClick={() => onChange(th.id)}>
            <ThemeThumb id={th.id} />
            {badge && <span className={`theme-card-badge${on ? ' is-on' : ''}`}>{badge}</span>}
            <span className="theme-card-foot">
              <span className="theme-card-name">{th.name}</span>
              <span className="theme-card-kind">{t.set.themeKinds[th.appearance]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A small drawing of the app in a theme: header, sidebar with a selected row and three states, a terminal. */
export function ThemeThumb({ id }: { id: ThemeId }) {
  return (
    <span className="theme-thumb" data-theme-preview={id} aria-hidden="true">
      <span className="tt-head"><i /><i /><b /><em /></span>
      <span className="tt-body">
        <span className="tt-side">
          <span className="tt-sel" />
          <span className="tt-row"><i className="is-waiting" /><b /></span>
          <span className="tt-row"><i className="is-working" /><b /></span>
          <span className="tt-row"><i className="is-done" /><b /></span>
        </span>
        <span className="tt-term"><b className="l1" /><b className="l2" /><b className="l3" /><b className="l4" /></span>
      </span>
    </span>
  );
}
