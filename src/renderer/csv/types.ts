// CSV viewer: the shapes shared by the parser, the profile, the table's view and the pane.

export type Delimiter = ',' | ';' | '\t' | '|';
export type Decimal = '.' | ',';

/** A file's parse options as the user set them: 'auto' takes what detection found. */
export interface CsvOptions { delimiter: Delimiter | 'auto'; header: boolean | 'auto'; decimal: Decimal | 'auto'; skip: number }
/** What detection found in the first 64 KB. */
export interface Detected { delimiter: Delimiter; header: boolean; decimal: Decimal }
/** The options a parse used: every 'auto' replaced. */
export interface Resolved { delimiter: Delimiter; header: boolean; decimal: Decimal; skip: number }

export const AUTO_OPTIONS: CsvOptions = { delimiter: 'auto', header: 'auto', decimal: 'auto', skip: 0 };

/**
 * A row whose field count differs from the header's (row: its index among the data rows), or an unclosed quote (the
 * row it starts; the rest of the file is that field). Lines are 1-based lines of the text.
 */
export type Problem = { kind: 'fields'; row: number; line: number; count: number } | { kind: 'quote'; row: number; line: number };

/** A parsed file. Rows are the data rows (header and skipped lines left out), values unquoted. */
export interface CsvData {
  /** The header row's fields; null when the first row is data. */
  header: string[] | null;
  /** The header row's line (null without one). */
  headerLine: number | null;
  rows: string[][];
  /** 1-based line where each data row starts, and where it ends (a quoted field can span lines). */
  lines: number[];
  endLines: number[];
  /** The most fields any row (header included) has: the table's column count. */
  width: number;
  /** The field count rows should have: the header's, or without one the most common. */
  expected: number;
  problems: Problem[];
}

export type ColType = 'empty' | 'text' | 'category' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'json';

export interface TopValue { value: string; count: number }

/** What a column holds (computed once per parse, in the worker). */
export interface ColumnProfile {
  index: number;
  /** A, B, … AA. */
  letter: string;
  /** The header's text ('' without a header or when the header cell is empty). */
  name: string;
  type: ColType;
  /** Every non-empty value different (and more than one). */
  unique: boolean;
  /** Decimal columns: the number of decimals when every value has the same, else null. */
  places: number | null;
  /** Non-empty values, empty cells (a missing field counts as empty), distinct non-empty values. */
  count: number;
  empty: number;
  distinct: number;
  /** Numbers (and dates as epoch ms): null for other types or no values. */
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
  /** Numbers and dates: 12 equal-width bins between min and max; null otherwise. */
  bins: number[] | null;
  /** Values by count (ties by first appearance), at most 500; empty when the column has more distinct values. */
  top: TopValue[];
  /** A category of short upper-case codes (IT, DE): neutral chips instead of tinted pills. */
  codes: boolean;
  /** A non-negative number column that isn't an id: cells get a bar proportional to max. */
  bars: boolean;
  /** The table's column width in px (64–340). */
  width: number;
  /** Align columns: the widest raw field in characters (quotes included), at most 40. */
  rawWidth: number;
  /** A column beyond the header (only rows with too many fields have it). */
  extra: boolean;
}

export interface Sort { col: number; dir: 'asc' | 'desc' }
/** A column filter: keep rows whose value is in `values` ('in') or not in it ('out'). */
export interface ValueFilter { col: number; mode: 'in' | 'out'; values: string[] }
/** columns: the shown columns, the only ones the query looks at (all when absent). */
export interface ViewQuery { query: string; filters: ValueFilter[]; problemsOnly: boolean; sort: Sort[]; columns?: number[] }

/** A rectangle of the table: display row positions and visible column positions, inclusive, normalized. */
export interface CellRange { r0: number; c0: number; r1: number; c1: number }
