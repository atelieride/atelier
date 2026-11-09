// Hand-built TableTargets for the acme fixtures (tests/support/pg-fixtures.ts), as the catalog reader will describe
// them: column types as format_type() prints them, the element type's namespace, typname and typcategory, the primary
// key and the unique not-null keys. The SQL builders' tests use them (src/main/databases/postgres/sql.test.ts,
// tests/integration/db-sql.test.ts).
import type { DbColumn } from '../../src/shared/databases-filters';
import type { TableTarget } from '../../src/main/databases/postgres/sql';

/** A column; its type lives in pg_catalog unless `o.typeSchema` says otherwise. */
export const col = (name: string, type: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});

const pk = { isPk: true, isKey: true, nullable: false } as const;
const ORDER_STATUS = ['pending', 'paid', 'shipped', 'refunded', 'failed'];
const PLAN_TIER = ['free', 'pro', 'team', 'enterprise'];
const tstz = (name: string, o: Partial<DbColumn> = {}) => col(name, 'timestamp with time zone', 'timestamptz', 'D', o);

export const CUSTOMERS: TableTarget = {
  schema: 'public', name: 'customers', pk: ['id'], uniqueKeys: [['email']],
  columns: [
    col('id', 'bigint', 'int8', 'N', pk),
    col('name', 'text', 'text', 'S', { nullable: false }),
    col('email', 'text', 'text', 'S', { nullable: false }),
    col('plan', 'plan_tier', 'plan_tier', 'E', { typeSchema: 'public', enumValues: PLAN_TIER, nullable: false }),
    tstz('created_at', { nullable: false })
  ]
};

export const ORDERS: TableTarget = {
  schema: 'public', name: 'orders', pk: ['id'], uniqueKeys: [],
  columns: [
    col('id', 'bigint', 'int8', 'N', pk),
    col('customer_id', 'bigint', 'int8', 'N', { isKey: true, nullable: false, fk: { schema: 'public', table: 'customers', column: 'id' } }),
    col('status', 'order_status', 'order_status', 'E', { typeSchema: 'public', enumValues: ORDER_STATUS, nullable: false }),
    col('total', 'numeric(10,2)', 'numeric', 'N', { nullable: false }),
    col('currency', 'character(3)', 'bpchar', 'S', { nullable: false }),
    col('metadata', 'jsonb', 'jsonb', 'U', { nullable: false }),
    col('tags', 'text[]', 'text', 'S', { isArray: true }),
    col('coupon_code', 'text', 'text', 'S', { isKey: true, fk: { schema: 'public', table: 'coupons', column: 'code' } }),
    tstz('created_at', { nullable: false }),
    tstz('paid_at'),
    tstz('updated_at', { nullable: false }),
    col('notes', 'text', 'text', 'S')
  ]
};

export const ORDER_ITEMS: TableTarget = {
  schema: 'public', name: 'order_items', pk: ['order_id', 'line'], uniqueKeys: [],
  columns: [
    col('order_id', 'bigint', 'int8', 'N', { ...pk, fk: { schema: 'public', table: 'orders', column: 'id' } }),
    col('line', 'integer', 'int4', 'N', pk),
    col('sku', 'text', 'text', 'S', { nullable: false }),
    col('name', 'text', 'text', 'S', { nullable: false }),
    col('quantity', 'integer', 'int4', 'N', { nullable: false }),
    col('unit_price', 'numeric(10,2)', 'numeric', 'N', { nullable: false })
  ]
};

export const WEBHOOK_EVENTS: TableTarget = {
  schema: 'public', name: 'webhook_events', pk: ['id'], uniqueKeys: [],
  columns: [
    col('id', 'bigint', 'int8', 'N', pk),
    col('type', 'text', 'text', 'S', { nullable: false }),
    col('payload', 'jsonb', 'jsonb', 'U', { nullable: false }),
    tstz('received_at', { nullable: false })
  ]
};

/** `"Order ""Items"""`: a table whose name needs every quoting rule, with a column named `Weird Col`. */
export const ODD_ITEMS: TableTarget = {
  schema: 'public', name: 'Order "Items"', pk: ['id'], uniqueKeys: [],
  columns: [
    col('id', 'integer', 'int4', 'N', pk),
    col('Weird Col', 'text', 'text', 'S'),
    col('Qty', 'integer', 'int4', 'N', { nullable: false })
  ]
};

export const EVENTS_NOPK: TableTarget = {
  schema: 'public', name: 'events_nopk', pk: [], uniqueKeys: [],
  columns: [tstz('occurred_at', { nullable: false }), col('kind', 'text', 'text', 'S', { nullable: false }), col('detail', 'jsonb', 'jsonb', 'U')]
};
