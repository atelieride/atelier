// The palette's table results: the tables, views and materialized views of every
// schema of the connected catalog (main's `names`), found by name — "orders · acme_dev · table"; Enter opens a
// preview, ⌘Enter a kept tab, ⌥Enter to the side, each in its own schema (no schema switch). The palette loads this
// module when it opens with a connection in use, never with the first paint; which connection that is
// (none with Never) is view.ts's liveConn.
import type { DbCatalog, DbConnView, DbRelName } from '@shared/databases';
import { fuzzyFilter } from '@shared/fuzzy';
import type { IconName } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { DB_TAB_ICON, dbTabKey } from './tabs';

/** How many a search shows: as many as Docker's containers and Redis's queues. */
export const TABLES_SHOWN = 6;

/** One result, as the palette's rows are: run opens a preview, send a kept tab (to the side with ⌥), side too. */
export interface PaletteTable {
  key: string; kind: 'command'; label: string; hint: string; icon: IconName; sendLabel: string;
  run(): void; send(side: boolean): void; side(): void;
}

/**
 * The best `limit` matches for `query` among every schema's relations of `catalog`, when it is `conn`'s and `conn` is
 * connected: scored by name, rows built only for those shown (10,000 relations cost one pass of the scorer per
 * keystroke). A name another schema has too leads its hint with its schema.
 */
export function paletteTables(catalog: DbCatalog | null, conn: DbConnView | null, query: string, limit = TABLES_SHOWN): PaletteTable[] {
  if (!query || !catalog || conn?.state !== 'connected' || conn.conn.id !== catalog.connId) return [];
  const { id, name } = conn.conn;
  // No names from main (their read failed): the sidebar's schema, which the catalog always has.
  const names: DbRelName[] = catalog.names.length > 0 ? catalog.names : catalog.rels;
  return fuzzyFilter(names, query, (r) => r.name, limit).map((r) => {
    const open = (o: { preview: boolean; side?: true }) => useApp.getState().openDbTab({ connId: id, schema: r.schema, name: r.name, kind: r.kind, view: 'data' }, o);
    const twin = names.some((o) => o.name === r.name && o.schema !== r.schema);
    return {
      key: `dbt-${dbTabKey(id, r.schema, r.name)}`, kind: 'command', label: r.name,
      hint: `${twin ? `${r.schema} · ` : ''}${name} · ${t.db.tab.kind[r.kind].toLowerCase()}`, icon: DB_TAB_ICON[r.kind], sendLabel: t.db.palette.keep,
      run: () => open({ preview: true }), send: (side) => open(side ? { preview: false, side } : { preview: false }), side: () => open({ preview: false, side: true })
    };
  });
}

/**
 * The group's quiet line: when main's list stopped at its cap, how many relations the search went through; when the
 * names' read failed (none, though the sidebar's schema has some), that only that schema was searched.
 */
export function paletteNote(catalog: DbCatalog | null): string | null {
  if (!catalog) return null;
  if (catalog.names.length === 0 && catalog.rels.length > 0) return t.db.palette.schemaOnly(catalog.schema);
  return catalog.namesMore ? t.db.palette.more(catalog.names.length) : null;
}
