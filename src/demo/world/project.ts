// The website's fictional project: a small TypeScript web shop with an invented author.
// Pure data, shared by the screenshots (tests/e2e/site-shots/demo-project.ts writes it to disk and commits it) and the
// browser demo (an in-memory filesystem and git history), so the two cannot drift.

export const PROJECT_NAME = 'acme-store';
export const AUTHOR = { name: 'Ada Lovelace', email: 'ada@example.com' };

export const FILES: Record<string, string> = {
  'package.json': '{\n  "name": "acme-store",\n  "private": true,\n  "scripts": { "dev": "vite", "test": "vitest run" }\n}\n',
  'README.md': '# acme-store\n\nThe Acme online store: catalog, cart, checkout and invoices.\n',
  'src/auth/session.ts': "import { TokenStore } from './tokens';\n\nexport interface Session {\n  userId: string;\n  expiresAt: number;\n}\n\nconst store = new TokenStore();\n\nexport function readSession(token: string): Session | null {\n  const entry = store.get(token);\n  if (!entry || entry.expiresAt < Date.now()) return null;\n  return { userId: entry.userId, expiresAt: entry.expiresAt };\n}\n",
  'src/auth/tokens.ts': "export class TokenStore {\n  private entries = new Map<string, { userId: string; expiresAt: number }>();\n\n  get(token: string) {\n    return this.entries.get(token);\n  }\n\n  set(token: string, userId: string, ttlMs: number) {\n    this.entries.set(token, { userId, expiresAt: Date.now() + ttlMs });\n  }\n}\n",
  'src/billing/invoice.ts': "export interface LineItem { sku: string; quantity: number; unitPrice: number }\n\nexport function invoiceTotal(items: LineItem[], taxRate: number): number {\n  const net = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);\n  return Math.round(net * (1 + taxRate) * 100) / 100;\n}\n",
  'src/pages/welcome.tsx': "export function Welcome({ name }: { name: string }) {\n  return (\n    <main>\n      <h1>Welcome to Acme, {name}</h1>\n      <p>Your cart is ready when you are.</p>\n    </main>\n  );\n}\n",
  'prisma/schema.prisma': 'model Order {\n  id        String   @id @default(cuid())\n  createdAt DateTime @default(now())\n  total     Decimal\n}\n',
  'tests/billing.test.ts': "import { expect, test } from 'vitest';\nimport { invoiceTotal } from '../src/billing/invoice';\n\ntest('adds tax', () => {\n  expect(invoiceTotal([{ sku: 'A1', quantity: 2, unitPrice: 10 }], 0.2)).toBe(24);\n});\n"
};

export interface Commit { message: string; files: string[] }

/** The history on `main`, oldest first: every file of FILES lands in exactly one commit. */
export const COMMITS: Commit[] = [
  { message: 'Start the Acme store', files: ['package.json', 'README.md'] },
  {
    message: 'Add sessions, invoices and the welcome page',
    files: ['src/auth/session.ts', 'src/auth/tokens.ts', 'src/billing/invoice.ts', 'src/pages/welcome.tsx', 'prisma/schema.prisma']
  },
  { message: 'Test invoice totals', files: ['tests/billing.test.ts'] }
];
