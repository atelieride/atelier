// What Notion's databases show on its details page: a database row's sub-line, the
// fields editor's choices and the fields each change saves, its preview row, the picker's rows (a pasted link included)
// and its refusals. Main decides what is valid (sources.ts checks every edit against the schema); this only says what
// to show and what to send. Pure: tested alone.
import {
  MAX_CLOSED_OPTIONS, MAX_DATABASES, type AddSourceResult, type Column, type ConnectorInfo, type NotionFields,
  type SourceInfo, type SourcePick, type TaskTone
} from '@shared/tasks';
import { cleanLine } from '@shared/clean-text';
import { guessClosed, sameNotionFields } from '@shared/notion-fields';
import { notionIdFromLink } from '@shared/notion-link';
import { t } from './i18n/en';
import { statusTone, type TaskRow } from './task-view';

const n = () => t.conn.notion;

/**
 * A database row's second line: whose tasks and how many — "Assigned to me · 4 open", "Everyone · 12 open" —
 * or "Loading…" while main lists it or a fields edit waits for its refresh. With closed tasks included they are
 * "tasks", not "open".
 */
export function sourceSubLine(s: SourceInfo, o: { includeClosed: boolean; saving?: boolean }): string {
  if (s.loading || o.saving) return n().loading;
  const who = s.fields.assignee?.mine ? n().mine : n().everyone;
  if (s.count === undefined) return who;
  return `${who} · ${o.includeClosed ? n().tasks(s.count) : n().open(s.count)}`;
}

/**
 * The preview: the first Notion task listed from that database, as the palette shows it. Main sends it on
 * the source itself (two databases may share a name, so never matched by list name). None → "No tasks match".
 */
export function previewRow(s: SourceInfo): TaskRow | null {
  const task = s.preview;
  return task ? { source: 'notion', task, tone: statusTone(task.status.color) } : null;
}

/** The editor's selects (Status, Assigned to, Due date, ID). */
export type FieldKey = 'status' | 'assignee' | 'due' | 'id';

const FIELD_TYPES: Readonly<Record<FieldKey, readonly Column['type'][]>> = {
  status: ['status', 'select'], assignee: ['person'], due: ['date'], id: ['unique_id']
};

/** The columns a select offers, in the database's order. */
export function columnsFor(columns: readonly Column[] | undefined, key: FieldKey): Column[] {
  return (columns ?? []).filter((c) => FIELD_TYPES[key].includes(c.type));
}

/**
 * A column or option name as the editor shows it: Notion's own is kept verbatim (it is sent back as is: a filter on a
 * changed name would match nothing), but zero-width and other invisible characters, and line breaks, never reach the
 * screen. Nothing visible left: a dash.
 */
export function shownName(name: string): string {
  return cleanLine(name) || '—';
}

/** The quiet type after a column's name ("Stage select", "Ticket unique ID"). */
export function columnTypeLabel(type: Column['type']): string {
  return n().types[type];
}

/** The column a field names now (null: None). */
export function fieldColumn(fields: NotionFields, key: FieldKey): string | null {
  return (key === 'status' ? fields.status?.prop : key === 'assignee' ? fields.assignee?.prop : fields[key]) ?? null;
}

export interface DoneChip { name: string; tone: TaskTone; on: boolean; disabled: boolean; tip?: string; /** Read-only chips: what they say. */ label?: string }

/**
 * Done when. A `select` status: one toggle per option, the closed ones on, the others disabled once
 * MAX_CLOSED_OPTIONS are chosen. A `status` column: read-only, its Complete group checked ("Notion's Complete group":
 * main always filters on that group). No status column, or the columns not read yet → null (no row).
 */
export function doneChips(fields: NotionFields, columns: readonly Column[] | undefined): { readOnly: boolean; chips: DoneChip[]; note?: string } | null {
  const s = fields.status;
  const col = s ? columnsFor(columns, 'status').find((c) => c.name === s.prop) : undefined;
  if (!s || !col) return null;
  const options = col.options ?? [];
  if (col.type === 'status') {
    // Not toggles: `label` says what the check mark shows, for screen readers.
    return {
      readOnly: true, note: n().completeGroup,
      chips: options.map((o) => {
        const on = o.group === 'complete';
        const shown = shownName(o.name);
        return { name: o.name, tone: o.tone, on, disabled: true, label: on ? n().inComplete(shown) : n().notInComplete(shown) };
      })
    };
  }
  const full = s.closed.length >= MAX_CLOSED_OPTIONS;
  return {
    readOnly: false,
    chips: options.map((o) => {
      const on = s.closed.includes(o.name);
      return { name: o.name, tone: o.tone, on, disabled: !on && full, ...(!on && full ? { tip: n().closedCap(MAX_CLOSED_OPTIONS) } : {}) };
    })
  };
}

/** A Done-when chip clicked: that option in or out of a select's closed list, never past the cap. */
export function toggleClosed(fields: NotionFields, option: string): NotionFields {
  const s = fields.status;
  if (!s || s.kind !== 'select') return fields;
  const on = s.closed.includes(option);
  if (!on && s.closed.length >= MAX_CLOSED_OPTIONS) return fields;
  return { ...fields, status: { ...s, closed: on ? s.closed.filter((x) => x !== option) : [...s.closed, option] } };
}

/** "Assigned to me" | "Everyone" (only with an Assigned-to column). */
export function setMine(fields: NotionFields, mine: boolean): NotionFields {
  return fields.assignee ? { ...fields, assignee: { ...fields.assignee, mine } } : fields;
}

/**
 * A select changed: the fields to save, or the same object when nothing changed (then nothing is saved). Status: a
 * `status` column always saves `closed: []` (Notion's Complete group); another `select` starts with its done-like
 * options closed (main's own guess, src/shared/notion-fields.ts), so its finished tasks never show up meanwhile.
 * Assigned to keeps "Assigned to me" / "Everyone", a first one starts as mine. `null` is "None": the field goes.
 */
export function chooseColumn(fields: NotionFields, key: FieldKey, column: Column | null): NotionFields {
  if ((column?.name ?? null) === fieldColumn(fields, key) && (key !== 'status' || !column || fields.status?.kind === column.type)) return fields;
  const { [key]: _old, ...rest } = fields;
  if (!column) return rest as NotionFields;
  switch (key) {
    case 'status': {
      const select = column.type !== 'status';
      return { ...fields, status: { prop: column.name, kind: select ? 'select' : 'status', closed: select ? guessClosed((column.options ?? []).map((o) => o.name)) : [] } };
    }
    case 'assignee':
      return { ...fields, assignee: { prop: column.name, mine: fields.assignee?.mine ?? true } };
    default:
      return { ...fields, [key]: column.name };
  }
}

// ── The picker ──────────────────────────────────────────────────────────────────────────────────────────

/** What main accepts (ipc-schemas.ts sourceSearchSchema, sourceAddSchema): a longer one would be refused as a whole. */
const MAX_QUERY_CHARS = 200;
const MAX_LINK_CHARS = 400;

/** The text sent to Notion's search: trimmed, cut to 200 characters (never in the middle of a surrogate pair). */
export function searchText(query: string): string {
  const q = query.trim();
  if (q.length <= MAX_QUERY_CHARS) return q;
  const cut = q.slice(0, MAX_QUERY_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A pasted link main would refuse for its length: the picker says so instead of a generic failure. */
export function linkRefusal(row: PickerRow): string | null {
  return row.kind === 'link' && row.ref.length > MAX_LINK_CHARS ? n().linkTooLong : null;
}

/** Search Notion for this text (debounced): two characters or more, and not a link (src/shared/notion-link.ts). */
export function shouldSearch(query: string): boolean {
  return query.trim().length >= 2 && !notionIdFromLink(query);
}

export type PickerRow =
  | { kind: 'pick'; key: string; pick: SourcePick }
  | { kind: 'link'; key: 'link'; ref: string };

/** The picker's rows: a pasted link is one "Add this database" row; else the search results (none under 2 characters). */
export function pickerRows(query: string, picks: readonly SourcePick[]): PickerRow[] {
  if (notionIdFromLink(query)) return [{ kind: 'link', key: 'link', ref: query.trim() }];
  return shouldSearch(query) ? picks.map((pick) => ({ kind: 'pick', key: pick.id, pick })) : [];
}

/**
 * ↵ on a row: a pasted link always; a search result only once the results answer the text in the field (`answered`),
 * so an Enter during the debounce never adds a database the old text found.
 */
export function canAdd(row: PickerRow, query: string, answered: string | null): boolean {
  return row.kind === 'link' || answered === query;
}

/** Why a database wasn't added, in one line under the results. */
export function addErrorText(reason: Extract<AddSourceResult, { ok: false }>['reason'], name: string): string {
  switch (reason) {
    case 'not-database': return n().notDatabase;
    case 'not-found': return n().notFound;
    case 'too-many': return n().tooMany(MAX_DATABASES);
    case 'offline': return t.conn.reasons.network(name);
    case 'failed': case 'unsupported': case 'other-site': return n().addFailed;
  }
}

// ── A fields edit in flight ───────────────────────────────────────────────────────────────────────────────────────

/**
 * From a fields edit until the refresh it started lands, the row says "Loading…" (main keeps the old count meanwhile).
 * `updatedAt`: when the tasks were last fetched, as of the reply (a refresh that landed before it read the old fields).
 */
export interface FieldsSave { phase: 'saving' | 'refreshing'; updatedAt?: number; sawLoading: boolean }

export function saveStarted(c: ConnectorInfo): FieldsSave {
  // A refresh already running read the old fields: only loading seen from now on counts.
  return { phase: 'saving', ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}), sawLoading: false };
}

/** setSourceFields answered: no refresh started (nothing changed, or refused) → done; else wait for it. */
export function saveAnswered(s: FieldsSave, reply: ConnectorInfo): FieldsSave | null {
  if (!reply.loading) return null;
  const { updatedAt: _before, ...rest } = s;
  return { ...rest, phase: 'refreshing', ...(reply.updatedAt !== undefined ? { updatedAt: reply.updatedAt } : {}) };
}

/** A new card: done once new tasks land, or a refresh was seen running and ended (it failed), or the connection left. */
export function saveProgress(s: FieldsSave, c: ConnectorInfo): FieldsSave | null {
  if (c.status !== 'connected' && c.status !== 'offline') return null;
  const seen = s.sawLoading || c.loading;
  if (s.phase === 'refreshing') {
    if (c.updatedAt !== s.updatedAt) return null;
    if (seen && !c.loading) return null;
  }
  return seen === s.sawLoading ? s : { ...s, sawLoading: seen };
}

// ── Failures in the editor (one quiet line, never a toast) ────────────────────────────────────────────────────────

/**
 * main answered an edit with other fields than those sent: it refused them (a column gone or retyped meanwhile). A
 * source gone or unreadable meanwhile says so on its own row.
 */
export function saveRefused(reply: ConnectorInfo, sourceId: string, sent: NotionFields): boolean {
  const s = reply.sources?.find((x) => x.id === sourceId);
  return !!s && !s.error && !sameNotionFields(s.fields, sent);
}

/** The editor's columns: being read, there, or a read that ended without them ("Couldn't read the columns." + Retry). */
export function columnsView(s: SourceInfo, read: 'pending' | 'done'): 'reading' | 'ready' | 'failed' {
  return s.columns ? 'ready' : read === 'pending' ? 'reading' : 'failed';
}
