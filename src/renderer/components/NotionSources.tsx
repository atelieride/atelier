// Notion's "Task databases" on its details page (6, 7): the empty state, one row per
// chosen database (sub-line, fields button, remove; amber when Atelier can't read it), the floating picker that adds
// one, and the fields editor expanded in place, one database at a time. Every edit saves at once (setSourceFields) and
// the row says "Loading…" until the refresh it started lands. The words and states come from notion-view.ts.
import { useEffect, useRef, useState } from 'react';
import type { ConnectorInfo, NotionFields, SourceInfo } from '@shared/tasks';
import { t } from '../i18n/en';
import { saveAnswered, saveProgress, saveRefused, saveStarted, sourceSubLine, type FieldsSave } from '../notion-view';
import { Icon } from './Icon';
import { NotionFieldsEditor } from './NotionFieldsEditor';
import { NotionPicker } from './NotionPicker';

const n = t.conn.notion;
const FLASH_MS = 1600;

const without = <V,>(map: Record<string, V>, key: string): Record<string, V> => {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
};

export function NotionSources({ c }: { c: ConnectorInfo }) {
  const sources = c.sources ?? [];
  const section = useRef<HTMLElement>(null);
  const [picking, setPicking] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // The database whose fields are open (one at a time).
  const [open, setOpen] = useState<string | null>(null);
  // Edits waiting for their refresh ("Loading…"), and the fields shown meanwhile (main's reply replaces them).
  const [saves, setSaves] = useState<Record<string, FieldsSave>>({});
  const [drafts, setDrafts] = useState<Record<string, NotionFields>>({});
  // An edit main refused or never answered ("Couldn't save. Try again."), and a database that couldn't be removed.
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);
  const sent = useRef<Record<string, number>>({});
  // Databases just added (or already there when picked again): highlighted for a moment.
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

  // A database removed, or that Atelier can no longer read, closes its fields.
  useEffect(() => {
    if (open && !sources.some((s) => s.id === open && !s.error)) setOpen(null);
  }, [sources, open]);

  useEffect(() => {
    if (!flash.length) return;
    section.current?.querySelector(`[data-source="${CSS.escape(flash[0]!)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const id = setTimeout(() => setFlash([]), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);

  const openPicker = (e: React.MouseEvent<HTMLElement>) => { opener.current = e.currentTarget; setPicking(true); };
  const closePicker = () => {
    setPicking(false);
    // Back to the button that opened it, or the header's Add Database… once the empty state is gone.
    requestAnimationFrame(() => {
      const el = opener.current?.isConnected ? opener.current : section.current?.querySelector<HTMLElement>('.nsrc-add');
      el?.focus();
    });
  };

  const save = (s: SourceInfo, fields: NotionFields) => {
    const seq = (sent.current[s.id] ?? 0) + 1;
    sent.current[s.id] = seq;
    setDrafts((d) => ({ ...d, [s.id]: fields }));
    setSaves((p) => ({ ...p, [s.id]: saveStarted(c) }));
    setFailed((f) => without(f, s.id));
    const answered = (reply: ConnectorInfo | null) => {
      if (sent.current[s.id] !== seq) return; // a later edit answers for both
      // Rejected, or refused (main kept other fields): one quiet line in the editor; the fields shown go back.
      if (!reply || saveRefused(reply, s.id, fields)) setFailed((f) => ({ ...f, [s.id]: true }));
      setDrafts((d) => without(d, s.id));
      setSaves((p) => {
        const cur = p[s.id];
        const next = cur && reply ? saveAnswered(cur, reply) : null;
        return next ? { ...p, [s.id]: next } : without(p, s.id);
      });
    };
    window.atelier.connectors.setSourceFields(c.id, s.id, fields).then(answered, () => answered(null));
  };

  const remove = (s: SourceInfo) => {
    // Focus goes to the next database's row, else Add Database… (the empty state's, then).
    const rows = [...(section.current?.querySelectorAll<HTMLElement>('.nsrc-row') ?? [])];
    const at = rows.findIndex((r) => r.dataset.source === s.id);
    const next = rows[at + 1]?.dataset.source ?? rows[at - 1]?.dataset.source;
    setRemoveFailed(null);
    // Still there after main's answer (or no answer): say so under the list.
    window.atelier.connectors.removeSource(c.id, s.id)
      .then((reply) => reply.sources?.some((x) => x.id === s.id), () => true)
      .then((kept) => { if (kept) setRemoveFailed(n.removeFailed(s.name)); });
    requestAnimationFrame(() => {
      const target = next ? section.current?.querySelector<HTMLElement>(`[data-source="${CSS.escape(next)}"] .nsrc-ib, [data-source="${CSS.escape(next)}"] .nsrc-remove`) : null;
      (target ?? section.current?.querySelector<HTMLElement>('.nsrc-add'))?.focus();
    });
  };

  return (
    <section ref={section} className="nsrc" aria-labelledby="nsrc-label">
      <div className="nsrc-head">
        <h3 className="nsrc-label" id="nsrc-label">{n.section}</h3>
        {sources.length > 0 && (
          <button type="button" className="btn-ghost sm nsrc-add" onClick={openPicker}>
            <Icon name="plus" size={12} stroke={2.2} />{n.add}
          </button>
        )}
      </div>
      {sources.length === 0 ? (
        <div className="nsrc-empty">
          <span className="nsrc-empty-glyph" aria-hidden="true"><Icon name="database" size={20} stroke={1.8} /></span>
          <span className="nsrc-empty-title">{n.emptyTitle}</span>
          <p className="nsrc-empty-text">{n.emptyText}</p>
          <button type="button" className="btn-primary nsrc-add" onClick={openPicker}>
            <Icon name="plus" size={13} stroke={2.2} />{n.add}
          </button>
        </div>
      ) : (
        <ul className="nsrc-list">
          {sources.map((s) => (
            <SourceRow key={s.id} c={c} s={s} fields={drafts[s.id] ?? s.fields} saving={!!saves[s.id]} open={open === s.id}
              flash={flash.includes(s.id)} onToggle={() => setOpen((o) => (o === s.id ? null : s.id))}
              saveFailed={!!failed[s.id]} onSave={(f) => save(s, f)} onRemove={() => remove(s)} />
          ))}
        </ul>
      )}
      {removeFailed && <p className="nsrc-fail" role="status">{removeFailed}</p>}
      {picking && <NotionPicker c={c} onClose={closePicker} onAdded={(ids) => { closePicker(); setFlash(ids); }} />}
    </section>
  );
}

interface RowProps {
  c: ConnectorInfo;
  s: SourceInfo;
  fields: NotionFields;
  saving: boolean;
  open: boolean;
  flash: boolean;
  saveFailed: boolean;
  onToggle(): void;
  onSave(fields: NotionFields): void;
  onRemove(): void;
}

/** One database: glyph, name and path, whose tasks and how many, the fields button and ×. */
function SourceRow({ c, s, fields, saving, open, flash, saveFailed, onToggle, onSave, onRemove }: RowProps) {
  const name = (
    <div className="nsrc-name-row">
      <span className="nsrc-name">{s.name}</span>
      {s.path && <span className="nsrc-path">{s.path}</span>}
    </div>
  );
  if (s.error) {
    return (
      <li className={`nsrc-row is-warn${flash ? ' is-flash' : ''}`} data-source={s.id}>
        <div className="nsrc-row-head">
          <span className="nsrc-glyph" aria-hidden="true"><Icon name="warning" size={15} stroke={1.9} /></span>
          <div className="nsrc-text">
            {name}
            <span className="nsrc-warn">{n.unreadable}</span>
          </div>
          <button type="button" className="btn-ghost sm nsrc-remove" aria-label={n.removeLabel(s.name)} onClick={onRemove}>{n.remove}</button>
        </div>
      </li>
    );
  }
  const editor = `nsf-${s.id}`;
  const sub = sourceSubLine({ ...s, fields }, { includeClosed: c.options.includeClosed, saving });
  return (
    <li className={`nsrc-row${open ? ' is-open' : ''}${flash ? ' is-flash' : ''}`} data-source={s.id}>
      <div className="nsrc-row-head">
        <span className="nsrc-glyph" aria-hidden="true"><Icon name="database" size={15} stroke={1.9} /></span>
        <div className="nsrc-text">
          {name}
          <span key={sub === n.loading ? 'loading' : 'sub'} className={`nsrc-sub${sub === n.loading ? ' is-loading' : ''}`}>{sub}</span>
        </div>
        <button type="button" className={`nsrc-ib${open ? ' is-on' : ''}`} aria-expanded={open} aria-controls={open ? editor : undefined}
          aria-label={open ? n.fieldsCloseLabel(s.name) : n.fieldsLabel(s.name)} data-tip={n.fieldsTip} onClick={onToggle}>
          <Icon name="sliders" size={15} stroke={1.9} />
        </button>
        <button type="button" className="nsrc-ib" aria-label={n.removeLabel(s.name)} data-tip={n.remove} onClick={onRemove}>
          <Icon name="x" size={13} stroke={2} />
        </button>
      </div>
      {open && <NotionFieldsEditor id={editor} c={c} s={s} fields={fields} saving={saving} saveFailed={saveFailed} onChange={onSave} />}
    </li>
  );
}
