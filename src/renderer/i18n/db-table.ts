// A table tab's strings: the toolbar, the footer, the states, the bottom row.
// Loaded with the table's lazy chunk, like i18n/db.ts with the sidebar's (the live demo's first-paint budget). Same
// rules as en.ts: written for macOS, in Windows' words there.
import { currentPlatform } from '@shared/platform';
import { localize } from '@shared/windows-words';

const strings = {
  // A tab whose connection this window doesn't show.
  unavailable: 'This connection isn’t available here',
  unavailableBody: 'It belongs to another project, or it was removed.',
  crumbTip: (conn: string, schema: string, name: string) => (conn ? `${conn} / ${schema} / ${name}` : `${schema} / ${name}`),
  readOnly: 'Read-only',
  estimate: (n: string) => `~${n} rows`,
  estimateTip: 'An estimate from the table’s statistics',
  views: { data: 'Data', structure: 'Structure', relations: 'Relations' },
  viewsLabel: 'Table views',
  mask: 'Mask Values',
  maskTip: (on: boolean) => (on ? 'Mask values: on — secrets and personal data show as dots' : 'Mask values: off'),
  refresh: 'Refresh',
  updated: (ago: string) => `Refresh · Updated ${ago}`,
  sql: 'SQL',
  // What runs also cuts long values on the server; the popover shows the read itself.
  sqlTip: 'The read, as you would run it',
  sqlTitle: 'The statement',
  sqlNote: 'The read as you would run it, values inlined. Atelier sends them as parameters and gets values over 64 KB cut.',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Couldn’t copy',
  close: 'Close',
  // A narrow pane folds Mask, Refresh and SQL into "⋯"; the same menu on a right-click or Shift+F10 on the bar.
  fold: 'More Actions',
  menu: { mask: 'Mask Values', refresh: 'Refresh', showSql: 'Show SQL', copySql: 'Copy SQL', record: 'Record View', inspector: 'Row Inspector' },
  // The record view: one row, every column, in the rows' place — Tab on a row.
  record: {
    views: { grid: 'Grid', record: 'Record' },
    viewsLabel: 'Show the rows as',
    tips: { grid: 'Grid: the rows as a table', record: 'Record: one row, every column' },
    at: (n: number, of: number) => `Row ${n.toLocaleString('en-US')} of ${of.toLocaleString('en-US')} loaded`,
    body: (n: number) => `Row ${n.toLocaleString('en-US')}, every column`,
    // The columns the grid's chooser hides: read for this row by its key.
    hidden: 'Hidden from the grid'
  },
  // A connection the user disconnected this session: the tab doesn't connect it by itself.
  disconnected: {
    title: 'Disconnected',
    body: (conn: string) => `You disconnected ${conn} in this session.`,
    connect: 'Connect'
  },
  // The footer: "300 loaded of ~2,300".
  label: {
    none: 'No rows',
    one: '1 row',
    all: (n: string) => `all ${n} loaded`,
    loaded: (n: string) => `${n} loaded`,
    of: (n: string, total: string) => `${n} loaded of ${total}`
  },
  count: 'Count exactly',
  countTip: 'count(*) with these filters, within the query timeout',
  counting: 'Counting…',
  countFailed: (why: string) => `Couldn’t count: ${why}`,
  ms: (n: number) => `${n.toLocaleString('en-US')} ms`,
  scrollHint: 'More rows load as you scroll',
  // The states.
  loading: 'Loading rows…',
  empty: 'No rows',
  emptyFiltered: 'No rows match these filters',
  clearFilters: 'Clear Filters',
  // A JSON column main refuses: the tab gets out of it.
  clearDerived: 'Remove JSON Columns',
  tryAgain: 'Try Again',
  timeoutHint: 'Add a filter or sort by an indexed column.',
  sqlState: (code: string) => `SQLSTATE ${code}`,
  readFailed: 'Couldn’t read the table',
  // The grid's last row.
  more: {
    loading: 'Loading more rows…',
    retry: 'Retry',
    cap: '10,000 rows loaded. Add a filter or a sort to see others.',
    // The values budget.
    capBytes: (n: string) => `${n} rows loaded (64 MB of values). Add a filter or choose fewer columns to see others.`
  },
  ago: {
    now: 'just now',
    sec: (n: number) => `${n} s ago`,
    min: (n: number) => `${n} min ago`,
    hour: (n: number) => `${n} h ago`
  },
  // Structure and Relations.
  struct: {
    // The head: "table · owner app · “One row per checkout”" (the owner's name ellipsizes on its own).
    kindOwner: (kind: string) => `${kind} · owner`,
    kinds: { table: 'table', view: 'view', matview: 'materialized view' },
    columns: 'Columns',
    indexes: 'Indexes',
    constraints: 'Constraints and triggers',
    partitions: 'Partitions',
    definition: 'Definition',
    th: { name: 'Name', type: 'Type', null: 'Null', default: 'Default', notes: 'Notes' },
    yes: 'yes',
    no: 'no',
    identity: 'identity',
    generated: 'generated',
    identityTip: 'An identity column: Postgres numbers its rows',
    generatedTip: (expr: string) => `Generated: ${expr}`,
    enumValues: (n: number) => `enum · ${n} value${n === 1 ? '' : 's'}`,
    check: (expr: string) => `check ${expr}`,
    generatedAs: (expr: string) => `generated ${expr}`,
    // `side`: the platform's ⌥-click (kbd).
    openTip: (table: string, side: string) => `Open ${table} · ${side} to the side`,
    badges: { PK: 'Primary key', FK: 'Foreign key', UNIQUE: 'Leads a unique index', IDX: 'Leads an index' } as Record<string, string>,
    methodTip: (method: string) => `Leads a ${method} index`,
    neverUsed: 'never used',
    neverUsedTip: 'No scans since the statistics were last reset: it slows every write and helps no read here (a replica counts its own)',
    scans: (n: string, raw: number) => `${n} scan${raw === 1 ? '' : 's'}`,
    noScans: 'This server keeps no statistics for it',
    partial: 'A partial index: only the rows this condition keeps',
    noIndexes: 'No indexes',
    noPk: 'No primary key',
    noPkTip: 'Without one, a row is named by a unique key if the table has one (the inspector, Load full value)',
    // Sizes come from the statistics: estimates, said so.
    estimate: (size: string) => `~${size}`,
    estimateTip: 'From the statistics, as of the last VACUUM or ANALYZE',
    partitionedIndex: 'Partitioned: the sizes are on its partitions',
    size: 'Size',
    sizeTip: 'From the statistics (pages × block size), as of the last VACUUM or ANALYZE: read without locking the table',
    parts: { table: 'Table', indexes: 'Indexes', toast: 'TOAST' },
    partTip: { table: 'The rows themselves', indexes: 'Every index of the table', toast: 'Values too large for a row, stored apart' },
    unmeasured: 'Not measured yet: ANALYZE fills it in',
    rows: 'Rows',
    dead: 'Dead rows',
    deadTip: (n: string) => `${n} dead rows: space VACUUM takes back`,
    analyzed: (ago: string) => `analyzed ${ago}`,
    neverAnalyzed: 'never analyzed',
    vacuumed: (ago: string) => `vacuumed ${ago}`,
    neverVacuumed: 'never vacuumed',
    days: (n: number) => `${n} d ago`,
    relations: 'Relations',
    openDiagram: 'Open diagram ›',
    noRelations: 'No foreign keys point to or from this table.',
    viewNoRelations: 'Views have no foreign keys.',
    references: 'References',
    referencesTip: 'The tables this one points to (each of its rows to one of theirs)',
    referencedBy: 'Referenced by',
    referencedByTip: 'The tables pointing at this one (many of their rows to one of these)',
    nodeTip: (label: string, keys: string) => `Open ${label} · ${keys}`,
    fkLine: (from: string, cols: string, to: string, toCols: string) => `${from}.${cols} → ${to}.${toCols}`,
    noIndex: 'no index on it',
    self: (cols: string) => `Points at itself: ${cols}`,
    many: 'N',
    ddl: 'DDL',
    ddlNote: 'A readable approximation: storage options, tablespaces and privileges are left out.',
    copy: 'Copy',
    copyTip: 'Copy the DDL',
    sendSchema: (session: string) => `Send Schema to ${session}`,
    // No session to send to: Redis's menu item's words; the press says why, with a Copy.
    sendSchemaNone: 'Send Schema to Session',
    sendSchemaTip: (session: string) => `Send Schema to ${session}: the DDL and the relations, typed into its prompt`,
    failed: { structure: 'Couldn’t read the structure', relations: 'Couldn’t read the relations', ddl: 'Couldn’t read the DDL' },
    retry: 'Retry',
    diagramLabel: (table: string) => `Relations of ${table}`
  },
  fail: { mask: 'Couldn’t change Mask values' },
  // Claude: the grid's action bar, the sends, a new session's name and its toast — Redis's
  // and Docker's words where they have them.
  claude: {
    rows: (n: number) => (n === 1 ? '1 row' : `${n.toLocaleString('en-US')} rows`),
    sendTo: (session: string) => `Send to ${session}`,
    sendNone: 'Send to a session',
    sendTip: (session: string) => `Send to ${session}: typed into its prompt, not sent`,
    askNew: 'Ask in New Session',
    copyJson: 'Copy as JSON',
    formats: 'Copy as…',
    formatsTip: 'Copy as JSON, CSV, Markdown or SQL INSERT',
    clear: 'Clear selection',
    sessionName: (what: string) => `db: ${what}`,
    typed: (what: string) => `The ${what} context is in the prompt. Review it and press Enter to send.`,
    // No silent path: a send with nothing loaded, a row over the 512 KB cap (a Copy beside it).
    nothing: 'Nothing loaded to send',
    tooLarge: (size: string) => `This row is too large to send (${size}) — Copy it instead`,
    ddlFailed: (table: string, why: string) => `Couldn’t read the DDL of ${table}: ${why}`,
    ddlSkipped: (table: string, why: string) => `Couldn’t read the DDL of ${table} (${why}): the rows went without it`,
    relSkipped: (table: string, why: string) => `Couldn’t read the relations of ${table} (${why}): the DDL went without them`
  },
  // The grid.
  grid: {
    label: (table: string) => `Rows of ${table}`,
    empty: 'empty',
    spaces: (n: number) => `${n} space${n === 1 ? '' : 's'}`,
    // A value main cut at 64 KB: the inspector's Load full value reads the rest.
    cutTip: (total: string) => `Showing 64 KB of ${total}`,
    // Copy Value reads a cut value whole by the row's key: main's own words when there is none.
    noKey: 'No key to read the whole value',
    cutInCopy: (n: number) => (n === 1 ? '1 value was cut at 64 KB in this copy' : `${n.toLocaleString('en-US')} values were cut at 64 KB in this copy`),
    resizeTip: 'Drag to resize · Double-click to fit',
    menu: {
      copyValue: 'Copy Value',
      copyRow: 'Copy Row as JSON',
      copyAs: (n: number) => (n > 1 ? `Copy ${n.toLocaleString('en-US')} Rows As` : 'Copy Row As'),
      formats: { json: 'JSON', csv: 'CSV', markdown: 'Markdown', insert: 'SQL INSERT', tsv: 'TSV' },
      filterBy: 'Filter by This Value',
      exclude: 'Exclude This Value',
      openRef: 'Open Referenced Row',
      openJson: 'Open in JSON View',
      sendTo: (session: string) => `Send to ${session}`,
      sendNone: 'Send to Session',
      askNew: 'Ask in a New Session',
      columnMenu: 'Column Menu…',
      wrap: 'Wrap Cells'
    },
    copied: 'Copied',
    copiedRows: (n: number, format: string) => `Copied ${n === 1 ? '1 row' : `${n.toLocaleString('en-US')} rows`} as ${format}`
  },
  // The filter bar and its popover: chips "column · operator · value", "+ Filter".
  filters: {
    label: 'Filters',
    add: 'Filter',
    addTip: 'Add a filter',
    addTitle: 'Add a filter',
    editTitle: 'Edit filter',
    full: (n: number) => `${n} filters at most`,
    waiting: 'The columns show once the rows are read',
    // A chip pressed before the table's columns are known: nothing opens.
    notYet: 'Columns load with the table — try again once it has loaded',
    more: (n: number) => `+${n} more`,
    moreTip: 'The other filters',
    editChip: (text: string) => `Edit filter: ${text}`,
    removeChip: (text: string) => `Remove filter: ${text}`,
    menu: { edit: 'Edit Filter…', remove: 'Remove Filter', clearAll: 'Clear All Filters' },
    // Opened on a key over the tab's own filters: Undo brings them back, with the sort and the columns.
    replaced: 'Filters replaced',
    undo: 'Undo',
    // The tab moved on since (or closed): Undo would change what the user did after.
    nothingToUndo: 'Nothing to undo',
    inTheLast: 'in the last',
    lastN: (n: string, unit: 'days' | 'hours') => `${n} ${unit === 'days' ? (n === '1' ? 'day' : 'days') : n === '1' ? 'hour' : 'hours'}`,
    // An empty string as a value (rows whose value is "", not NULL).
    emptyValue: '""',
    findColumn: 'Find a column',
    noColumn: 'No column matches',
    jsonPath: 'json path',
    columnsLabel: 'Columns',
    back: 'Choose another column',
    op: 'Operator',
    is: 'is',
    value: 'Value',
    from: 'From',
    to: 'To',
    path: 'Path',
    pathHint: 'data.object.status',
    valueHint: 'Value',
    numberHint: '0',
    timeHint: '2026-11-04 or 2026-11-04 18:30',
    unit: { days: 'days', hours: 'hours' },
    picks: 'Quick picks',
    // Mask values on, an existing filter on a masked column: its choice isn't shown.
    maskedHint: 'Values are masked: turn Mask values off to see them',
    // A filter on a column the table no longer has.
    goneColumn: 'This column isn’t in the table anymore',
    // An enum value the type no longer has.
    staleValue: (v: string) => `${v} (not in the type anymore)`,
    addValue: 'Add a value',
    addValueTip: 'Enter adds it',
    findValue: 'Find a value',
    removeValue: (v: string) => `Remove ${v}`,
    apply: 'Apply',
    cancel: 'Cancel',
    remove: 'Remove',
    err: {
      value: 'Type a value',
      number: 'Type a number',
      integer: 'Type a whole number',
      time: 'Type a date, like 2026-11-04 or 2026-11-04 18:30',
      stale: 'A chosen value isn’t in the type anymore: uncheck it',
      range: 'From 1 to 100,000',
      none: 'Choose at least one value',
      many: (n: number) => `At most ${n.toLocaleString('en-US')} values`,
      long: (n: number) => `At most ${n.toLocaleString('en-US')} characters`,
      nul: 'A value can’t hold a NUL character',
      path: 'Type a path, like data.object.status',
      badPath: 'Not a path: keys joined by dots, [0] for an array item',
      pathLong: (n: number) => `A path holds at most ${n} keys`,
      keyLong: (n: number) => `A key holds at most ${n} characters`,
      keyNul: 'A key can’t hold a NUL character',
      index: (n: string) => `An index goes up to ${n}`,
      fit: (column: string) => `This filter doesn’t fit ${column}`
    }
  },
  // The row inspector.
  insp: {
    label: 'Row inspector',
    row: 'Row',
    // A table without a primary key: the row's place among those loaded.
    rowAt: (n: number) => `#${n.toLocaleString('en-US')}`,
    views: { fields: 'Fields', json: 'JSON' },
    viewsLabel: 'Show the row as',
    prev: 'Previous Row',
    next: 'Next Row',
    close: 'Close Inspector',
    resize: 'Inspector width',
    resizeTip: 'Drag to resize · Double-click for the default width',
    none: 'Select a row to see its fields',
    primary: 'primary key',
    more: (n: number) => `${n.toLocaleString('en-US')} more ${n === 1 ? 'field' : 'fields'}`,
    moreTip: (open: boolean) => (open ? 'Hide the other fields' : 'Show the fields hidden from the grid'),
    // The hidden fields are read for this row only, by its primary key.
    reading: 'Reading…',
    noKeyMore: 'No key to read these fields',
    // The hidden fields' read found no row by its key.
    gone: 'This row no longer exists',
    failed: (why: string) => `Couldn’t read: ${why}`,
    retry: 'Retry',
    notRead: 'not read',
    // A value main cut at 64 KB.
    cut: (shown: string, total: string) => `Showing ${shown} of ${total}`,
    loadFull: 'Load full value',
    loadingFull: 'Loading…',
    noKey: 'No key to read the whole value',
    // A value too long to lay out whole: its start (the cell's Copy Value copies all of it).
    clipped: (shown: string) => `Showing the first ${shown} · the cell’s Copy Value copies all of it`,
    copyJson: 'Copy JSON',
    copied: 'Copied',
    copyFailed: 'Couldn’t copy',
    items: (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'item' : 'items'}`,
    unixTime: (n: string) => `unix ${n}`,
    utc: (s: string) => `${s} UTC`,
    // The FK peek card: the referenced row, Open › (a preview of that table filtered on the key).
    peek: {
      open: 'Open ›',
      openTip: (table: string) => `Open ${table} filtered on this row`,
      cantOpen: 'No filter can name this key',
      none: (table: string) => `No row of ${table} has this key`,
      failed: (table: string) => `Couldn’t read ${table}`,
      since: (date: string) => `since ${date}`,
      reading: (table: string) => `Reading ${table}…`
    },
    // Referenced by: each foreign key pointing at this table, its count for this row.
    refs: {
      title: 'Referenced by',
      none: 'none',
      one: '1 row',
      many: (n: string) => `${n} rows`,
      capped: '1,000+ rows',
      open: 'Open ›',
      openTip: (table: string) => `Open ${table} filtered on this row`,
      counting: 'Counting…',
      // This row's value for that key is too long to send: that key alone isn't counted.
      tooLong: 'Can’t count: value too long',
      failed: 'Couldn’t count what points at this row',
      why: {
        'no-index': 'Not counted: no index finds these rows',
        slow: 'Not counted: the count took too long',
        denied: 'Not counted: this role can’t read that table'
      }
    }
  },
  // The JSON tools: the JSON view in the inspector, the column menu with its key profile.
  json: {
    label: 'JSON view',
    back: 'Back to Fields',
    close: 'Close Inspector',
    open: 'Open in JSON View',
    views: { tree: 'Tree', table: 'Table', raw: 'Raw' },
    viewsLabel: 'Show the value as',
    tableNone: 'Table needs an array of objects',
    tableMasked: 'Values are masked: turn Mask values off to see this table',
    // A json column keeps what was stored: a key repeated.
    duplicates: 'Duplicate keys: the last one counts',
    rowAt: (row: string, size: string) => (row ? `row ${row} · ${size}` : size),
    find: 'Find a key or value',
    findLabel: 'Find in this value',
    hits: (at: number, n: number, capped: boolean) => (n === 0 ? 'No match' : `${at.toLocaleString('en-US')} of ${n.toLocaleString('en-US')}${capped ? '+' : ''}`),
    searching: 'Finding…',
    prevHit: 'Previous Match',
    nextHit: 'Next Match',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    crumbs: 'Path of the selected node',
    root: 'the whole value',
    treeLabel: (name: string) => `${name} as a tree`,
    items: (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'item' : 'items'}`,
    keys: (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'key' : 'keys'}`,
    more: (n: number) => `… ${n.toLocaleString('en-US')} more`,
    moreTip: 'Show more',
    unixHint: (t: string) => `${t} · unix time`,
    // A string holding JSON: parsed in place, losslessly, marked.
    parse: 'JSON in a string · Parse',
    parseTip: 'Read this string as JSON, in place',
    parsed: 'parsed',
    parsedTip: 'Parsed from a string · click to show the string again',
    notJson: 'This string isn’t whole JSON',
    linkTip: (url: string) => `Open ${url} in your browser`,
    fold: 'Collapse',
    unfold: 'Expand',
    // The hover actions on a node.
    act: {
      copy: 'Copy value',
      path: 'Copy path',
      sql: 'Copy SQL',
      filter: 'Filter rows where this equals this value',
      filterExists: 'Filter rows where this path exists',
      filterNull: 'Filter rows where this is JSON null',
      already: 'This filter is on already',
      column: 'Add as a column',
      columnShown: 'Already a column',
      noFilter: 'A filter can’t reach this value',
      noColumn: 'A column can’t read this value',
      inString: 'Inside a parsed string: a filter or a column can’t reach it',
      tooMany: 'This tab has 20 JSON columns already'
    },
    // A line's right-click menu (Shift+F10 on the tree): the same actions, as menu items.
    menu: {
      copy: 'Copy Value',
      path: 'Copy Path',
      sql: 'Copy SQL',
      filter: 'Filter by This Value',
      filterExists: 'Filter Where This Path Exists',
      column: 'Add as Column',
      openLink: 'Open Link',
      parse: 'Parse JSON in String',
      unparse: 'Show as String'
    },
    bar: { path: 'Path', sql: 'SQL', copyPath: 'Copy Path', copySql: 'Copy SQL' },
    copiedPath: 'Path copied',
    copiedSql: 'SQL copied',
    copiedValue: 'Value copied',
    columnAdded: (name: string) => `Column ${name} added`,
    raw: {
      copyAll: 'Copy all',
      cut: (shown: string) => `Showing the first ${shown} · Copy all copies the whole value`
    },
    // The value's states.
    reading: 'Reading the value…',
    nullValue: 'This row’s value is NULL',
    masked: 'Values are masked: turn Mask values off to read this one',
    notLoaded: 'This column isn’t in the rows loaded',
    notJsonValue: 'This value isn’t whole JSON',
    noRow: 'Select a row to see its value'
  },
  // The column menu: a header's chevron or right-click.
  colMenu: {
    label: (name: string) => `Column ${name}`,
    open: 'Column Menu',
    keysIn: (n: number) => `Keys in ${n === 1 ? 'this row' : `these ${n.toLocaleString('en-US')} rows`}`,
    keysFirst: (n: number) => `Keys in the first ${n.toLocaleString('en-US')} rows`,
    presentIn: 'present in',
    presentTip: (n: number, of: number) => `In ${n.toLocaleString('en-US')} of ${of.toLocaleString('en-US')} values`,
    noKeys: 'No object in these rows',
    maskedCol: 'Values are masked',
    kinds: { string: 'string', number: 'number', boolean: 'boolean', null: 'null', object: 'object', array: 'array', mixed: 'mixed', unix: 'unix time', masked: '••••' },
    add: '+ Column',
    shown: 'column ✓',
    sortAsc: 'Sort Ascending',
    sortDesc: 'Sort Descending',
    filter: 'Filter…',
    filterKey: 'Filter by Key…',
    sortKey: 'Sort by Key…',
    hide: 'Hide Column',
    remove: 'Remove Column',
    copyName: 'Copy Column Name',
    copyLines: 'Copy Column as JSON Lines',
    wrap: 'Wrap Cells',
    keyPath: 'Key',
    keyHint: 'data.object.status',
    asc: 'Ascending',
    desc: 'Descending',
    lastColumn: 'The only column shown can’t be hidden',
    copiedName: 'Column name copied',
    copiedLines: (n: number) => `Copied ${n.toLocaleString('en-US')} ${n === 1 ? 'line' : 'lines'} of JSON`
  },
  // The Columns chip: "9 of 12", a checklist; hidden columns aren't read.
  columns: {
    label: (shown: number, all: number) => (shown === all ? `${all} ${all === 1 ? 'column' : 'columns'}` : `${shown} of ${all}`),
    tip: 'Choose the columns to show',
    title: 'Columns',
    find: 'Find a column',
    showAll: 'Show All',
    keyTip: 'The row’s key: always read, hidden from view only',
    none: 'Choose at least one column',
    count: (shown: number, all: number) => `${shown} of ${all} shown`
  }
} as const;

/** Windows names its own places and tools. macOS: as written. */
export const tdt = currentPlatform() === 'win32' ? localize(strings) : strings;
