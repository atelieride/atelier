// Changes' Filters: the funnel in the panel's head and the popover under it —
// group by repository or session; show all, this workspace's, this activity's or this session's changes (each offered
// only when its feature is on); folders on the rows. Nothing else in the head.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { filtersView } from '../changes-filters';
import type { ChangesGrouping } from '../changes-prefs';
import { scopeInEffect, scopesOffered, type ChangesScope } from '../changes-scope';
import { t } from '../i18n/en';
import { radioNext } from '../radio';
import { useApp } from '../store';
import { workspaceOf } from '../workspaces';
import { Icon, type IconName } from './Icon';

const GROUPS = ['repo', 'session'] as const;
const SCOPE_ICONS: Record<ChangesScope, IconName> = { all: 'repoAll', ws: 'workspace', activity: 'wsActivity', session: 'sessions' };

/** The arrows move a radio group's choice, and the focus with it. */
function arrowsOf<V extends string>(values: readonly V[], value: V, onPick: (v: V) => void) {
  return (e: KeyboardEvent<HTMLDivElement>) => {
    const n = radioNext(values, value, e.key);
    if (!n) return;
    e.preventDefault();
    onPick(n);
    (e.currentTarget.children[values.indexOf(n)] as HTMLElement | undefined)?.focus();
  };
}

/**
 * Show: one row per offered choice, never wrapping — its label, then on the right what it follows now (the workspace,
 * the activity, the session), cut with an ellipsis; the whole name in the tooltip. The label is the radio's name, the
 * name its description.
 */
function ScopeList({ label, values, value, details, onPick }: {
  label: string; values: readonly ChangesScope[]; value: ChangesScope; details: Partial<Record<ChangesScope, string>>; onPick: (v: ChangesScope) => void;
}) {
  const id = useId();
  const tf = t.changesFilters;
  const names: Record<ChangesScope, string> = { all: tf.showAll, ws: tf.showWorkspace, activity: tf.showActivity, session: tf.showSession };
  return (
    <div className="cf-sec">
      <span className="cf-k" aria-hidden="true">{label}</span>
      <div className="cf-list" role="radiogroup" aria-label={label} onKeyDown={arrowsOf(values, value, onPick)}>
        {values.map((v) => {
          const detail = details[v];
          return (
            <button key={v} type="button" role="radio" aria-checked={value === v} tabIndex={value === v ? 0 : -1}
              className={`cf-opt${value === v ? ' is-on' : ''}`} aria-labelledby={`${id}${v}-l`} aria-describedby={detail ? `${id}${v}-d` : undefined}
              data-tip={detail ? `${names[v]} · ${detail}` : undefined} onClick={() => onPick(v)}>
              <Icon name={SCOPE_ICONS[v]} size={12} stroke={1.8} />
              <span id={`${id}${v}-l`} className="cf-opt-label">{names[v]}</span>
              {detail && <span id={`${id}${v}-d`} className="cf-opt-name">{detail}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Group by: two choices in equal halves. */
function Choice<V extends string>({ label, values, value, names, onPick }: {
  label: string; values: readonly V[]; value: V; names: Record<V, string>; onPick: (v: V) => void;
}) {
  return (
    <div className="cf-sec">
      <span className="cf-k" aria-hidden="true">{label}</span>
      <div className="seg cf-seg" role="radiogroup" aria-label={label} onKeyDown={arrowsOf(values, value, onPick)}>
        {values.map((v) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} tabIndex={value === v ? 0 : -1}
            className={value === v ? 'is-on' : ''} onClick={() => onPick(v)}>
            {names[v]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChangesFilters() {
  const group = useApp((s) => s.changesGroup);
  const scope = useApp((s) => s.changesScope);
  const folders = useApp((s) => s.changesExpanded);
  const ws = useApp((s) => s.ws);
  const popout = useApp((s) => !!s.popout);
  const activities = useApp((s) => s.settings.wsActivities);
  // What This session follows, by name (the terminal's title changes as Claude names it).
  const session = useApp((s) => (s.changesSession === null ? null : s.terminals.find((x) => x.id === s.changesSession)?.title ?? null));
  const [open, setOpen] = useState(false);
  const funnel = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const offered = scopesOffered({ wsOn: !!ws?.on, activities, popout });
  const view = filtersView(group, scope, offered);
  const tf = t.changesFilters;
  // What each choice follows now: the workspace in front, its activity (or its own tabs), the Claude session in front.
  const place = ws?.on ? ws.list.find((w) => w.id === ws.active) : undefined;
  const details: Partial<Record<ChangesScope, string>> = {
    ...(ws?.on ? { ws: ws.list.find((w) => w.id === workspaceOf(ws, ws.active))?.name ?? '' } : {}),
    activity: place?.parent !== undefined ? place.name : tf.outsideActivities,
    session: session ?? tf.noneInFront
  };

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
          {offered.length > 1 && (
            <ScopeList label={tf.show} values={offered} value={scopeInEffect(scope, offered)} details={details}
              onPick={(v) => useApp.getState().setChangesScope(v)} />
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
