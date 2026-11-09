import { useEffect, useMemo, useRef, useState } from 'react';
import { describeTool } from '@shared/session';
import { buildRows, changeTimes, inSessionOrder, runningAt, sameMoment, sessionOrderKey, unsureOf, whereRan, type ChangeBy } from '../changes';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { hideWorktreeFolders, realPath } from '../worktrees';
import { Avatar } from './Avatar';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

/** The "someone outside Claude" option's key. */
const OUTSIDE = 'outside';

/** HH:MM:SS, local time. */
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** "Bash · 13:52:05 → 13:52:08", "→ running" when the call had not ended when the change was seen. */
function callLine(b: ChangeBy): string {
  const tool = b.via === 'tool' && b.tool ? describeTool(b.tool, {}) : 'Bash';
  if (b.callStart === undefined) return tool;
  return `${tool} · ${clock(b.callStart)} → ${b.callEnd !== undefined ? clock(b.callEnd) : t.unsure.running}`;
}

/**
 * "Why unsure": a top sheet for one file whose origin is unsure. It shows when the file
 * changed and what each candidate session was running, and lets the user say who it was — or someone outside Claude —
 * for this file and, by default, the files that changed in the same moment. ↑↓ or 1–9 pick, Enter confirms, Esc closes.
 */
export function OriginSheet({ path }: { path: string }) {
  const close = () => useApp.getState().setOriginSheet(null);
  const rawRepos = useApp((s) => s.repos);
  const attributions = useApp((s) => s.attributions);
  const order = useApp((s) => sessionOrderKey(s.terminals));
  const project = useApp((s) => s.project);
  const projectRoot = project?.realRoot ?? project?.root ?? '';
  const repos = useMemo(() => hideWorktreeFolders(rawRepos), [rawRepos]);
  const rows = useMemo(() => buildRows(repos, attributions), [repos, attributions]);
  const row = rows.find((r) => r.path === path);
  const candidates = row ? inSessionOrder(unsureOf(row), order.split('\n')) : [];
  const others = row ? sameMoment(rows, row) : [];
  // The selection by identity (a terminal id, or OUTSIDE), never by index: the candidates may change while it is open.
  const [selected, setSelected] = useState<string | null>(null);
  const [withOthers, setWithOthers] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  // The options: each candidate, then "someone outside Claude" (null).
  const options: (ChangeBy | null)[] = [...candidates, null];
  const keyOf = (o: ChangeBy | null) => o?.terminalId ?? OUTSIDE;
  const found = options.findIndex((o) => keyOf(o) === selected);
  const active = found >= 0 ? found : 0;
  const picked = options[active] ?? null;
  const select = (i: number) => {
    setSelected(keyOf(options[i] ?? null));
    // Focus follows the selection (the radiogroup pattern).
    box.current?.querySelectorAll<HTMLElement>('.origin-option')[i]?.focus();
  };

  // Focus into the sheet, and back where it was when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  // Settled meanwhile (resolved elsewhere, committed): nothing left to ask.
  const gone = !row || candidates.length === 0;
  useEffect(() => { if (gone) close(); }, [gone]);
  if (gone) return null;

  const name = row.rel.split('/').at(-1) ?? row.rel;
  const dir = row.rel.includes('/') ? row.rel.slice(0, row.rel.lastIndexOf('/')) : '';
  // Only background commands: "maybe not a session". Several moments may mix kinds: then it is unclear.
  const running = runningAt(candidates);
  const maybe = running.background;
  const confirm = () => {
    const paths = [row.path, ...(withOthers ? others.map((r) => r.path) : [])];
    void useApp.getState().resolveUnsure(paths, picked ? picked.terminalId : null, picked ? picked.title : '');
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && e.target.classList.contains('origin-keep'))) confirm();
    else if (e.key === 'ArrowDown') select((active + 1) % options.length);
    else if (e.key === 'ArrowUp') select((active - 1 + options.length) % options.length);
    else if (digit >= 0 && digit < options.length) select(digit);
    else if (e.key === 'Tab') {
      // A modal sheet: Tab cycles inside it.
      const all = [...(box.current?.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), input') ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div ref={box} className="palette origin-sheet" role="dialog" aria-modal="true" aria-label={maybe ? t.unsure.titleMaybe : t.unsure.title} tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="origin-file">
          <FileIcon name={name} size={15} />
          <span className="origin-name">{name}</span>
          {dir && <span className="origin-dir mono">{dir}</span>}
          <span className="grow" />
          <span className="origin-delta mono">{row.added !== null && `+${row.added}`}{row.removed ? ` −${row.removed}` : ''}</span>
        </div>
        <div className="origin-why">
          <h2 className="origin-title">{maybe ? t.unsure.titleMaybe : t.unsure.title}</h2>
          <p>{t.unsure.changedAt(changeTimes(candidates).map(clock), running.sessions, running.background)} {t.unsure.exactNote}</p>
        </div>
        <div className="origin-options" role="radiogroup" aria-label={t.unsure.title}>
          {options.map((o, i) => (
            <button key={keyOf(o)} type="button" role="radio" aria-checked={i === active} tabIndex={i === active ? 0 : -1}
              className={`origin-option ${i === active ? 'is-on' : ''}`} onClick={() => select(i)} onDoubleClick={confirm}>
              {o ? <Avatar title={o.title} color={o.color} size={22} /> : <span className="origin-outside-icon"><Icon name="person" size={13} stroke={1.9} /></span>}
              <span className="origin-option-main">
                <span className="origin-option-name">{o ? o.title : t.unsure.outsideLabel}</span>
                {o
                  ? <>
                    {o.command && <span className="origin-cmd mono">$ {o.command}</span>}
                    <span className="origin-meta-row">
                      <span className="origin-meta mono">{callLine(o)}</span>
                      {(() => {
                        const w = whereRan(o.cwd && realPath(o.cwd, project), row.repo, repos, projectRoot);
                        return w && <span className={`origin-where ${w.same ? 'is-same' : ''}`} data-tip={`${o.cwd} · ${t.unsure.ranFromTip}`}>{w.label}</span>;
                      })()}
                    </span>
                  </>
                  : <span className="origin-meta">{t.unsure.outsideHint}</span>}
              </span>
              {i < 9 && <span className="origin-key mono" aria-hidden="true">{i + 1}</span>}
            </button>
          ))}
        </div>
        {others.length > 0 && (
          <label className="origin-others">
            <input type="checkbox" checked={withOthers} onChange={(e) => setWithOthers(e.target.checked)} />
            {t.unsure.others(others.length)}
          </label>
        )}
        <div className="origin-actions">
          <button type="button" className="btn-primary origin-confirm" onClick={confirm}>{picked ? t.unsure.itWas(picked.title) : t.unsure.itWasOutside}</button>
          <button type="button" className="btn-ghost origin-keep" onClick={close}>{t.unsure.keep}</button>
          <span className="grow" />
          <span className="popover-hint mono">{t.unsure.keys}</span>
        </div>
      </div>
    </div>
  );
}
