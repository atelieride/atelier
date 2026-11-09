// Changes' Filters: the funnel in the panel's head and the popover under it —
// group by repository or session, this workspace or all (workspaces on), folders on the rows. Nothing else in the head.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { filtersView } from '../changes-filters';
import type { ChangesGrouping } from '../changes-prefs';
import { t } from '../i18n/en';
import { radioNext } from '../radio';
import { useApp } from '../store';
import { Icon } from './Icon';

const GROUPS = ['repo', 'session'] as const;
const SCOPES = ['ws', 'all'] as const;

/** A two-choice radio group in equal halves; the arrows move the choice (and the focus with it). */
function Choice<V extends string>({ label, values, value, names, icons, onPick }: {
  label: string; values: readonly V[]; value: V; names: Record<V, string>; icons?: Partial<Record<V, 'workspace'>>; onPick: (v: V) => void;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = radioNext(values, value, e.key);
    if (!n) return;
    e.preventDefault();
    onPick(n);
    (e.currentTarget.children[values.indexOf(n)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="cf-sec">
      <span className="cf-k" aria-hidden="true">{label}</span>
      <div className="seg cf-seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
        {values.map((v) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} tabIndex={value === v ? 0 : -1}
            className={value === v ? 'is-on' : ''} onClick={() => onPick(v)}>
            {icons?.[v] && <Icon name={icons[v]} size={12} stroke={1.8} />}{names[v]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChangesFilters({ wsOn }: { wsOn: boolean }) {
  const group = useApp((s) => s.changesGroup);
  const scope = useApp((s) => s.changesScope);
  const folders = useApp((s) => s.changesExpanded);
  const [open, setOpen] = useState(false);
  const funnel = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const view = filtersView(group, scope, wsOn);
  const tf = t.changesFilters;

  const close = (back: boolean) => { setOpen(false); if (back) funnel.current?.focus(); };
  // Opened: the focus on the chosen grouping. A press outside (the funnel aside: it toggles) closes it.
  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    const down = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!target || pop.current?.contains(target) || funnel.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open]);

  const reset = () => {
    const st = useApp.getState();
    // Rendered at once (the Reset button goes away with it), so the focus moves to the grouping before the next key: an
    // Esc pressed right after still reaches the popover.
    flushSync(() => { st.setChangesGroup('repo'); st.setChangesScope('all'); });
    pop.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  };
  const pick = (g: ChangesGrouping) => useApp.getState().setChangesGroup(g);
  // The focus leaving the popover and its funnel (Tab, Shift+Tab, a click on something focusable) closes it: never left
  // open behind the focus. A click on a bare spot has no target (null): the press outside handles that.
  const onBlur = (e: { relatedTarget: EventTarget | null }) => {
    const to = e.relatedTarget;
    if (open && to instanceof Node && !pop.current?.contains(to) && !funnel.current?.contains(to)) close(false);
  };
  const lit = view.changed && !open;
  return (
    <>
      <button ref={funnel} type="button" className={`icon-btn cf-funnel${open ? ' is-open' : ''}${lit ? ' is-lit' : ''}`}
        aria-label={view.tip} aria-haspopup="dialog" aria-expanded={open} data-tip={open ? undefined : view.tip}
        onClick={() => setOpen((o) => !o)} onBlur={onBlur}>
        <Icon name="filter" size={14} stroke={1.7} />
        {lit && <i className="cf-dot" aria-hidden="true" />}
      </button>
      {open && (
        // Focusable itself (-1): a click on its text keeps the focus in it, so Esc still reaches it.
        <div ref={pop} className="cf-pop" role="dialog" aria-label={tf.title} tabIndex={-1} onBlur={onBlur}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }}>
          <Choice label={tf.groupBy} values={GROUPS} value={group} names={{ repo: tf.repository, session: tf.session }} onPick={pick} />
          {wsOn && (
            <Choice label={tf.show} values={SCOPES} value={scope} names={{ ws: t.ws.thisWorkspace, all: t.ws.allChanges }}
              icons={{ ws: 'workspace' }} onPick={(v) => useApp.getState().setChangesScope(v)} />
          )}
          <button type="button" className="cf-switch" role="switch" aria-checked={folders} data-tip={t.showFoldersTip}
            onClick={() => useApp.getState().toggleChangesExpanded()}>
            <span>{t.showFolders}</span><span className="cf-toggle" aria-hidden="true"><i /></span>
          </button>
          {view.changed && (
            <div className="cf-foot">
              <button type="button" onClick={reset}>{tf.reset}</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
