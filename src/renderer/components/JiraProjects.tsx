// Jira's "Projects" on its details page: the empty state, one row per chosen
// project (key tile, name, type, whose issues and how many, Mine | Everyone, remove; amber for a service project and
// for one Atelier can't read), and the floating picker that adds one (JiraPicker). Mine | Everyone saves at once
// (setSourceScope) and the row says "Loading…" until the refresh it started lands, as Notion's fields edits do
// (notion-view.ts saveStarted/saveAnswered/saveProgress). The words come from jira-view.ts.
import { useEffect, useRef, useState } from 'react';
import type { ConnectorInfo, ProjectInfo } from '@shared/tasks';
import { t } from '../i18n/en';
import { projectSubLine, projectTypeLabel } from '../jira-view';
import { saveAnswered, saveProgress, saveStarted, type FieldsSave } from '../notion-view';
import { Icon } from './Icon';
import { JiraPicker } from './JiraPicker';
import { Segmented } from './Segmented';

const j = t.conn.jira;
const FLASH_MS = 1600;

const without = <V,>(map: Record<string, V>, key: string): Record<string, V> => {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
};

export function JiraProjects({ c }: { c: ConnectorInfo }) {
  const projects = c.projects ?? [];
  const section = useRef<HTMLElement>(null);
  const [picking, setPicking] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // Mine | Everyone changes waiting for their refresh, and the choice shown meanwhile (main's reply replaces it).
  const [saves, setSaves] = useState<Record<string, FieldsSave>>({});
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);
  const sent = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<readonly string[]>([]);

  useEffect(() => {
    setSaves((prev) => {
      let changed = false;
      const next: Record<string, FieldsSave> = {};
      for (const [id, s] of Object.entries(prev)) {
        const r = saveProgress(s, c);
        if (r !== s) changed = true;
        if (r) next[id] = r;
      }
      return changed ? next : prev;
    });
  }, [c]);

  useEffect(() => {
    if (!flash.length) return;
    section.current?.querySelector(`[data-source="${CSS.escape(flash[0]!)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const id = setTimeout(() => setFlash([]), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);

  const openPicker = (e: React.MouseEvent<HTMLElement>) => { opener.current = e.currentTarget; setPicking(true); };
  const closePicker = () => {
    setPicking(false);
    requestAnimationFrame(() => {
      const el = opener.current?.isConnected ? opener.current : section.current?.querySelector<HTMLElement>('.nsrc-add');
      el?.focus();
    });
  };

  const setScope = (p: ProjectInfo, everyone: boolean) => {
    if ((drafts[p.id] ?? p.everyone) === everyone) return;
    const seq = (sent.current[p.id] ?? 0) + 1;
    sent.current[p.id] = seq;
    setDrafts((d) => ({ ...d, [p.id]: everyone }));
    setSaves((s) => ({ ...s, [p.id]: saveStarted(c) }));
    const answered = (reply: ConnectorInfo | null) => {
      if (sent.current[p.id] !== seq) return;
      setDrafts((d) => without(d, p.id));
      setSaves((s) => {
        const cur = s[p.id];
        const next = cur && reply ? saveAnswered(cur, reply) : null;
        return next ? { ...s, [p.id]: next } : without(s, p.id);
      });
    };
    window.atelier.connectors.setSourceScope(c.id, p.id, everyone).then(answered, () => answered(null));
  };

  const remove = (p: ProjectInfo) => {
    const rows = [...(section.current?.querySelectorAll<HTMLElement>('.nsrc-row') ?? [])];
    const at = rows.findIndex((r) => r.dataset.source === p.id);
    const next = rows[at + 1]?.dataset.source ?? rows[at - 1]?.dataset.source;
    setRemoveFailed(null);
    window.atelier.connectors.removeSource(c.id, p.id)
      .then((reply) => reply.projects?.some((x) => x.id === p.id), () => true)
      .then((kept) => { if (kept) setRemoveFailed(j.removeFailed(p.key)); });
    requestAnimationFrame(() => {
      const target = next ? section.current?.querySelector<HTMLElement>(`[data-source="${CSS.escape(next)}"] .nsrc-remove`) : null;
      (target ?? section.current?.querySelector<HTMLElement>('.nsrc-add'))?.focus();
    });
  };

  return (
    <section ref={section} className="nsrc jsrc" aria-labelledby="jsrc-label">
      <div className="nsrc-head">
        <h3 className="nsrc-label" id="jsrc-label">{j.section}</h3>
        {projects.length > 0 && (
          <button type="button" className="btn-ghost sm nsrc-add" onClick={openPicker}>
            <Icon name="plus" size={12} stroke={2.2} />{j.add}
          </button>
        )}
      </div>
      {projects.length === 0 ? (
        <div className="nsrc-empty">
          <span className="nsrc-empty-glyph" aria-hidden="true"><Icon name="jira" size={20} stroke={1.8} /></span>
          <span className="nsrc-empty-title">{j.emptyTitle}</span>
          <p className="nsrc-empty-text">{j.emptyText}</p>
          <button type="button" className="btn-primary nsrc-add" onClick={openPicker}>
            <Icon name="plus" size={13} stroke={2.2} />{j.add}
          </button>
        </div>
      ) : (
        <ul className="nsrc-list">
          {projects.map((p) => (
            <ProjectRow key={p.id} c={c} p={p} everyone={drafts[p.id] ?? p.everyone} saving={!!saves[p.id]} flash={flash.includes(p.id)}
              onScope={(v) => setScope(p, v)} onRemove={() => remove(p)} />
          ))}
        </ul>
      )}
      {removeFailed && <p className="nsrc-fail" role="status">{removeFailed}</p>}
      {picking && <JiraPicker c={c} onClose={closePicker} onAdded={(ids) => { closePicker(); setFlash(ids); }} />}
    </section>
  );
}

interface RowProps {
  c: ConnectorInfo;
  p: ProjectInfo;
  everyone: boolean;
  saving: boolean;
  flash: boolean;
  onScope(everyone: boolean): void;
  onRemove(): void;
}

/** One project: key tile, name and type, whose issues and how many, Mine | Everyone, ×. */
function ProjectRow({ c, p, everyone, saving, flash, onScope, onRemove }: RowProps) {
  const service = p.type === 'service_desk';
  const name = (
    <div className="nsrc-name-row">
      <span className="nsrc-name">{p.name}</span>
      <span className={`jsrc-type${service ? ' is-service' : ''}`}>{projectTypeLabel(p.type)}</span>
    </div>
  );
  const tile = <span className="jsrc-key mono" aria-hidden="true">{p.key}</span>;
  if (p.error) {
    return (
      <li className={`nsrc-row is-warn${flash ? ' is-flash' : ''}`} data-source={p.id}>
        <div className="nsrc-row-head">
          {tile}
          <div className="nsrc-text">
            {name}
            <span className="nsrc-warn">{j.unreadable}</span>
          </div>
          <button type="button" className="btn-ghost sm nsrc-remove" aria-label={j.removeLabel(p.key, p.name)} onClick={onRemove}>{j.remove}</button>
        </div>
      </li>
    );
  }
  const sub = projectSubLine({ ...p, everyone }, { includeClosed: c.options.includeClosed, saving });
  return (
    <li className={`nsrc-row${service ? ' is-service' : ''}${flash ? ' is-flash' : ''}`} data-source={p.id}>
      <div className="nsrc-row-head">
        {tile}
        <div className="nsrc-text">
          {name}
          <span key={sub === j.loading ? 'loading' : 'sub'} className={`nsrc-sub${sub === j.loading ? ' is-loading' : ''}`}>{sub}</span>
        </div>
        <div className="jsrc-scope">
          <Segmented label={j.whose(p.key)} value={everyone ? 'everyone' : 'mine'}
            options={[{ value: 'mine', label: j.mine }, { value: 'everyone', label: j.everyone }]} onChange={(v) => onScope(v === 'everyone')} />
        </div>
        <button type="button" className="nsrc-ib nsrc-remove" aria-label={j.removeLabel(p.key, p.name)} data-tip={j.remove} onClick={onRemove}>
          <Icon name="x" size={13} stroke={2} />
        </button>
      </div>
      {service && <p className="jsrc-service"><Icon name="warning" size={12} stroke={1.9} />{j.serviceNote}</p>}
    </li>
  );
}
