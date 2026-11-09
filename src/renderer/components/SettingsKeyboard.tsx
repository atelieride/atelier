// Settings › Keyboard (read-only): every shortcut, filterable. Loaded with its section — the list is long and the first
// paint has no room for it.
import { useState } from 'react';
import { t } from '../i18n/en';
import { SHORTCUTS } from '../shortcuts';
import { Icon } from './Icon';

export function Keyboard() {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const groups = SHORTCUTS.map((g) => ({ ...g, items: g.items.filter((i) => !needle || i.label.toLowerCase().includes(needle) || i.keys.toLowerCase().includes(needle)) })).filter((g) => g.items.length > 0);
  return (
    <>
      <div className="set-search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); } }} placeholder={t.set.searchShortcuts} aria-label={t.set.searchShortcuts} spellCheck={false} /></div>
      {groups.map((g) => (
        <div key={g.title} className="kb-group">
          <div className="set-group-title">{g.title}</div>
          {g.items.map((i) => <div key={`${i.keys}|${i.label}`} className="kb-row"><span>{i.label}</span><kbd className="mono">{i.keys}</kbd></div>)}
        </div>
      ))}
      {groups.length === 0 && <p className="set-note">{t.set.noShortcuts}</p>}
    </>
  );
}
