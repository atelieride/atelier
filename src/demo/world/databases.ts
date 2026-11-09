// The acme-store's Postgres: the database behind the live demo's Databases
// view, as pure data — a function of "now", like the Redis keyspace — and the source the site's shot loads into a real
// Postgres (CREATE TYPE, each relation's `ddl` in order, the function, then its rows). Every value is text as Postgres
// prints it (NULL as null), every structure fact as the catalog reads it (format_type, pg_get_indexdef,
// pg_get_constraintdef, pg_get_viewdef, pg_get_functiondef), and the DDL as Atelier rebuilds it: static text, never
// built from a request. Deterministic: a seeded generator, times at fixed offsets from now (whole seconds).
//
// The same world as the rest of the demo: the customers whose sessions, receipts and welcome mails the Redis view holds
// (4021 Marco Rossi, 4022 Giulia Verdi, Luca Bianchi), the products of its cache and leaderboard (8812 the black mug…),
// and the orders of its stream (10442 paid 54.00 seconds ago, 10441 failed, 10437 shipped).

export type PgText = string | null;
/** A JSON value; integers past 2^53 as bigint, so they print digit for digit. */
export type Json = null | boolean | number | bigint | string | Json[] | { [key: string]: Json };

export interface PgColumn {
  name: string;
  /** format_type(): what the grid's header and the DDL say. */
  type: string;
  /** The type casts name (DbColumn): the element's for an array. */
  typeSchema: string;
  typeName: string;
  typeCat: string;
  isArray?: true;
  enumValues?: readonly string[];
  nullable: boolean;
  /** pg_get_expr of the default. */
  default?: string;
  /** attidentity: by default ('d') or always ('a'). */
  identity?: 'a' | 'd';
  comment?: string;
}
/** An index as Structure lists it; `columns`: its key columns (whether a foreign key is indexed); `byConstraint`: made by a primary key or unique constraint (the DDL leaves it out). */
export interface PgIndex { name: string; columns: readonly string[]; def: string; method: string; unique: boolean; primary: boolean; partial: string | null; byConstraint: boolean; bytes: number; scans: number }
/** `column`: a CHECK on one column (Structure shows it on that column). */
export interface PgConstraint { name: string; kind: 'p' | 'f' | 'u' | 'c'; def: string; column?: string }
export interface PgForeignKey { name: string; columns: readonly string[]; to: { schema: string; table: string; columns: readonly string[] } }
export interface PgRelation {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  owner: string;
  comment: string | null;
  columns: PgColumn[];
  /** [] for a view. */
  pk: readonly string[];
  /** Unique keys whose columns are all NOT NULL (beyond the primary key). */
  uniqueKeys: readonly (readonly string[])[];
  fks: PgForeignKey[];
  indexes: PgIndex[];
  constraints: PgConstraint[];
  /** Bytes from relpages (indexes: the sum of the index list's). */
  size: { table: number; indexes: number; toast: number };
  /** ISO times; null for a view. */
  stats: { dead: number | null; lastAnalyze: string | null; lastVacuum: string | null };
  viewDef: string | null;
  ddl: string;
  /** One text per column, in column order; a view's are its query's rows, in scan order. */
  rows: PgText[][];
}
export interface PgEnumType { schema: string; name: string; values: readonly string[] }
/** `args`: the identity arguments as the sidebar lists them (oidvectortypes). */
export interface PgFunction { schema: string; name: string; args: string; returns: string; oid: number; def: string }
/** A session the overview's "Now running" lists. */
export interface PgSession { pid: number; role: string; app: string }
export interface AcmeOverview {
  /** pg_postmaster_start_time as seconds before now: the Docker world's postgres (world/docker.ts, up 3 h 14 min). */
  uptimeSec: number;
  sizeBytes: number;
  maxConnections: number;
  cacheHit: number;
  /** xact_commit + xact_rollback now. */
  xacts: number;
  extensions: { name: string; version: string }[];
  /** pg_stat_statements' top five by mean time. */
  slowest: { query: string; calls: number; meanMs: number }[];
  /** Atelier's own session (the overview's read). */
  ours: PgSession & { query: string };
  /** The api's connection pool: idle mostly, a statement now and then. */
  pool: PgSession & { pids: readonly number[]; queries: readonly string[] };
  /** The reporting job: one long query, then a rest, again. */
  report: PgSession & { query: string; activeSec: number; idleSec: number; startSec: number };
}
export interface AcmeDatabase {
  /** In creation order (public first). */
  schemas: string[];
  enums: PgEnumType[];
  /** In creation order: a relation comes after those it references. */
  relations: PgRelation[];
  functions: PgFunction[];
  /** Copy SQL for a Read-only Role, for this server (16: pg_read_all_data). */
  readOnlyRoleSql: string;
  overview: AcmeOverview;
}

/**
 * Where the saved connection (world/databases-conn.ts) points: the compose project's postgres (world/docker.ts, the
 * database and user its DATABASE_URL names), added by hand for this project; and the server it reaches, the container's
 * PostgreSQL 16.4. The role reads as one that can only read — a demo simplification (the api writes with it): no write
 * note. The overview's other sessions (the api's pool, the reporting job) are `acme_app`.
 */
export const ACME_SOURCE = { kind: 'docker', container: 'acme-store-postgres-1', service: 'postgres' } as const;
export const ACME_SERVER = { version: '16.4', versionNum: 160004, tls: false, canWrite: false } as const;
/** The server's databases the role may connect to (the database chip), as main lists them: by name. */
export const ACME_DATABASES: readonly string[] = ['acme', 'postgres'];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OWNER = 'postgres';

// ── Text as Postgres prints it ─────────────────────────────────────────────────────────────────────────────────────

/** A timestamptz in UTC (the container's TimeZone): whole seconds, or microseconds when it has them. */
function ts(ms: number, micros = 0): string {
  const iso = new Date(ms).toISOString();
  const frac = String((ms % 1000) * 1000 + micros).padStart(6, '0').replace(/0+$/, '');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${frac ? `.${frac}` : ''}+00`;
}
const cents = (c: number): string => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const unix = (ms: number): number => Math.floor(ms / 1000);
const textArray = (items: readonly string[] | null): PgText => (items === null ? null : `{${items.join(',')}}`);
const bool = (b: boolean): string => (b ? 't' : 'f');

const utf8 = new TextEncoder();
const byKey = (a: string, b: string): number => {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

/** A value as jsonb prints it: keys shorter first, then by their bytes; ", " and ": " between items. */
export function jsonbText(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`world JSON numbers are safe integers (bigint past 2^53): ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(', ')}]`;
  return `{${Object.keys(v).sort(byKey).map((k) => `${JSON.stringify(k)}: ${jsonbText(v[k]!)}`).join(', ')}}`;
}

/** mulberry32: the same varied data on every run. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Types and columns ──────────────────────────────────────────────────────────────────────────────────────────────

type Ty = Pick<PgColumn, 'type' | 'typeSchema' | 'typeName' | 'typeCat' | 'isArray' | 'enumValues'>;
const ty = (type: string, typeName: string, typeCat: string, array = false): Ty => ({ type, typeSchema: 'pg_catalog', typeName, typeCat, ...(array ? { isArray: true as const } : {}) });
const BIGINT = ty('bigint', 'int8', 'N');
const INTEGER = ty('integer', 'int4', 'N');
const TEXT = ty('text', 'text', 'S');
const BOOLEAN = ty('boolean', 'bool', 'B');
const PRICE = ty('numeric(10,2)', 'numeric', 'N');
const AMOUNT = ty('numeric(12,2)', 'numeric', 'N');
const CHAR3 = ty('character(3)', 'bpchar', 'S');
const TSTZ = ty('timestamp with time zone', 'timestamptz', 'D');
const DATE = ty('date', 'date', 'D');
const JSONB = ty('jsonb', 'jsonb', 'U');
const TEXTS = ty('text[]', 'text', 'S', true);
export const ORDER_STATUS = ['pending', 'paid', 'shipped', 'refunded', 'failed'] as const;
type Status = (typeof ORDER_STATUS)[number];
const STATUS: Ty = { type: 'order_status', typeSchema: 'public', typeName: 'order_status', typeCat: 'E', enumValues: ORDER_STATUS };

type ColOpts = { null?: true; default?: string; identity?: 'a' | 'd'; comment?: string };
const col = (name: string, t: Ty, o: ColOpts = {}): PgColumn => ({
  name, ...t, nullable: o.null === true,
  ...(o.default !== undefined ? { default: o.default } : {}), ...(o.identity ? { identity: o.identity } : {}), ...(o.comment ? { comment: o.comment } : {})
});
const ID: ColOpts = { identity: 'd' };
const NOW_DEFAULT: ColOpts = { default: 'now()' };

type IndexSpec = Omit<PgIndex, 'unique' | 'primary' | 'partial' | 'byConstraint' | 'method'> & Partial<Pick<PgIndex, 'unique' | 'primary' | 'partial' | 'byConstraint' | 'method'>>;
const index = (i: IndexSpec): PgIndex => ({ method: 'btree', unique: false, primary: false, partial: null, byConstraint: false, ...i });
/** The primary key's index: pg_get_indexdef of `<table>_pkey`. */
const pkey = (schema: string, table: string, columns: string[], bytes: number, scans: number): PgIndex =>
  index({ name: `${table}_pkey`, columns, def: `CREATE UNIQUE INDEX ${table}_pkey ON ${schema}.${table} USING btree (${columns.join(', ')})`, unique: true, primary: true, byConstraint: true, bytes, scans });

type RelSpec = Omit<PgRelation, 'owner' | 'size' | 'uniqueKeys' | 'fks' | 'viewDef' | 'kind'> & {
  kind?: PgRelation['kind'];
  uniqueKeys?: PgRelation['uniqueKeys'];
  fks?: PgForeignKey[];
  viewDef?: string;
  size: { table: number; toast: number };
};
const relation = (r: RelSpec): PgRelation => ({
  kind: 'table', uniqueKeys: [], fks: [], viewDef: null, ...r, owner: OWNER,
  size: { table: r.size.table, indexes: r.indexes.reduce((s, i) => s + i.bytes, 0), toast: r.size.toast }
});

// ── The people and the catalogue ───────────────────────────────────────────────────────────────────────────────────

/** Customers 4001–4048: first name, last name, locale. 4019, 4021 and 4022 are the Redis world's. */
const PEOPLE: [string, string, string][] = [
  ['Elena', 'Conti', 'it-IT'], ['Tobias', 'Berg', 'de-DE'], ['Sara', 'Gallo', 'it-IT'], ['Jonas', 'Keller', 'de-DE'],
  ['Chiara', 'Fontana', 'it-IT'], ['Pierre', 'Lefèvre', 'fr-FR'], ['Anna', 'Lindholm', 'sv-SE'], ['Matteo', 'Ferrari', 'it-IT'],
  ['Lucia', 'Marino', 'it-IT'], ['Daniel', 'Novak', 'en-GB'], ['Federica', 'Greco', 'it-IT'], ['Oliver', 'Brandt', 'de-DE'],
  ['Martina', 'Romano', 'it-IT'], ['Hugo', 'Laurent', 'fr-FR'], ['Alessia', 'Colombo', 'it-IT'], ['Nils', 'Eriksen', 'sv-SE'],
  ['Paola', 'Ricci', 'it-IT'], ['Samuel', 'Weiss', 'de-DE'], ['Luca', 'Bianchi', 'it-IT'], ['Inès', 'Moreau', 'fr-FR'],
  ['Marco', 'Rossi', 'it-IT'], ['Giulia', 'Verdi', 'en-GB'], ['Davide', 'Moretti', 'it-IT'], ['Lena', 'Fischer', 'de-DE'],
  ['Simone', 'Barbieri', 'it-IT'], ['Clara', 'Jensen', 'en-GB'], ['Andrea', 'Lombardi', 'it-IT'], ['Emma', 'Schulz', 'de-DE'],
  ['Francesca', 'Rinaldi', 'it-IT'], ['Mateo', 'García', 'es-ES'], ['Valentina', 'Caruso', 'it-IT'], ['Felix', 'Wagner', 'de-DE'],
  ['Roberta', 'Ferri', 'it-IT'], ['Noah', 'Peeters', 'nl-NL'], ['Silvia', 'Galli', 'it-IT'], ['Ana', 'Costa', 'pt-PT'],
  ['Stefano', 'Mancini', 'it-IT'], ['Freya', 'Halvorsen', 'en-GB'], ['Beatrice', 'Leone', 'it-IT'], ['Arjun', 'Mehta', 'en-GB'],
  ['Giorgia', 'Longo', 'it-IT'], ['Kenji', 'Watanabe', 'ja-JP'], ['Alberto', 'Gentile', 'it-IT'], ['Maya', 'Cohen', 'en-US'],
  ['Irene', 'Martinelli', 'it-IT'], ['Liam', "O'Connor", 'en-GB'], ['Sofia', 'Vitale', 'it-IT'], ['Erik', 'Lund', 'sv-SE']
];
const FIRST_CUSTOMER = 4001;
const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** id, sku, name, price (cents), stock, tags, active, how often it sells. */
const PRODUCTS: [number, string, string, number, number, string[], boolean, number][] = [
  [2207, 'TEA-ROOIBOS-100', 'Rooibos, 100 g', 990, 0, ['tea'], false, 0],
  [3305, 'GIFT-CARD-50', 'Gift card, 50 €', 5000, 999, ['gift'], true, 2],
  [4410, 'TRAY-BAMBOO', 'Bamboo tray', 3200, 23, ['kitchen', 'gift'], true, 6],
  [5120, 'CUP-GLASS-2', 'Glass cups, set of 2', 1890, 64, ['kitchen'], true, 7],
  [6021, 'TEA-GENMAI-100', 'Genmaicha, 100 g', 1150, 41, ['tea'], true, 4],
  [7004, 'TEA-EARLGREY-100', 'Earl grey, 100 g', 1290, 88, ['tea'], true, 5],
  [7731, 'TEAPOT-IRON-08', 'Cast iron teapot, 0.8 l', 6900, 11, ['kitchen', 'gift'], true, 10],
  [8812, 'MUG-CERAMIC-BLK', 'Ceramic mug, black', 1800, 37, ['kitchen', 'gift'], true, 12],
  [8813, 'MUG-CERAMIC-WHT', 'Ceramic mug, white', 1800, 52, ['kitchen'], true, 9],
  [8814, 'TEA-SENCHA-100', 'Sencha tea, 100 g', 1250, 0, ['tea'], true, 5],
  [9002, 'KETTLE-GOOSENECK', 'Gooseneck kettle', 8900, 7, ['kitchen'], true, 6]
];
const COUPONS: Record<string, number> = { AUTUMN10: 10, WELCOME5: 5 };
const ORDER_TAGS = ['gift-wrap', 'priority', 'first-order', 'b2b', 'eu', 'vip'];
const NOTES = [
  'Gift wrap please, and leave it with the concierge if nobody answers.',
  'Ring twice.',
  'Invoice to the company, VAT number on file.',
  'Customer called: deliver after 5 pm.',
  'Fragile: glassware.'
];
const FIRST_ORDER = 10_103;
const LAST_ORDER = 10_442;
/**
 * The Redis world's orders: its stream (created 10441/10442, failed 10441, paid 10442, shipped 10437) and failed
 * receipts. `charged: false`: the checkout failed before the payment provider was asked (no payment, no webhook);
 * `shippedAgo`: when the carrier's event came.
 */
const SCRIPTED: Record<number, { customer: number; status: Status; ago: number; lines: [number, number][]; paidAfter?: number; cart?: string; charged?: false; shippedAgo?: number }> = {
  10437: { customer: 4007, status: 'shipped', ago: 2 * DAY + 3 * HOUR, lines: [[7731, 1], [8814, 2]], shippedAgo: 300 * SECOND },
  10438: { customer: 4031, status: 'paid', ago: 5 * HOUR + 12 * MINUTE, lines: [[5120, 1]] },
  10439: { customer: 4019, status: 'paid', ago: 52 * MINUTE, lines: [[9002, 1], [7004, 2]] },
  10440: { customer: 4013, status: 'pending', ago: 9 * MINUTE, lines: [[4410, 1]] },
  // order.failed with reason jwt_expired: the session's token had expired at checkout.
  10441: { customer: 4022, status: 'failed', ago: 160 * SECOND, lines: [[8813, 2]], charged: false },
  10442: { customer: 4021, status: 'paid', ago: 20 * SECOND, paidAfter: 4 * SECOND, lines: [[8812, 3]], cart: 'c_88a1' }
};
const charged = (order: number) => SCRIPTED[order]?.charged !== false;
/** The first of the Redis world's orders: the generated ones come before it. */
const FIRST_SCRIPTED = Math.min(...Object.keys(SCRIPTED).map(Number));
/** The first parcel's id, a Snowflake past 2^53: the JSON view shows it digit for digit. */
const PARCEL_ID = 1859302233645670401n;

// ── Static text: DDL, definitions ──────────────────────────────────────────────────────────────────────────────────

const DDL = {
  customers: `CREATE TABLE public.customers (
    id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    email text NOT NULL,
    full_name text NOT NULL,
    phone text,
    locale text DEFAULT 'it-IT'::text NOT NULL,
    marketing_opt_in boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customers_pkey PRIMARY KEY (id),
    CONSTRAINT customers_email_key UNIQUE (email)
);

COMMENT ON TABLE public.customers IS 'People with an account in the store';
COMMENT ON COLUMN public.customers.phone IS 'For the courier; optional';
`,
  products: `CREATE TABLE public.products (
    id bigint NOT NULL,
    sku text NOT NULL,
    name text NOT NULL,
    price numeric(10,2) NOT NULL,
    stock integer DEFAULT 0 NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT products_pkey PRIMARY KEY (id),
    CONSTRAINT products_sku_key UNIQUE (sku),
    CONSTRAINT products_price_check CHECK ((price >= (0)::numeric)),
    CONSTRAINT products_stock_check CHECK ((stock >= 0))
);

COMMENT ON TABLE public.products IS 'The catalogue: one row per SKU';
`,
  orders: `CREATE TABLE public.orders (
    id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    customer_id bigint NOT NULL,
    status order_status DEFAULT 'pending'::order_status NOT NULL,
    total numeric(10,2) NOT NULL,
    currency character(3) DEFAULT 'EUR'::bpchar NOT NULL,
    coupon text,
    tags text[],
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    CONSTRAINT orders_pkey PRIMARY KEY (id),
    CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id),
    CONSTRAINT orders_total_check CHECK ((total >= (0)::numeric))
);

CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at DESC);
CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);
CREATE INDEX orders_metadata_idx ON public.orders USING gin (metadata jsonb_path_ops);
CREATE INDEX orders_pending_idx ON public.orders USING btree (created_at) WHERE (status = 'pending'::order_status);

COMMENT ON TABLE public.orders IS 'One row per checkout';
COMMENT ON COLUMN public.orders.metadata IS 'Cart snapshot from the checkout';
COMMENT ON COLUMN public.orders.notes IS 'Shown on the packing slip';
`,
  order_items: `CREATE TABLE public.order_items (
    order_id bigint NOT NULL,
    line integer NOT NULL,
    product_id bigint NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    CONSTRAINT order_items_pkey PRIMARY KEY (order_id, line),
    CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0))
);

CREATE INDEX order_items_product_id_idx ON public.order_items USING btree (product_id);

COMMENT ON TABLE public.order_items IS 'The lines of each order, at the price paid';
`,
  payments: `CREATE TABLE public.payments (
    id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    order_id bigint NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    provider_ref text NOT NULL,
    amount numeric(10,2) NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payments_pkey PRIMARY KEY (id),
    CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT payments_provider_ref_key UNIQUE (provider_ref)
);

CREATE INDEX payments_order_id_idx ON public.payments USING btree (order_id);

COMMENT ON TABLE public.payments IS 'Charges at the payment provider, one per attempt';
`,
  webhook_events: `CREATE TABLE public.webhook_events (
    id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    source text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT webhook_events_pkey PRIMARY KEY (id)
);

CREATE INDEX webhook_events_received_at_idx ON public.webhook_events USING btree (received_at DESC);
CREATE INDEX webhook_events_type_idx ON public.webhook_events USING btree (type);

COMMENT ON TABLE public.webhook_events IS 'Webhooks from Stripe and the carrier, as they arrived';
COMMENT ON COLUMN public.webhook_events.payload IS 'The body as the sender posted it';
`,
  daily_revenue: `CREATE TABLE analytics.daily_revenue (
    day date NOT NULL,
    orders integer NOT NULL,
    revenue numeric(12,2) NOT NULL,
    refunds numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT daily_revenue_pkey PRIMARY KEY (day)
);

COMMENT ON TABLE analytics.daily_revenue IS 'Filled every night by the reporting job';
`
};

const PAID_ORDERS_DEF = ` SELECT o.id,
    o.customer_id,
    c.email,
    o.total,
    o.currency,
    o.paid_at
   FROM orders o
     JOIN customers c ON c.id = o.customer_id
  WHERE o.status = 'paid'::order_status;`;
const PAID_ORDERS_NOTE = 'Paid and not shipped yet: what the warehouse packs next';

const ORDER_TOTAL_DEF = `CREATE OR REPLACE FUNCTION public.order_total(order_id bigint)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(sum(quantity * unit_price), 0)
  from order_items
  where order_items.order_id = $1
$function$
`;

/** Main's readOnlyRoleSql('atelier_readonly', 160004), word for word (a test holds them together). */
const READ_ONLY_ROLE_SQL = `-- A role that can only read. Run this as a superuser (or a role with CREATEROLE),
-- then give it a password: in psql, \\password "atelier_readonly"
CREATE ROLE "atelier_readonly" LOGIN;
GRANT pg_read_all_data TO "atelier_readonly";
`;

const OVERVIEW: Omit<AcmeOverview, 'sizeBytes'> = {
  uptimeSec: (3 * 60 + 14) * 60,
  maxConnections: 100,
  cacheHit: 0.9987,
  xacts: 1_284_551,
  extensions: [{ name: 'pg_stat_statements', version: '1.10' }, { name: 'plpgsql', version: '1.0' }],
  slowest: [
    { query: "SELECT date_trunc($1, created_at) AS day, count(*), sum(total) FROM orders WHERE status IN ($2, $3) GROUP BY 1 ORDER BY 1", calls: 96, meanMs: 38.62 },
    { query: 'SELECT * FROM orders WHERE customer_id = $1', calls: 9310, meanMs: 12.41 },
    { query: 'SELECT o.id, o.total, o.paid_at, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = $1 ORDER BY o.created_at DESC LIMIT $2', calls: 18422, meanMs: 4.81 },
    { query: 'UPDATE products SET stock = stock - $1, updated_at = now() WHERE id = $2', calls: 2214, meanMs: 1.97 },
    { query: 'INSERT INTO webhook_events (source, type, payload) VALUES ($1, $2, $3) RETURNING id', calls: 1873, meanMs: 1.44 }
  ],
  ours: { pid: 4127, role: 'acme', app: 'atelier', query: 'WITH act AS (SELECT a.pid, a.usename, a.application_name, a.state, a.query FROM pg_catalog.pg_stat_activity a WHERE a.datname = pg_catalog.current_database()) SELECT pg_catalog.pg_database_size(pg_catalog.current_database()), (SELECT pg_catalog.count(*) FROM act), …' },
  pool: {
    pid: 61, role: 'acme_app', app: 'acme-api', pids: [61, 62, 63, 64],
    queries: [
      'SELECT * FROM orders WHERE customer_id = $1',
      'SELECT id, sku, name, price, stock FROM products WHERE id = ANY($1)',
      'INSERT INTO webhook_events (source, type, payload) VALUES ($1, $2, $3) RETURNING id',
      'COMMIT'
    ]
  },
  report: { pid: 88, role: 'acme_app', app: 'acme-reports', query: "SELECT date_trunc('day', created_at) AS day, count(*), sum(total) FROM orders WHERE status IN ('paid', 'shipped') GROUP BY 1 ORDER BY 1", activeSec: 44, idleSec: 16, startSec: 3 }
};

// ── The database ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Order {
  id: number; customer: number; status: Status; created: number; micros: number; lines: [number, number][]; coupon: string | null;
  subtotal: number; total: number; tags: string[] | null; notes: string | null; cart: string; source: string; paidAt: number | null; gift: boolean
}

/** The acme-store's database `now` (ms): its schemas, types, relations with their rows, the function, the overview's facts. */
export function acmeDatabase(nowMs: number): AcmeDatabase {
  const now = Math.floor(nowMs / SECOND) * SECOND;
  const rand = generator(0xacd0b);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const weighted = <T>(choices: readonly (readonly [T, number])[]): T => {
    let x = rand() * choices.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of choices) if ((x -= w) < 0) return v;
    return choices[choices.length - 1]![0];
  };
  const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789';
  const alnum = (n: number) => Array.from({ length: n }, () => ALNUM[int(0, ALNUM.length - 1)]).join('');
  const hex = (n: number) => Array.from({ length: n }, () => int(0, 15).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  // Customers.
  const customers = PEOPLE.map(([first, last, locale], i) => {
    const phone = locale === 'it-IT' ? `+39 3${int(20, 49)} ${int(100, 999)} ${int(1000, 9999)}`
      : locale === 'en-GB' ? `+44 7700 900${int(100, 999)}`
        : locale === 'de-DE' ? `+49 15${int(1, 9)} ${int(1_000_000, 9_999_999)}` : null;
    return {
      id: FIRST_CUSTOMER + i, email: `${ascii(first)[0]}.${ascii(last)}@example.com`, name: `${first} ${last}`, locale,
      phone: rand() < 0.7 ? phone : null, optIn: rand() < 0.4, created: now - int(20, 700) * DAY - int(0, 86_399) * SECOND
    };
  });
  const customerOf = new Map(customers.map((c) => [c.id, c]));

  // Products.
  const price = new Map(PRODUCTS.map((p) => [p[0], p[3]]));
  const sku = new Map(PRODUCTS.map((p) => [p[0], p[1]]));
  const selling = PRODUCTS.filter((p) => p[7] > 0).map((p) => [p[0], p[7]] as const);
  const productRows: PgText[][] = PRODUCTS.map(([id, s, name, p, stock, tags, active]) => [
    String(id), s, name, cents(p), String(stock), textArray(tags), bool(active), ts(now - int(1, 40) * DAY - int(0, 86_399) * SECOND)
  ]);

  // Orders: spread over the last 14 days, the newest six the Redis world's.
  const orders: Order[] = [];
  const firstAt = now - 14 * DAY;
  const lastGenerated = now - 6 * HOUR;
  const generated = FIRST_SCRIPTED - FIRST_ORDER;
  for (let id = FIRST_ORDER; id <= LAST_ORDER; id++) {
    const s = SCRIPTED[id];
    const k = id - FIRST_ORDER;
    const created = s ? now - s.ago - int(1, 999) : Math.round(firstAt + ((lastGenerated - firstAt) * (k + rand() * 0.6)) / generated);
    const recent = now - created < 3 * DAY;
    const status: Status = s ? s.status : recent
      ? weighted([['paid', 48], ['shipped', 28], ['pending', 10], ['failed', 8], ['refunded', 6]])
      : weighted([['shipped', 76], ['paid', 5], ['refunded', 7], ['failed', 6], ['pending', 1]]);
    let lines: [number, number][];
    if (s) lines = s.lines;
    else {
      lines = [];
      const n = weighted([[1, 8], [2, 6], [3, 3], [4, 1]]);
      for (let tries = 0; lines.length < n && tries < 12; tries++) {
        const p = weighted(selling);
        if (!lines.some(([q]) => q === p)) lines.push([p, weighted([[1, 7], [2, 2], [3, 1]])]);
      }
    }
    const subtotal = lines.reduce((sum, [p, q]) => sum + q * price.get(p)!, 0);
    const coupon = s ? null : weighted([[null, 82], ['AUTUMN10', 14], ['WELCOME5', 4]] as const);
    const total = subtotal - (coupon ? Math.round((subtotal * COUPONS[coupon]!) / 100) : 0);
    const paid = status === 'paid' || status === 'shipped' || status === 'refunded';
    orders.push({
      id, customer: s ? s.customer : FIRST_CUSTOMER + int(0, customers.length - 1), status, created, micros: int(0, 999), lines, coupon, subtotal, total,
      tags: s || rand() < 0.55 ? null : [...new Set([pick(ORDER_TAGS), ...(rand() < 0.3 ? [pick(ORDER_TAGS)] : [])])],
      notes: s || rand() > 0.1 ? null : pick(NOTES),
      cart: s?.cart ?? `c_${hex(8)}`,
      source: s ? 'checkout' : weighted([['checkout', 14], ['api', 4], ['pos', 2]]),
      paidAt: paid ? created + (s?.paidAfter ?? int(4, 240) * SECOND) : null,
      gift: !s && rand() < 0.15
    });
  }
  const metadata = (o: Order): Json => ({
    source: o.source,
    cart_id: o.cart,
    items: o.lines.map(([p, qty]) => ({ sku: sku.get(p)!, qty })),
    discount: o.coupon ? { code: o.coupon, percent: COUPONS[o.coupon]! } : null,
    gift: o.gift,
    ...(o.source === 'api' ? { client: { name: 'acme-ios', version: '3.8.1', build: 3810 } } : {})
  });
  const orderRows: PgText[][] = orders.map((o) => [
    String(o.id), String(o.customer), o.status, cents(o.total), 'EUR', o.coupon, textArray(o.tags), jsonbText(metadata(o)), o.notes,
    ts(o.created, o.micros), o.paidAt === null ? null : ts(o.paidAt, o.micros)
  ]);
  const itemRows: PgText[][] = orders.flatMap((o) => o.lines.map(([p, q], j) => [String(o.id), String(j + 1), String(p), String(q), cents(price.get(p)!)]));

  // Payments: one per order past checkout that reached the provider, by when they were made.
  const attempts = orders.filter((o) => o.status !== 'pending').map((o) => ({
    o, at: o.paidAt ?? o.created + int(20, 60) * SECOND, ref: `pi_3Q${alnum(19)}`,
    status: o.status === 'failed' ? 'failed' : o.status === 'refunded' ? 'refunded' : 'succeeded'
  }));
  const pays = attempts.filter((p) => charged(p.o.id)).sort((a, b) => a.at - b.at || a.o.id - b.o.id);
  const paymentRows: PgText[][] = pays.map((p, i) => [String(i + 1), String(p.o.id), 'stripe', p.ref, cents(p.o.total), p.status, ts(p.at)]);
  const payOf = new Map(attempts.map((p) => [p.o.id, p]));

  // Webhook events: the wholesale invoice (past 64 KB), then Stripe's and the carrier's for the last four days.
  const API_VERSION = '2025-09-30.clover';
  const request = (): Json => (rand() < 0.7 ? { id: `req_${alnum(14)}`, idempotency_key: uuid() } : { id: null, idempotency_key: null });
  const events: { source: string; type: string; payload: Json; at: number; processed: boolean }[] = [];
  events.push({ source: 'stripe', type: 'invoice.finalized', payload: bigInvoice(now - 9 * DAY), at: now - 9 * DAY + 5 * MINUTE, processed: true });
  const CARD = [['visa', '4242'], ['mastercard', '4444'], ['visa', '1881'], ['amex', '8431'], ['mastercard', '5100']] as const;
  let parcel = 0;
  for (const o of orders.filter((x) => now - x.created < 4 * DAY && x.status !== 'pending')) {
    // An order the provider never saw sends no webhook (its draws still happen: the rows after it stay as they are).
    const mark = events.length;
    const drop = () => { if (!charged(o.id)) events.length = mark; };
    const p = payOf.get(o.id)!;
    const c = customerOf.get(o.customer)!;
    const pi = p.ref;
    const ch = `ch_3Q${alnum(19)}`;
    const amount = o.total;
    const base = { object: 'event', livemode: false, api_version: API_VERSION, pending_webhooks: 1, request: request() };
    if (o.status === 'failed') {
      const [brand, last4] = pick(CARD);
      events.push({
        source: 'stripe', type: 'payment_intent.payment_failed', at: p.at + int(1, 3) * SECOND, processed: true,
        payload: {
          ...base, id: `evt_3Q${alnum(20)}`, type: 'payment_intent.payment_failed', created: unix(p.at),
          data: { object: {
            id: pi, object: 'payment_intent', amount, currency: 'eur', status: 'requires_payment_method', receipt_email: c.email,
            metadata: { order_id: String(o.id), cart_id: o.cart },
            last_payment_error: {
              type: 'card_error', code: 'card_declined', decline_code: pick(['insufficient_funds', 'do_not_honor', 'generic_decline']),
              message: 'Your card was declined.', payment_method: { type: 'card', card: { brand, last4 } }
            }
          } }
        }
      });
      drop();
      continue;
    }
    const [brand, last4] = pick(CARD);
    const wallet: Json = rand() < 0.3 ? { type: pick(['apple_pay', 'google_pay']), dynamic_last4: String(int(1000, 9999)) } : null;
    events.push({
      source: 'stripe', type: 'payment_intent.succeeded', at: p.at + int(1, 3) * SECOND, processed: true,
      payload: {
        ...base, id: `evt_3Q${alnum(20)}`, type: 'payment_intent.succeeded', created: unix(p.at),
        data: { object: {
          id: pi, object: 'payment_intent', amount, amount_received: amount, currency: 'eur', status: 'succeeded', customer: `cus_${alnum(14)}`,
          receipt_email: c.email, latest_charge: ch, payment_method_types: ['card'], metadata: { order_id: String(o.id), cart_id: o.cart },
          charges: { object: 'list', has_more: false, data: [{
            id: ch, paid: true, amount,
            outcome: { type: 'authorized', network_status: 'approved_by_network', risk_level: 'normal', risk_score: int(2, 60) },
            payment_method_details: { type: 'card', card: { brand, last4, exp_month: int(1, 12), exp_year: int(2027, 2031), country: c.locale.slice(3), wallet } }
          }] }
        } }
      }
    });
    if (o.status === 'refunded') {
      const at = p.at + int(2, 30) * HOUR;
      if (at < now) {
        events.push({
          source: 'stripe', type: 'charge.refunded', at, processed: true,
          payload: {
            ...base, id: `evt_3Q${alnum(20)}`, type: 'charge.refunded', created: unix(at),
            data: {
              object: {
                id: ch, object: 'charge', amount, amount_refunded: amount, refunded: true, currency: 'eur', payment_intent: pi, metadata: { order_id: String(o.id) },
                refunds: { object: 'list', has_more: false, data: [{ id: `re_3Q${alnum(19)}`, amount, reason: pick(['requested_by_customer', 'duplicate']), status: 'succeeded' }] }
              },
              previous_attributes: { amount_refunded: 0, refunded: false }
            }
          }
        });
      }
    }
    if (o.status === 'shipped') {
      // The Redis stream's order.shipped 10437 is the carrier's label, five minutes ago.
      const shippedAgo = SCRIPTED[o.id]?.shippedAgo;
      const later = Math.min(p.at + int(6, 30) * HOUR, now - 300 * SECOND);
      const at = shippedAgo !== undefined ? now - shippedAgo : later;
      const id = PARCEL_ID + BigInt(parcel++) * 4_194_304_007n;
      const carrier = pick(['GLS', 'DHL', 'BRT', 'UPS']);
      const label = rand() < 0.5 || shippedAgo !== undefined;
      events.push({
        source: 'carrier', type: label ? 'shipment.label_created' : 'tracking.updated', at, processed: true,
        payload: {
          event: label ? 'shipment.label_created' : 'tracking.updated', sent_at: unix(at), order_id: String(o.id),
          parcel: {
            id, carrier, service: 'standard', tracking_number: `${carrier}${int(10_000_000, 99_999_999)}IT`, weight_grams: int(300, 4200),
            dimensions_cm: [int(20, 40), int(15, 30), int(8, 20)], status: label ? 'label_created' : 'in_transit',
            checkpoints: label
              ? [{ at: unix(at), status: 'label_created', location: 'Milano, IT' }]
              : [{ at: unix(at - 5 * HOUR), status: 'picked_up', location: 'Milano, IT' }, { at: unix(at), status: 'in_transit', location: pick(['Bologna, IT', 'Verona, IT', 'Basel, CH']) }]
          }
        }
      });
    }
    drop();
  }
  events.sort((a, b) => a.at - b.at);
  // What arrived in the last minute is still being processed.
  for (const e of events) if (now - e.at < MINUTE) e.processed = false;
  const eventRows: PgText[][] = events.map((e, i) => [
    String(i + 1), e.source, e.type, jsonbText(e.payload), ts(e.at, (i * 7919) % 1000), e.processed ? ts(e.at + int(80, 900), (i * 104_729) % 1000) : null
  ]);

  // The view and the nightly table, from the orders.
  const paidRows: PgText[][] = orders.filter((o) => o.status === 'paid').map((o) => [
    String(o.id), String(o.customer), customerOf.get(o.customer)!.email, cents(o.total), 'EUR', ts(o.paidAt!, o.micros)
  ]);
  const today = Math.floor(now / DAY) * DAY;
  const dailyRows: PgText[][] = Array.from({ length: 14 }, (_, k) => {
    const day = today - (14 - k) * DAY;
    const of = orders.filter((o) => o.created >= day && o.created < day + DAY);
    const kept = of.filter((o) => o.status === 'paid' || o.status === 'shipped');
    const refunded = of.filter((o) => o.status === 'refunded');
    return [ts(day).slice(0, 10), String(kept.length + refunded.length), cents(kept.reduce((s, o) => s + o.total, 0)), cents(refunded.reduce((s, o) => s + o.total, 0))];
  });

  const analyzed = (hours: number) => new Date(now - hours * HOUR).toISOString();
  const relations: PgRelation[] = [
    relation({
      schema: 'public', name: 'customers', comment: 'People with an account in the store',
      columns: [
        col('id', BIGINT, ID), col('email', TEXT), col('full_name', TEXT), col('phone', TEXT, { null: true, comment: 'For the courier; optional' }),
        col('locale', TEXT, { default: "'it-IT'::text" }), col('marketing_opt_in', BOOLEAN, { default: 'false' }), col('created_at', TSTZ, NOW_DEFAULT)
      ],
      pk: ['id'], uniqueKeys: [['email']],
      indexes: [
        pkey('public', 'customers', ['id'], 16_384, 48_210),
        index({ name: 'customers_email_key', columns: ['email'], def: 'CREATE UNIQUE INDEX customers_email_key ON public.customers USING btree (email)', unique: true, byConstraint: true, bytes: 16_384, scans: 8840 })
      ],
      constraints: [{ name: 'customers_pkey', kind: 'p', def: 'PRIMARY KEY (id)' }, { name: 'customers_email_key', kind: 'u', def: 'UNIQUE (email)' }],
      size: { table: 16_384, toast: 0 }, stats: { dead: 2, lastAnalyze: analyzed(26), lastVacuum: analyzed(50) }, ddl: DDL.customers,
      rows: customers.map((c) => [String(c.id), c.email, c.name, c.phone, c.locale, bool(c.optIn), ts(c.created)])
    }),
    relation({
      schema: 'public', name: 'products', comment: 'The catalogue: one row per SKU',
      columns: [
        col('id', BIGINT), col('sku', TEXT), col('name', TEXT), col('price', PRICE), col('stock', INTEGER, { default: '0' }),
        col('tags', TEXTS, { default: "'{}'::text[]" }), col('active', BOOLEAN, { default: 'true' }), col('updated_at', TSTZ, NOW_DEFAULT)
      ],
      pk: ['id'], uniqueKeys: [['sku']],
      indexes: [
        pkey('public', 'products', ['id'], 16_384, 30_112),
        index({ name: 'products_sku_key', columns: ['sku'], def: 'CREATE UNIQUE INDEX products_sku_key ON public.products USING btree (sku)', unique: true, byConstraint: true, bytes: 16_384, scans: 512 })
      ],
      constraints: [
        { name: 'products_pkey', kind: 'p', def: 'PRIMARY KEY (id)' }, { name: 'products_sku_key', kind: 'u', def: 'UNIQUE (sku)' },
        { name: 'products_price_check', kind: 'c', def: 'CHECK ((price >= (0)::numeric))', column: 'price' }, { name: 'products_stock_check', kind: 'c', def: 'CHECK ((stock >= 0))', column: 'stock' }
      ],
      size: { table: 8192, toast: 0 }, stats: { dead: 14, lastAnalyze: analyzed(3), lastVacuum: analyzed(20) }, ddl: DDL.products, rows: productRows
    }),
    relation({
      schema: 'public', name: 'orders', comment: 'One row per checkout',
      columns: [
        col('id', BIGINT, ID), col('customer_id', BIGINT), col('status', STATUS, { default: "'pending'::order_status" }), col('total', PRICE),
        col('currency', CHAR3, { default: "'EUR'::bpchar" }), col('coupon', TEXT, { null: true }), col('tags', TEXTS, { null: true }),
        col('metadata', JSONB, { default: "'{}'::jsonb", comment: 'Cart snapshot from the checkout' }), col('notes', TEXT, { null: true, comment: 'Shown on the packing slip' }),
        col('created_at', TSTZ, NOW_DEFAULT), col('paid_at', TSTZ, { null: true })
      ],
      pk: ['id'], fks: [{ name: 'orders_customer_id_fkey', columns: ['customer_id'], to: { schema: 'public', table: 'customers', columns: ['id'] } }],
      indexes: [
        pkey('public', 'orders', ['id'], 24_576, 61_877),
        index({ name: 'orders_created_at_idx', columns: ['created_at'], def: 'CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at DESC)', bytes: 24_576, scans: 18_422 }),
        index({ name: 'orders_customer_id_idx', columns: ['customer_id'], def: 'CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id)', bytes: 16_384, scans: 9310 }),
        index({ name: 'orders_metadata_idx', columns: ['metadata'], def: 'CREATE INDEX orders_metadata_idx ON public.orders USING gin (metadata jsonb_path_ops)', method: 'gin', bytes: 73_728, scans: 37 }),
        index({ name: 'orders_pending_idx', columns: ['created_at'], def: "CREATE INDEX orders_pending_idx ON public.orders USING btree (created_at) WHERE (status = 'pending'::order_status)", partial: "(status = 'pending'::order_status)", bytes: 8192, scans: 1204 })
      ],
      constraints: [
        { name: 'orders_pkey', kind: 'p', def: 'PRIMARY KEY (id)' },
        { name: 'orders_customer_id_fkey', kind: 'f', def: 'FOREIGN KEY (customer_id) REFERENCES customers(id)' },
        { name: 'orders_total_check', kind: 'c', def: 'CHECK ((total >= (0)::numeric))', column: 'total' }
      ],
      size: { table: 106_496, toast: 8192 }, stats: { dead: 37, lastAnalyze: analyzed(2), lastVacuum: analyzed(19) }, ddl: DDL.orders, rows: orderRows
    }),
    relation({
      schema: 'public', name: 'order_items', comment: 'The lines of each order, at the price paid',
      columns: [col('order_id', BIGINT), col('line', INTEGER), col('product_id', BIGINT), col('quantity', INTEGER), col('unit_price', PRICE)],
      pk: ['order_id', 'line'],
      fks: [
        { name: 'order_items_order_id_fkey', columns: ['order_id'], to: { schema: 'public', table: 'orders', columns: ['id'] } },
        { name: 'order_items_product_id_fkey', columns: ['product_id'], to: { schema: 'public', table: 'products', columns: ['id'] } }
      ],
      indexes: [
        pkey('public', 'order_items', ['order_id', 'line'], 32_768, 40_336),
        index({ name: 'order_items_product_id_idx', columns: ['product_id'], def: 'CREATE INDEX order_items_product_id_idx ON public.order_items USING btree (product_id)', bytes: 16_384, scans: 77 })
      ],
      constraints: [
        { name: 'order_items_pkey', kind: 'p', def: 'PRIMARY KEY (order_id, line)' },
        { name: 'order_items_order_id_fkey', kind: 'f', def: 'FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE' },
        { name: 'order_items_product_id_fkey', kind: 'f', def: 'FOREIGN KEY (product_id) REFERENCES products(id)' },
        { name: 'order_items_quantity_check', kind: 'c', def: 'CHECK ((quantity > 0))', column: 'quantity' }
      ],
      size: { table: 49_152, toast: 0 }, stats: { dead: 0, lastAnalyze: analyzed(2), lastVacuum: analyzed(19) }, ddl: DDL.order_items, rows: itemRows
    }),
    relation({
      schema: 'public', name: 'payments', comment: 'Charges at the payment provider, one per attempt',
      columns: [
        col('id', BIGINT, ID), col('order_id', BIGINT), col('provider', TEXT, { default: "'stripe'::text" }), col('provider_ref', TEXT), col('amount', PRICE),
        col('status', TEXT), col('created_at', TSTZ, NOW_DEFAULT)
      ],
      pk: ['id'], uniqueKeys: [['provider_ref']],
      fks: [{ name: 'payments_order_id_fkey', columns: ['order_id'], to: { schema: 'public', table: 'orders', columns: ['id'] } }],
      indexes: [
        pkey('public', 'payments', ['id'], 16_384, 2210),
        index({ name: 'payments_order_id_idx', columns: ['order_id'], def: 'CREATE INDEX payments_order_id_idx ON public.payments USING btree (order_id)', bytes: 16_384, scans: 2210 }),
        index({ name: 'payments_provider_ref_key', columns: ['provider_ref'], def: 'CREATE UNIQUE INDEX payments_provider_ref_key ON public.payments USING btree (provider_ref)', unique: true, byConstraint: true, bytes: 24_576, scans: 1873 })
      ],
      constraints: [
        { name: 'payments_pkey', kind: 'p', def: 'PRIMARY KEY (id)' },
        { name: 'payments_order_id_fkey', kind: 'f', def: 'FOREIGN KEY (order_id) REFERENCES orders(id)' },
        { name: 'payments_provider_ref_key', kind: 'u', def: 'UNIQUE (provider_ref)' }
      ],
      size: { table: 40_960, toast: 0 }, stats: { dead: 3, lastAnalyze: analyzed(2), lastVacuum: analyzed(19) }, ddl: DDL.payments, rows: paymentRows
    }),
    relation({
      schema: 'public', name: 'webhook_events', comment: 'Webhooks from Stripe and the carrier, as they arrived',
      columns: [
        col('id', BIGINT, ID), col('source', TEXT), col('type', TEXT), col('payload', JSONB, { comment: 'The body as the sender posted it' }),
        col('received_at', TSTZ, NOW_DEFAULT), col('processed_at', TSTZ, { null: true })
      ],
      pk: ['id'],
      indexes: [
        pkey('public', 'webhook_events', ['id'], 16_384, 3121),
        index({ name: 'webhook_events_received_at_idx', columns: ['received_at'], def: 'CREATE INDEX webhook_events_received_at_idx ON public.webhook_events USING btree (received_at DESC)', bytes: 16_384, scans: 3121 }),
        // Made for a dashboard nobody built: Structure says "never used".
        index({ name: 'webhook_events_type_idx', columns: ['type'], def: 'CREATE INDEX webhook_events_type_idx ON public.webhook_events USING btree (type)', bytes: 16_384, scans: 0 })
      ],
      constraints: [{ name: 'webhook_events_pkey', kind: 'p', def: 'PRIMARY KEY (id)' }],
      size: { table: 237_568, toast: 196_608 }, stats: { dead: 9, lastAnalyze: analyzed(4), lastVacuum: analyzed(30) }, ddl: DDL.webhook_events, rows: eventRows
    }),
    relation({
      schema: 'public', name: 'paid_orders', kind: 'view', comment: PAID_ORDERS_NOTE,
      columns: [col('id', BIGINT), col('customer_id', BIGINT), col('email', TEXT), col('total', PRICE), col('currency', CHAR3), col('paid_at', TSTZ)].map((c) => ({ ...c, nullable: true })),
      pk: [], indexes: [], constraints: [], size: { table: 0, toast: 0 }, stats: { dead: null, lastAnalyze: null, lastVacuum: null },
      viewDef: PAID_ORDERS_DEF, ddl: `CREATE VIEW public.paid_orders AS\n${PAID_ORDERS_DEF}\n\nCOMMENT ON VIEW public.paid_orders IS '${PAID_ORDERS_NOTE}';\n`, rows: paidRows
    }),
    relation({
      schema: 'analytics', name: 'daily_revenue', comment: 'Filled every night by the reporting job',
      columns: [col('day', DATE), col('orders', INTEGER), col('revenue', AMOUNT), col('refunds', AMOUNT, { default: '0' })],
      pk: ['day'],
      indexes: [pkey('analytics', 'daily_revenue', ['day'], 16_384, 412)],
      constraints: [{ name: 'daily_revenue_pkey', kind: 'p', def: 'PRIMARY KEY (day)' }],
      size: { table: 8192, toast: 0 }, stats: { dead: 0, lastAnalyze: analyzed(7), lastVacuum: analyzed(7) }, ddl: DDL.daily_revenue, rows: dailyRows
    })
  ];

  // The database's size: the catalogs (about 7.5 MB in a fresh database) and the relations.
  const sizeBytes = 7_610_000 + relations.reduce((s, r) => s + r.size.table + r.size.indexes + r.size.toast, 0);
  return {
    schemas: ['public', 'analytics'],
    enums: [{ schema: 'public', name: 'order_status', values: ORDER_STATUS }],
    relations,
    functions: [{ schema: 'public', name: 'order_total', args: 'bigint', returns: 'numeric', oid: 16_437, def: ORDER_TOTAL_DEF }],
    readOnlyRoleSql: READ_ONLY_ROLE_SQL,
    overview: { ...OVERVIEW, sizeBytes }
  };

  /** A wholesale customer's monthly invoice: 360 lines, past 64 KB of JSON (the grid shows it cut). */
  function bigInvoice(at: number): Json {
    const start = unix(at - 31 * DAY);
    const lines = Array.from({ length: 360 }, (_, i) => {
      const [id, s, name, p] = PRODUCTS[1 + (i % (PRODUCTS.length - 1))]!;
      const quantity = 6 + ((i * 7) % 18);
      const day = Math.floor(i / 12);
      return {
        id: `il_1Q7aB0K9${String(i + 1).padStart(4, '0')}`, object: 'line_item', description: `${name} · café restock, day ${day + 1}`, quantity, amount: quantity * p,
        price: { id: `price_${s.toLowerCase().replace(/-/g, '_')}`, product: `prod_${id}`, unit_amount: p, currency: 'eur' },
        period: { start: start + day * 86_400, end: start + (day + 1) * 86_400 }
      };
    });
    return {
      id: 'evt_1Q7aB0K9mZx2Lq', object: 'event', type: 'invoice.finalized', created: unix(at), livemode: false, api_version: API_VERSION, pending_webhooks: 1,
      data: { object: {
        id: 'in_1Q7aB0K9mZx2Lq', object: 'invoice', status: 'open', currency: 'eur', customer_email: 'a.mehta@example.com',
        amount_due: lines.reduce((s, l) => s + l.amount, 0), metadata: { contract: 'WHOLESALE-2026-014', billing_period: new Date(at - 15 * DAY).toISOString().slice(0, 7) },
        lines: { object: 'list', has_more: false, total_count: lines.length, data: lines }
      } },
      request: { id: null, idempotency_key: null }
    };
  }
}
