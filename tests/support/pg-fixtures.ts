// The acme store: the test Postgres's world, loaded by tests/support/pg-server.ts: a few hand-written rows, the rest
// generated around them.
//
// Deterministic: fixed timestamps around ACME_NOW and a seeded generator, no now() or random() in the data (column
// defaults may say now(): they never fill a fixture row). Orders 99–120 are the showcase rows (numbers 10470–10491,
// the newest), order 111 the one its inspector opens (Mara Lindqvist, 248.00, AUTUMN10); webhook event 33 is the
// showcase payload; type_zoo row 1 holds one value of each type, row 2 only NULLs, row 3 edge values.
import { crc32, deflateSync } from 'node:zlib';

/** The fixed "now" the data is written around: the 120 orders fall in the 10 days before it. */
export const ACME_NOW = '2026-11-05T17:10:00.000Z';

const NOW = Date.parse(ACME_NOW);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── SQL and JSON text ──────────────────────────────────────────────────────────────────────────────────────────────

type Sql = string;
const NULL: Sql = 'null';
const str = (s: string | null): Sql => (s === null ? NULL : `'${s.replace(/'/g, "''")}'`);
/** A timestamptz literal in UTC, e.g. '2026-11-05 16:58:00+00'. */
const ts = (ms: number | null): Sql => (ms === null ? NULL : `'${new Date(ms).toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', '+00')}'`);
const cents = (c: number): string => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
const textArray = (items: string[] | null): Sql => (items === null ? NULL : str(`{${items.map((i) => `"${i}"`).join(',')}}`));
/** Board 1 and 2 show times in Europe/Rome (+01 in November). */
const rome = (local: string): number => Date.parse(`${local.replace(' ', 'T')}+01:00`);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const jsonString = (s: string): string =>
  `"${s.replace(/[\\"\u0000-\u001f]/g, (c) => {
    const named: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
    return named[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  })}"`;

/**
 * A value as jsonb prints it (its text output): keys shorter first, then byte order; ", " and ": " between items.
 * Integers only, so numbers print as JavaScript prints them.
 */
export function jsonbText(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`fixture JSON numbers are integers: ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return jsonString(v);
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(', ')}]`;
  const keys = Object.keys(v).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `{${keys.map((k) => `${jsonString(k)}: ${jsonbText(v[k] as Json)}`).join(', ')}}`;
}
const jsonb = (v: Json | undefined): Sql => (v === undefined ? NULL : `${str(jsonbText(v))}::jsonb`);

const insert = (table: string, columns: string[], rows: Sql[][]): Sql =>
  `insert into ${table} (${columns.join(', ')}) values\n${rows.map((r) => `  (${r.join(', ')})`).join(',\n')};`;

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
const rand = generator(0xac3e5);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
const weighted = <T>(choices: readonly [T, number][]): T => {
  let x = rand() * choices.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of choices) if ((x -= w) < 0) return v;
  return (choices[choices.length - 1] as [T, number])[0];
};
const hex = (n: number) => Array.from({ length: n }, () => int(0, 15).toString(16)).join('');
const ALNUM = [...'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'];
const alnum = (n: number) => Array.from({ length: n }, () => pick(ALNUM)).join('');

// ── Customers and coupons ──────────────────────────────────────────────────────────────────────────────────────────

type Plan = 'free' | 'pro' | 'team' | 'enterprise';
const PEOPLE: [string, string, Plan][] = [
  ['Mara Lindqvist', 'mara@lindqvist.example', 'pro'], ['Tomás Arriaga', 'tomas@arriaga.example', 'team'],
  ['Inès Moreau', 'ines.moreau@papeterie.example', 'free'], ['Kenji Watanabe', 'kenji@watanabe.example', 'pro'],
  ['Amara Okafor', 'amara@okafor.example', 'enterprise'], ['Lukas Brenner', 'lukas.brenner@bergwerk.example', 'free'],
  ['Sofia Ricci', 'sofia@ricci.example', 'pro'], ['Noah Fischer', 'noah@fischer.example', 'free'],
  ['Elif Kaya', 'elif@kaya.example', 'team'], ['Oskar Nilsson', 'oskar@nilsson.example', 'free'],
  ['Priya Raman', 'priya@raman.example', 'pro'], ['Jonas Weber', 'jonas.weber@example.org', 'free'],
  ['Chloé Dubois', 'chloe@dubois.example', 'pro'], ['Mateo García', 'mateo@garcia.example', 'free'],
  ['Hana Novák', 'hana@novak.example', 'team'], ["Liam O'Connor", 'liam.oconnor@example.ie', 'free'],
  ['Yuki Tanaka', 'yuki@tanaka.example', 'pro'], ['Zoe Papadopoulos', 'zoe@papadopoulos.example', 'free'],
  ['Arjun Mehta', 'arjun@mehta.example', 'enterprise'], ['Freya Halvorsen', 'freya@halvorsen.example', 'free'],
  ['Dario Conti', 'dario@conti.example', 'pro'], ['Nadia Haddad', 'nadia@haddad.example', 'free'],
  ['Emil Lund', 'emil@lund.example', 'team'], ['Ana Costa', 'ana@costa.example', 'free'],
  ['Felix Wagner', 'felix@wagner.example', 'pro'], ['Leila Farouk', 'leila@farouk.example', 'free'],
  ['Marek Kowalski', 'marek@kowalski.example', 'free'], ['Aiko Mori', 'aiko@mori.example', 'pro'],
  ['Bruno Silva', 'bruno@silva.example', 'free'], ['Clara Jensen', 'clara@jensen.example', 'team'],
  ['Diego Herrera', 'diego@herrera.example', 'free'], ['Eva Horváth', 'eva@horvath.example', 'pro'],
  ['Finn Schmidt', 'finn@schmidt.example', 'free'], ['Greta Rossi', 'greta@rossi.example', 'free'],
  ['Hugo Laurent', 'hugo@laurent.example', 'pro'], ['Isla MacLeod', 'isla@macleod.example', 'free'],
  ['Jakub Dvořák', 'jakub@dvorak.example', 'enterprise'], ['Kira Ivanova', 'kira@ivanova.example', 'free'],
  ['Leo Bianchi', 'leo@bianchi.example', 'pro'], ['Maya Cohen', 'maya@cohen.example', 'team']
];
const customers = PEOPLE.map(([name, email, plan], i) => ({
  id: i + 1,
  name,
  email,
  plan,
  // Mara's date is the showcase's ("since 2025-03-12"); the others joined in the 600 days before.
  created: i === 0 ? Date.parse('2025-03-12T09:14:00Z') : NOW - int(30, 600) * DAY - int(0, 86_399) * SECOND
}));

const COUPONS: [string, number, string, string | null][] = [
  ['AUTUMN10', 10, 'Autumn blend launch', '2026-11-30T23:00:00Z'],
  ['WELCOME5', 5, 'First order', null],
  ['VIP20', 20, 'Customers on the VIP list', null],
  ['SPRING15', 15, 'Spring sale', '2026-04-30T22:00:00Z'],
  ['BLACKFRIDAY25', 25, 'Black Friday', '2026-11-30T23:00:00Z']
];
const couponPercent = new Map(COUPONS.map(([code, pct]) => [code, pct]));

// ── Orders and what hangs off them ─────────────────────────────────────────────────────────────────────────────────

type Status = 'pending' | 'paid' | 'shipped' | 'refunded' | 'failed';
interface Line { sku: string; name: string; qty: number; unit: number }
interface Order {
  id: number; customer: number; status: Status; created: number; source: string; lines: Line[]; coupon: string | null;
  discount: number; total: number; gift: boolean; currency: string; tags: string[] | null; notes: string | null;
  cart: string; paidAt: number | null; updatedAt: number;
}

const PRODUCTS: [string, string, number][] = [
  ['TEA-01', 'Sencha tea, 100 g', 1490], ['TEA-02', 'Earl grey, 100 g', 1290], ['MUG-01', 'Stoneware mug', 2400],
  ['POT-01', 'Cast iron teapot', 6900], ['KET-01', 'Gooseneck kettle', 8900], ['CUP-02', 'Glass cups, set of 2', 1890],
  ['FIL-01', 'Paper filters, 100', 590], ['GFT-01', 'Gift card', 5000], ['SCL-01', 'Coffee scale', 4500],
  ['BEA-01', 'Single origin beans, 250 g', 1650], ['GRN-01', 'Hand grinder', 12900], ['TRY-01', 'Bamboo tray', 3200]
];
const TAGS = ['gift-wrap', 'priority', 'vip', 'b2b', 'first-order', 'eu', 'beta', 'api'];
const NOTES = [
  'Gift wrap please, and leave it with the concierge if nobody answers.',
  'Ring twice.',
  'Invoice to the company, VAT number on file.',
  'Customer called: deliver after 5 pm.',
  'Fragile: glassware.'
];

// Board 1's rows, newest first: its order id, its customer id, status, total, created (Rome), source, items, discount.
const BOARD_1: [number, number, Status, string, string, string, number, boolean][] = [
  [10491, 3307, 'pending', '89.90', '2026-11-05 17:58', 'api', 1, false],
  [10490, 1186, 'paid', '312.40', '2026-11-05 17:41', 'checkout', 4, true],
  [10489, 2950, 'paid', '46.00', '2026-11-05 16:03', 'checkout', 1, false],
  [10488, 412, 'failed', '129.00', '2026-11-05 15:47', 'checkout', 2, false],
  [10487, 2041, 'shipped', '64.50', '2026-11-05 12:10', 'pos', 1, false],
  [10486, 3112, 'paid', '1240.00', '2026-11-05 09:31', 'checkout', 6, true],
  [10485, 2778, 'refunded', '59.00', '2026-11-05 08:02', 'api', 1, false],
  [10484, 1903, 'paid', '18.90', '2026-11-04 22:45', 'checkout', 1, false],
  [10483, 3307, 'shipped', '402.10', '2026-11-04 20:16', 'checkout', 5, true],
  [10482, 2041, 'paid', '248.00', '2026-11-04 18:22', 'checkout', 3, true],
  [10481, 877, 'paid', '77.00', '2026-11-04 15:09', 'pos', 2, false],
  [10480, 2210, 'pending', '15.00', '2026-11-04 11:54', 'api', 1, false],
  [10479, 1186, 'shipped', '96.30', '2026-11-04 09:12', 'checkout', 2, false],
  [10478, 3054, 'paid', '540.00', '2026-11-03 21:40', 'checkout', 3, true],
  [10477, 2513, 'failed', '33.00', '2026-11-03 18:03', 'checkout', 1, false],
  [10476, 412, 'paid', '129.00', '2026-11-03 14:26', 'checkout', 2, false],
  [10475, 1650, 'refunded', '220.00', '2026-11-03 10:11', 'api', 2, true],
  [10474, 2041, 'shipped', '64.00', '2026-11-02 19:58', 'pos', 1, false],
  [10473, 2999, 'paid', '12.50', '2026-11-02 16:37', 'checkout', 1, false],
  [10472, 3120, 'paid', '87.40', '2026-11-02 12:20', 'checkout', 2, false],
  [10471, 1777, 'pending', '410.00', '2026-11-02 08:44', 'api', 4, true],
  [10470, 2638, 'paid', '58.00', '2026-11-01 23:05', 'checkout', 1, false]
];
// Board 1's customer ids, in order of appearance (2041, Mara, is customer 1); then 2, 3, …
const boardCustomer = new Map<number, number>([[2041, 1]]);
for (const [, c] of [...BOARD_1].reverse()) if (!boardCustomer.has(c)) boardCustomer.set(c, boardCustomer.size + 1);

const ORDER_COUNT = 120;
const GENERATED = ORDER_COUNT - BOARD_1.length; // ids 1–98, before the showcase rows
const firstAt = NOW - 10 * DAY + 40 * MINUTE;
const lastGeneratedAt = rome('2026-11-01 21:30');

function lines(n: number): Line[] {
  return Array.from({ length: n }, () => {
    const [sku, name, unit] = pick(PRODUCTS);
    return { sku, name, unit, qty: weighted([[1, 7], [2, 2], [3, 1]]) };
  });
}

function settle(o: Omit<Order, 'paidAt' | 'updatedAt'>): Order {
  const done = o.status === 'paid' || o.status === 'shipped' || o.status === 'refunded';
  const paidAt = done ? o.created + int(20, 240) * SECOND : null;
  const later = (days: number) => Math.min(o.created + days * DAY + int(0, 6 * 3600) * SECOND, NOW - 5 * MINUTE);
  const updatedAt = o.status === 'shipped' ? later(1) : o.status === 'refunded' ? later(2) : paidAt ?? o.created;
  return { ...o, paidAt, updatedAt };
}

const orders: Order[] = [];
for (let i = 0; i < GENERATED; i++) {
  const id = i + 1;
  const step = (lastGeneratedAt - firstAt) / (GENERATED - 1);
  const jitter = id === 1 ? 0 : (rand() - 0.5) * step * 0.6;
  const created = Math.round((firstAt + i * step + jitter) / SECOND) * SECOND;
  // Order 1: shipped, three lines, Mara's (integration tests count its references).
  const status: Status = id === 1 ? 'shipped' : weighted([['paid', 45], ['shipped', 30], ['pending', 10], ['refunded', 8], ['failed', 7]]);
  const items = lines(id === 1 ? 3 : weighted([[1, 8], [2, 6], [3, 3], [4, 2], [5, 1]]));
  const coupon = rand() < 0.22 ? pick(COUPONS)[0] : null;
  const subtotal = items.reduce((s, l) => s + l.qty * l.unit, 0);
  const discount = coupon ? Math.round((subtotal * (couponPercent.get(coupon) ?? 0)) / 100) : 0;
  orders.push(settle({
    id, status, created, coupon, discount, total: subtotal - discount, lines: items,
    customer: id === 1 ? 1 : int(1, customers.length),
    source: weighted([['checkout', 14], ['api', 4], ['pos', 2]]),
    gift: rand() < 0.15,
    currency: weighted([['EUR', 17], ['USD', 2], ['GBP', 1]]),
    tags: rand() < 0.55 ? null : [...new Set(Array.from({ length: int(1, 3) }, () => pick(TAGS)))],
    notes: rand() < 0.12 ? pick(NOTES) : null,
    cart: `c_${hex(8)}`
  }));
}
BOARD_1.forEach(([boardId, boardCust, status, total, local, source, n, discounted], k) => {
  const id = ORDER_COUNT - k;
  const isInspected = boardId === 10482;
  // Order 111 is the inspector's: created 18:22:07.413 Rome, cart c_8f2a91c4, AUTUMN10.
  const created = isInspected ? Date.parse('2026-11-04T17:22:07.413Z') : rome(local) + int(0, 59) * SECOND;
  const totalCents = Math.round(Number(total) * 100);
  const coupon = discounted ? (isInspected ? 'AUTUMN10' : pick(['AUTUMN10', 'AUTUMN10', 'VIP20', 'WELCOME5'])) : null;
  const pct = coupon ? (couponPercent.get(coupon) ?? 0) : 0;
  // The lines add up to the total before the discount.
  const subtotal = Math.round((totalCents * 100) / (100 - pct));
  const items = lines(n).map((l, j) => ({ ...l, qty: 1, unit: j < n - 1 ? Math.floor(subtotal / n) : subtotal - Math.floor(subtotal / n) * (n - 1) }));
  orders.push(settle({
    id, status, created, coupon, discount: subtotal - totalCents, total: totalCents, lines: items,
    customer: boardCustomer.get(boardCust) ?? 1,
    source,
    gift: isInspected ? false : rand() < 0.15,
    currency: 'EUR',
    tags: isInspected ? ['gift-wrap', 'priority', 'vip'] : rand() < 0.55 ? null : [pick(TAGS)],
    notes: rand() < 0.12 ? pick(NOTES) : null,
    cart: isInspected ? 'c_8f2a91c4' : `c_${hex(8)}`
  }));
});
orders.sort((a, b) => a.id - b.id);

const orderMetadata = (o: Order): Json => ({
  source: o.source,
  cart_id: o.cart,
  items: o.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
  discount: o.coupon ? { code: o.coupon, percent: couponPercent.get(o.coupon) ?? 0 } : null,
  gift: o.gift
});

const payments = orders
  .filter((o) => o.status !== 'pending')
  .map((o, i) => ({
    id: i + 1, order: o.id, amount: o.total, currency: o.currency,
    method: weighted([['card', 7], ['paypal', 2], ['apple_pay', 1]]),
    status: o.status === 'failed' ? 'failed' : 'succeeded',
    ref: `pi_${alnum(14)}`,
    at: o.paidAt ?? o.created + 40 * SECOND
  }));

// Shipped orders, and a label printed for every third paid one (order 111, has one).
const shipments = orders
  .filter((o) => o.status === 'shipped' || (o.status === 'paid' && o.id % 3 === 0))
  .map((o, i) => {
    const shippedAt = o.status === 'shipped' ? o.updatedAt : null;
    const delivered = shippedAt !== null && shippedAt + 2 * DAY < NOW ? shippedAt + 2 * DAY - int(0, 600) * MINUTE : null;
    return { id: i + 1, order: o.id, carrier: pick(['DHL', 'UPS', 'GLS', 'Poste Italiane']), tracking: `${alnum(4).toUpperCase()}${int(10_000_000, 99_999_999)}`, shippedAt, delivered };
  });

const refunds = orders
  .filter((o) => o.status === 'refunded')
  .map((o, i) => ({ id: i + 1, order: o.id, amount: o.total, reason: pick(['damaged in transit', 'not as described', 'duplicate order', 'changed mind']), at: o.updatedAt }));

const orderItems = orders.flatMap((o) => o.lines.map((l, j) => ({ order: o.id, line: j + 1, ...l })));

// ── Webhook events ───────────────────────────────────────────────────────────────────────────────────────

const STATUS_OF: Record<string, string> = {
  'invoice.paid': 'paid', 'invoice.finalized': 'open', 'invoice.upcoming': 'draft', 'invoice.payment_failed': 'open', 'invoice.voided': 'void'
};

function invoiceEvent(evt: string, type: string, status: string, received: number, order: Order, extra: { notes?: string } = {}): Json {
  const inv = `in_${evt.slice(4, 10)}${alnum(2)}`;
  const customer = customers[order.customer - 1];
  const object: { [k: string]: Json } = {
    id: inv,
    status,
    amount_due: order.total,
    customer_email: customer?.email ?? null,
    invoice_pdf: `https://pay.example.com/${inv}/pdf`,
    lines: {
      data: order.lines.slice(0, 2).map((l, j) => ({
        id: `il_${evt.slice(4, 10)}${j}${alnum(2)}`,
        price: { id: `price_${l.sku.toLowerCase().replace('-', '_')}`, unit_amount: l.unit, recurring: { interval: 'month' } },
        quantity: l.qty
      }))
    },
    metadata: { order_id: String(order.id), ...(extra.notes ? { notes_json: extra.notes } : {}) }
  };
  const data: { [k: string]: Json } = { object };
  if (status === 'paid' || status === 'void') data.previous_attributes = { status: 'open' };
  const viaApi = type !== 'invoice.upcoming' && rand() < 0.6;
  return {
    id: evt, type, created: Math.floor(received / SECOND) - 2, livemode: false, data,
    request: viaApi ? { id: `req_${alnum(12)}`, idempotency_key: `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}` } : { id: null, idempotency_key: null }
  };
}

/** Board 2's inspected payload (event 33, its 88213), key for key. */
const BOARD_2_PAYLOAD: Json = {
  id: 'evt_1Q8f2aK9',
  type: 'invoice.paid',
  created: 1793813327,
  livemode: false,
  data: {
    object: {
      id: 'in_1Q8f29K9',
      status: 'paid',
      amount_due: 4900,
      customer_email: 'mara@lindqvist.example',
      invoice_pdf: 'https://pay.example.com/in_1Q8f29K9/pdf',
      lines: {
        data: [
          { id: 'il_1Q8f29K9', price: { id: 'price_pro_monthly', unit_amount: 4900, recurring: { interval: 'month' } }, quantity: 1 },
          { id: 'il_1Q8f2BK9', price: { id: 'price_seat_monthly', unit_amount: 0, recurring: { interval: 'month' } }, quantity: 3, description: 'Extra seats (included)' }
        ]
      },
      metadata: { order_id: '111', notes_json: '{"gift":true,"msg":"Happy birthday, Ana! Enjoy the autumn blend."}' }
    },
    previous_attributes: { status: 'open' }
  },
  request: { id: 'req_8f2a91c4K9xQ', idempotency_key: '6d1c2f0a-91b7-4c3e-a8f2-31b7c0a4e7d1' }
};

/** Event 1: a usage invoice with 320 metered lines, over 70 KB of JSON (the value cut at 64 KB). ASCII only. */
function bigInvoice(): Json {
  const start = Date.parse('2026-10-01T00:00:00Z') / SECOND;
  const regions = ['eu-central-1', 'eu-west-1', 'us-east-1', 'ap-northeast-1'];
  const data: Json[] = Array.from({ length: 320 }, (_, i) => {
    const day = Math.floor(i / regions.length);
    const region = regions[i % regions.length] as string;
    const quantity = 10_000 + ((i * 7919) % 90_000);
    return {
      id: `il_usage_${String(i + 1).padStart(4, '0')}`,
      price: { id: `price_api_calls_${region.replace(/-/g, '_')}`, nickname: `API calls (${region})`, unit_amount: 2, recurring: { interval: 'month', usage_type: 'metered' } },
      period: { start: start + day * 86_400, end: start + (day + 1) * 86_400 },
      quantity,
      amount: quantity * 2,
      description: `API calls, region ${region}, day ${String(day + 1).padStart(3, '0')}`
    };
  });
  return {
    id: 'evt_1Q7aB0K9',
    type: 'invoice.finalized',
    created: Date.parse('2026-11-01T00:05:12Z') / SECOND,
    livemode: false,
    data: {
      object: {
        id: 'in_1Q7aB0K9',
        status: 'open',
        amount_due: data.reduce<number>((s, l) => s + ((l as { amount: number }).amount), 0),
        customer_email: 'amara@okafor.example',
        invoice_pdf: 'https://pay.example.com/in_1Q7aB0K9/pdf',
        lines: { data, has_more: false, total_count: data.length },
        metadata: { contract: 'ENT-2026-014', billing_period: '2026-10' }
      }
    },
    request: { id: null, idempotency_key: null }
  };
}

const BIG_DOC = jsonbText(bigInvoice());
/** The byte size of webhook_events 1's payload as Postgres prints it (> 70 KB; ASCII, so also its length). */
export const BIG_DOC_BYTES = Buffer.byteLength(BIG_DOC);

// Board 2's rows (its ids 88202–88221, oldest first) become events 22–41, received 2026-11-04 (Rome).
const BOARD_2: [number, string, string, string][] = [
  [88202, 'invoice.paid', 'paid', '17:58:40'], [88203, 'invoice.finalized', 'open', '18:02:17'],
  [88204, 'invoice.paid', 'paid', '18:02:19'], [88205, 'invoice.payment_failed', 'open', '18:07:55'],
  [88206, 'invoice.paid', 'paid', '18:11:02'], [88207, 'invoice.finalized', 'open', '18:15:29'],
  [88208, 'invoice.paid', 'paid', '18:15:31'], [88209, 'invoice.upcoming', 'draft', '18:19:44'],
  [88210, 'invoice.paid', 'paid', '18:20:05'], [88211, 'invoice.payment_failed', 'uncollectible', '18:24:13'],
  [88212, 'invoice.finalized', 'open', '18:28:47'], [88213, 'invoice.paid', 'paid', '18:28:49'],
  [88214, 'invoice.paid', 'paid', '18:31:09'], [88215, 'invoice.voided', 'void', '18:33:41'],
  [88216, 'invoice.finalized', 'open', '18:35:58'], [88217, 'invoice.paid', 'paid', '18:36:02'],
  [88218, 'invoice.payment_failed', 'open', '18:37:14'], [88219, 'invoice.upcoming', 'draft', '18:39:30'],
  [88220, 'invoice.paid', 'paid', '18:40:52'], [88221, 'invoice.finalized', 'open', '18:41:07']
];
const GIFT_NOTE = '{"gift":true,"msg":"Leave it with the concierge."}';
const webhookEvents: { id: number; type: string; payload: Json | string; received: number }[] = [
  { id: 1, type: 'invoice.finalized', payload: BIG_DOC, received: Date.parse('2026-11-01T00:05:14Z') }
];
for (let i = 0; i < 20; i++) {
  const type = pick(Object.keys(STATUS_OF));
  const received = Date.parse('2026-11-04T07:00:00Z') + i * 26 * MINUTE + int(0, 1500) * SECOND;
  const evt = `evt_1Q8${alnum(5)}`;
  webhookEvents.push({ id: i + 2, type, received, payload: invoiceEvent(evt, type, STATUS_OF[type] ?? 'open', received, pick(orders), rand() < 0.2 ? { notes: GIFT_NOTE } : {}) });
}
BOARD_2.forEach(([boardId, type, status, time], k) => {
  const received = rome(`2026-11-04 ${time}`);
  const evt = `evt_1Q8f${(boardId % 97).toString(36)}K9`;
  const payload = boardId === 88213 ? BOARD_2_PAYLOAD : invoiceEvent(evt, type, status, received, pick(orders), rand() < 0.2 ? { notes: GIFT_NOTE } : {});
  webhookEvents.push({ id: 22 + k, type, received, payload });
});

// ── Every type ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * type_zoo's columns: name, type as format_type() prints it (also its DDL), and the pg_type.typname casts name: the
 * element type's for an array, the base type's for a domain (DbColumn.typeName).
 */
export const TYPE_ZOO_COLUMNS: readonly { name: string; type: string; typeName: string }[] = [
  { name: 'id', type: 'bigint', typeName: 'int8' },
  { name: 'c_text', type: 'text', typeName: 'text' },
  { name: 'c_int4', type: 'integer', typeName: 'int4' },
  { name: 'c_int8', type: 'bigint', typeName: 'int8' },
  { name: 'c_numeric', type: 'numeric(12,2)', typeName: 'numeric' },
  { name: 'c_real', type: 'real', typeName: 'float4' },
  { name: 'c_bool', type: 'boolean', typeName: 'bool' },
  { name: 'c_date', type: 'date', typeName: 'date' },
  { name: 'c_time', type: 'time without time zone', typeName: 'time' },
  { name: 'c_timestamp', type: 'timestamp without time zone', typeName: 'timestamp' },
  { name: 'c_timestamptz', type: 'timestamp with time zone', typeName: 'timestamptz' },
  { name: 'c_interval', type: 'interval', typeName: 'interval' },
  { name: 'c_uuid', type: 'uuid', typeName: 'uuid' },
  { name: 'c_json', type: 'json', typeName: 'json' },
  { name: 'c_jsonb', type: 'jsonb', typeName: 'jsonb' },
  { name: 'c_text_array', type: 'text[]', typeName: 'text' },
  { name: 'c_int4_array', type: 'integer[]', typeName: 'int4' },
  { name: 'c_bytea', type: 'bytea', typeName: 'bytea' },
  { name: 'c_inet', type: 'inet', typeName: 'inet' },
  { name: 'c_cidr', type: 'cidr', typeName: 'cidr' },
  { name: 'c_macaddr', type: 'macaddr', typeName: 'macaddr' },
  { name: 'c_tstzrange', type: 'tstzrange', typeName: 'tstzrange' },
  { name: 'c_int4range', type: 'int4range', typeName: 'int4range' },
  { name: 'c_tsvector', type: 'tsvector', typeName: 'tsvector' },
  { name: 'c_xml', type: 'xml', typeName: 'xml' },
  { name: 'c_money', type: 'money', typeName: 'money' },
  { name: 'c_citext', type: 'citext', typeName: 'citext' },
  // A domain and an array of it: the catalog reports the base type (int4), so a cast never trips the domain's CHECK.
  { name: 'c_domain', type: 'positive_int', typeName: 'int4' },
  { name: 'c_domain_array', type: 'positive_int[]', typeName: 'int4' },
  { name: 'password_hash', type: 'text', typeName: 'text' },
  { name: 'api_token', type: 'text', typeName: 'text' }
];

/** A 320 × 320 PNG, the showcase bytea (violet to pink, the brand gradient). */
function png(width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x + y) / (width + height - 2);
      const at = y * stride + 1 + x * 3;
      pixels[at] = Math.round(0x8b + (0xec - 0x8b) * t);
      pixels[at + 1] = Math.round(0x5c + (0x48 - 0x5c) * t);
      pixels[at + 2] = Math.round(0xf6 + (0x99 - 0xf6) * t);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const GIFT_TEXT = 'Gift wrap please, and leave it with the concierge if nobody answers.';
const ZOO_ROWS: Record<string, Sql>[] = [
  {
    id: '1', c_text: str(GIFT_TEXT), c_int4: '48210', c_int8: '10482', c_numeric: '1240.00', c_real: '3.14', c_bool: 'true',
    c_date: "'2026-11-04'", c_time: "'18:22:07.413'", c_timestamp: "'2026-11-04 18:22:07.413'",
    c_timestamptz: "'2026-11-04 18:22:07.413+01'", c_interval: "'3 days 04:00:00'", c_uuid: "'8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1'",
    // "trial": a JSON null (row 3's {} has no such key): the JSON view's Filter on null.
    c_json: str('{"plan": "pro", "seats": 12, "sso": true, "trial": null, "limits": {"projects": 50, "members": 25}}'),
    c_jsonb: jsonb({ plan: 'pro', seats: 12, sso: true, trial: null, limits: { projects: 50, members: 25 } }),
    c_text_array: textArray(['api', 'beta', 'eu', 'gift-wrap', 'priority', 'vip']), c_int4_array: "'{1,2,3,5,8,13}'",
    c_bytea: `'\\x${png(320, 320).toString('hex')}'`, c_inet: "'10.24.0.17'", c_cidr: "'10.24.0.0/16'", c_macaddr: "'08:00:2b:01:02:03'",
    c_tstzrange: "'[2026-11-01 00:00+01, 2026-12-01 00:00+01)'", c_int4range: "'[10,20)'",
    c_tsvector: `to_tsvector('english', ${str(GIFT_TEXT)})`,
    c_xml: str('<invoice id="in_1Q8f29K9"><line sku="TEA-01" qty="2"/><total currency="EUR">248.00</total></invoice>'),
    c_money: '1240.00', c_citext: "'Mara@Lindqvist.Example'", c_domain: '12', c_domain_array: "'{3,5}'",
    password_hash: "'$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4'",
    api_token: "'atl_tok_4f9c2e7a1b8d0c3e5a6f'"
  },
  Object.fromEntries(TYPE_ZOO_COLUMNS.map(({ name }) => [name, name === 'id' ? '2' : NULL])),
  {
    id: '3', c_text: "'  '", c_int4: '-2147483648', c_int8: '9007199254740993', c_numeric: '-12.50', c_real: '-0.5', c_bool: 'false',
    c_date: "'1999-12-31'", c_time: "'00:00'", c_timestamp: "'2000-01-01 00:00'", c_timestamptz: "'infinity'",
    c_interval: "'1 year 2 mons -3 days'", c_uuid: "'00000000-0000-0000-0000-000000000000'", c_json: "'[]'", c_jsonb: "'{}'",
    c_text_array: "'{}'", c_int4_array: "'{1,NULL,3}'", c_bytea: "'\\x'", c_inet: "'::1'", c_cidr: "'2001:db8::/32'",
    c_macaddr: "'00:00:00:00:00:00'", c_tstzrange: "'empty'", c_int4range: "'[1,)'", c_tsvector: "''", c_xml: "'<empty/>'",
    c_money: '-12.50', c_citext: "''", c_domain: '2147483647', c_domain_array: "'{}'", password_hash: NULL, api_token: "''"
  }
];

// ── The rest ───────────────────────────────────────────────────────────────────────────────────────────────────────

const EMPLOYEES: [string, string, number | null][] = [
  ['Ada Brook', 'CEO', null], ['Ben Ortiz', 'CTO', 1], ['Cleo Marsh', 'CFO', 1], ['Dev Patel', 'Engineering manager', 2],
  ['Eli Stone', 'Senior engineer', 4], ['Fay Lin', 'Engineer', 4], ['Gus Hart', 'Engineer', 4], ['Hal Moss', 'Designer', 2],
  ['Ivy Chen', 'Accountant', 3], ['Jay Park', 'Support lead', 1], ['Kai Ross', 'Support', 10], ['Lia Wren', 'Support', 10]
];

const measurements = [1, 2, 3].flatMap((sensor) => [
  ...[1, 5, 9, 13, 17, 21, 25, 29].map((d) => Date.parse(`2026-10-${String(d).padStart(2, '0')}T12:00:00Z`)),
  ...Array.from({ length: 8 }, (_, k) => Date.parse('2026-11-01T00:00:00Z') + k * 12 * HOUR)
].map((at) => ({ sensor, at, celsius: (1500 + sensor * 100 + int(0, 600)) }))); // hundredths of a degree

const eventsNoPk = Array.from({ length: 30 }, (_, k) => ({
  at: NOW - 2 * DAY + k * 90 * MINUTE,
  kind: pick(['login', 'login', 'logout', 'export', 'search']),
  detail: { ip: `10.24.0.${int(2, 40)}`, agent: pick(['Safari 19', 'Firefox 150', 'Chrome 142']) } as Json
}));
// No key: two rows can be the same row (a retry logged twice).
eventsNoPk.splice(11, 0, { ...(eventsNoPk[10] as (typeof eventsNoPk)[number]) });

const PAGES = ['/', '/pricing', '/docs/getting-started', '/blog/autumn-blend', '/checkout', '/account'];
const pageViews = Array.from({ length: 25 }, (_, k) => ({
  path: pick(PAGES),
  referrer: rand() < 0.4 ? null : pick(['https://news.example.com/', 'https://search.example.com/?q=sencha', 'newsletter']),
  at: NOW - DAY + k * 50 * MINUTE + int(0, 1800) * SECOND
}));

const ORDER_ITEMS_ODD: [number, string, number][] = [[1, 'gift wrap', 2], [2, "it's fragile", 1], [3, 'Größe M · 日本', 4]];

/**
 * item_notes: a composite foreign key (item_line, item_order) → order_items (line, order_id), declared in the other
 * order than the referenced primary key and indexed in a third, plus a nullable author_email → customers (email), a
 * unique column that isn't a primary key. Per line: order 1 line 1 has 2 notes, line 2 has 1, order 2 line 1 has 3
 * (a swapped mapping counts differently); one note has no line (NULL: it points at nothing).
 */
const ITEM_NOTES: [id: number, line: number | null, order: number, note: string, author: number | null][] = [
  [1, 1, 1, 'Gift wrap, no price tag', 1], [2, 1, 1, 'Card: happy birthday, Ines', null], [3, 2, 1, 'Fragile: pack twice', 1],
  [4, 1, 2, 'Ship with the next batch', 2], [5, 1, 2, 'Customer called twice', 2], [6, 1, 2, 'Address confirmed', null],
  [7, null, 1, 'Line to be decided', null]
];

/**
 * currency_rates: no primary key, a unique NOT NULL key (code) — the row's key for Load full value, the hidden fields
 * and the inspector — and a nullable unique column (that can't name a row).
 */
const CURRENCY_RATES: [code: string, rate: string, alias: string | null, note: string | null][] = [
  ['EUR', '1.000000', 'euro', null], ['USD', '1.083200', null, 'ECB reference rate, 2026-11-04'], ['JPY', '162.450000', 'yen', 'Rounded to six places']
];

/** Rows per table, as loaded (integration tests check that reads changed none). */
export const ACME_COUNTS: Readonly<Record<string, number>> = {
  customers: customers.length,
  coupons: COUPONS.length,
  orders: orders.length,
  order_items: orderItems.length,
  payments: payments.length,
  shipments: shipments.length,
  refunds: refunds.length,
  webhook_events: webhookEvents.length,
  type_zoo: ZOO_ROWS.length,
  events_nopk: eventsNoPk.length,
  employees: EMPLOYEES.length,
  measurements: measurements.length,
  'Order "Items"': ORDER_ITEMS_ODD.length,
  item_notes: ITEM_NOTES.length,
  currency_rates: CURRENCY_RATES.length,
  'analytics.page_views': pageViews.length
};

export const ACME_SQL: string = [
  `create extension if not exists citext;`,
  `create type order_status as enum ('pending', 'paid', 'shipped', 'refunded', 'failed');`,
  `create type plan_tier as enum ('free', 'pro', 'team', 'enterprise');`,
  `create domain positive_int as int4 check (value > 0);`,
  `create table customers (
  id int8 primary key,
  name text not null,
  email text not null unique,
  plan plan_tier not null default 'free',
  created_at timestamptz not null default now()
);`,
  `comment on table customers is 'People with an account';`,
  `create table coupons (
  code text primary key,
  percent int4 not null check (percent between 1 and 100),
  description text,
  expires_at timestamptz
);`,
  `create table orders (
  id int8 generated by default as identity primary key,
  customer_id int8 not null constraint orders_customer_id_fkey references customers (id) on delete restrict,
  status order_status not null default 'pending',
  total numeric(10,2) not null default 0 constraint orders_total_check check (total >= 0),
  currency char(3) not null default 'EUR',
  metadata jsonb not null default '{}',
  tags text[],
  coupon_code text constraint orders_coupon_code_fkey references coupons (code) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now(),
  notes text
);`,
  `comment on table orders is 'One row per checkout';`,
  `comment on column orders.notes is 'Shown on the packing slip';`,
  `comment on column orders.metadata is 'Cart snapshot from the checkout';`,
  `create index orders_customer_id_idx on orders (customer_id);`,
  `create index orders_created_at_idx on orders (created_at desc);`,
  `create index orders_metadata_gin on orders using gin (metadata jsonb_path_ops);`,
  `create index orders_pending_idx on orders (created_at) where status = 'pending';`,
  `create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;`,
  `create trigger orders_set_updated_at before update on orders for each row execute function set_updated_at();`,
  `create table order_items (
  order_id int8 not null references orders (id) on delete cascade,
  line int4 not null,
  sku text not null,
  name text not null,
  quantity int4 not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  primary key (order_id, line)
);`,
  `create table item_notes (
  id int4 primary key,
  item_line int4,
  item_order int8 not null,
  note text not null,
  author_email text references customers (email),
  constraint item_notes_item_fkey foreign key (item_line, item_order) references order_items (line, order_id)
);`,
  `create index item_notes_item_idx on item_notes (item_order, item_line);`,
  `create table payments (
  id int8 generated by default as identity primary key,
  order_id int8 not null references orders (id),
  amount numeric(10,2) not null,
  currency char(3) not null,
  method text not null,
  status text not null,
  provider_ref text not null unique,
  created_at timestamptz not null
);`,
  `create index payments_order_id_idx on payments (order_id);`,
  `create table shipments (
  id int8 generated by default as identity primary key,
  order_id int8 not null references orders (id),
  carrier text not null,
  tracking_no text not null,
  shipped_at timestamptz,
  delivered_at timestamptz
);`,
  `create table refunds (
  id int8 generated by default as identity primary key,
  order_id int8 not null references orders (id),
  amount numeric(10,2) not null,
  reason text,
  created_at timestamptz not null
);`,
  `create table webhook_events (
  id int8 generated by default as identity primary key,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null
);`,
  `create index webhook_events_type_idx on webhook_events (type);`,
  `create table type_zoo (
${TYPE_ZOO_COLUMNS.map(({ name, type }) => `  ${name} ${type}${name === 'id' ? ' primary key' : ''}`).join(',\n')}
);`,
  `create table events_nopk (
  occurred_at timestamptz not null,
  kind text not null,
  detail jsonb
);`,
  `create table currency_rates (
  alias text unique,
  code text not null,
  rate numeric(12,6) not null,
  note text,
  constraint currency_rates_code_key unique (code)
);`,
  `create table employees (
  id int8 primary key,
  name text not null,
  title text not null,
  manager_id int8 references employees (id)
);`,
  `create table measurements (
  sensor_id int4 not null,
  taken_at timestamptz not null,
  celsius numeric(5,2) not null
) partition by range (taken_at);`,
  `create table measurements_2026_10 partition of measurements for values from ('2026-10-01 00:00+00') to ('2026-11-01 00:00+00');`,
  `create table measurements_2026_11 partition of measurements for values from ('2026-11-01 00:00+00') to ('2026-12-01 00:00+00');`,
  `create table "Order ""Items""" (
  id int4 primary key,
  "Weird Col" text,
  "Qty" int4 not null
);`,
  `create schema analytics;`,
  `create table analytics.page_views (
  id int8 generated always as identity primary key,
  path text not null,
  referrer text,
  viewed_at timestamptz not null
);`,
  insert('customers', ['id', 'name', 'email', 'plan', 'created_at'], customers.map((c) => [String(c.id), str(c.name), str(c.email), str(c.plan), ts(c.created)])),
  insert('coupons', ['code', 'percent', 'description', 'expires_at'], COUPONS.map(([code, pct, d, exp]) => [str(code), String(pct), str(d), ts(exp === null ? null : Date.parse(exp))])),
  insert(
    'orders',
    ['id', 'customer_id', 'status', 'total', 'currency', 'metadata', 'tags', 'coupon_code', 'created_at', 'paid_at', 'updated_at', 'notes'],
    orders.map((o) => [String(o.id), String(o.customer), str(o.status), cents(o.total), str(o.currency), jsonb(orderMetadata(o)), textArray(o.tags), str(o.coupon), ts(o.created), ts(o.paidAt), ts(o.updatedAt), str(o.notes)])
  ),
  insert('order_items', ['order_id', 'line', 'sku', 'name', 'quantity', 'unit_price'], orderItems.map((l) => [String(l.order), String(l.line), str(l.sku), str(l.name), String(l.qty), cents(l.unit)])),
  insert('item_notes', ['id', 'item_line', 'item_order', 'note', 'author_email'], ITEM_NOTES.map(([id, line, order, note, author]) => [
    String(id), line === null ? NULL : String(line), String(order), str(note), str(author === null ? null : customers[author - 1]?.email ?? null)
  ])),
  insert('payments', ['id', 'order_id', 'amount', 'currency', 'method', 'status', 'provider_ref', 'created_at'], payments.map((p) => [String(p.id), String(p.order), cents(p.amount), str(p.currency), str(p.method), str(p.status), str(p.ref), ts(p.at)])),
  insert('shipments', ['id', 'order_id', 'carrier', 'tracking_no', 'shipped_at', 'delivered_at'], shipments.map((s) => [String(s.id), String(s.order), str(s.carrier), str(s.tracking), ts(s.shippedAt), ts(s.delivered)])),
  insert('refunds', ['id', 'order_id', 'amount', 'reason', 'created_at'], refunds.map((r) => [String(r.id), String(r.order), cents(r.amount), str(r.reason), ts(r.at)])),
  insert('webhook_events', ['id', 'type', 'payload', 'received_at'], webhookEvents.map((e) => [String(e.id), str(e.type), typeof e.payload === 'string' ? `${str(e.payload)}::jsonb` : jsonb(e.payload), ts(e.received)])),
  insert('type_zoo', TYPE_ZOO_COLUMNS.map((c) => c.name), ZOO_ROWS.map((r) => TYPE_ZOO_COLUMNS.map((c) => r[c.name] ?? NULL))),
  insert('events_nopk', ['occurred_at', 'kind', 'detail'], eventsNoPk.map((e) => [ts(e.at), str(e.kind), jsonb(e.detail)])),
  insert('currency_rates', ['code', 'rate', 'alias', 'note'], CURRENCY_RATES.map(([code, rate, alias, note]) => [str(code), rate, str(alias), str(note)])),
  insert('employees', ['id', 'name', 'title', 'manager_id'], EMPLOYEES.map(([name, title, mgr], i) => [String(i + 1), str(name), str(title), mgr === null ? NULL : String(mgr)])),
  insert('measurements', ['sensor_id', 'taken_at', 'celsius'], measurements.map((m) => [String(m.sensor), ts(m.at), cents(m.celsius)])),
  insert('"Order ""Items"""', ['id', '"Weird Col"', '"Qty"'], ORDER_ITEMS_ODD.map(([id, v, q]) => [String(id), str(v), String(q)])),
  insert('analytics.page_views', ['path', 'referrer', 'viewed_at'], pageViews.map((p) => [str(p.path), str(p.referrer), ts(p.at)])),
  ...['orders', 'payments', 'shipments', 'refunds', 'webhook_events'].map((t) => `select setval(pg_get_serial_sequence('${t}', 'id'), (select max(id) from ${t}));`),
  `create view paid_orders as
  select id, customer_id, total, currency, paid_at from orders where status = 'paid';`,
  `create materialized view daily_revenue as
  select (created_at at time zone 'UTC')::date as day, count(*) as orders, sum(total) as revenue
  from orders where status in ('paid', 'shipped') group by 1 order by 1;`,
  // 8 s, not 30 (a page on it outlives the timeouts tests set, and frees the one backend soon after). In
  // FROM: a view's column can't be void.
  `create view slow_view as select 1 as one, 'slept 8 s' as note from pg_sleep(8);`,
  `create function order_total(order_id int8) returns numeric language sql stable as $$
  select coalesce(sum(quantity * unit_price), 0) from order_items where order_items.order_id = $1
$$;`,
  `analyze;`
].join('\n');
