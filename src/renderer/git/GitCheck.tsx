import { Icon } from '../components/Icon';

/**
 * A checkbox of the staging column: checked, indeterminate (`partial` or a group's `some`) or
 * empty. Disabled stays hoverable (aria-disabled, never `disabled`) so its tooltip can say why.
 */
export function GitCheck({ state, disabled, label, onToggle }: { state: 'none' | 'some' | 'partial' | 'all'; disabled: string | null; label: string; onToggle: () => void }) {
  const mixed = state === 'some' || state === 'partial';
  return (
    <button type="button" role="checkbox" aria-checked={mixed ? 'mixed' : state === 'all'} aria-disabled={disabled ? true : undefined} aria-label={label}
      className={`git-check is-${mixed ? 'partial' : state} ${disabled ? 'is-disabled' : ''}`} data-tip={disabled ?? undefined}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onToggle(); }}>
      {state === 'all' && <Icon name="check" size={11} stroke={2.6} />}
      {mixed && <i className="git-check-dash" />}
    </button>
  );
}
