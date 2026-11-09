// The five Claude sessions of the website's fictional project: what each was asked,
// what its terminal shows, the edits it makes to the project, the state it ends in and its background work. Played by
// tests/e2e/fake-claude-demo.pl for the screenshots (site-shots.manual.ts hands it this object as JSON) and by the
// browser demo's engine.

import type { WorldAccount } from './accounts';

/** Claude Code's states the sessions end in (the bottom of the screen and the hook events follow from it). */
export type ScenarioState = 'permission' | 'question' | 'working' | 'done';

export interface ScenarioEdit { file: string; content: string }

/** A background agent's transcript step: a tool call with its result (text, or a line count for reads), or a text. */
export type AgentStep =
  | { tool: string; input: Record<string, string>; result: string | number; error?: boolean }
  | { text: string };

export interface BackgroundAgent { id: string; description: string; type?: string; task: string; steps: AgentStep[] }
export interface BackgroundShell { id: string; description: string; command: string; output: string[]; exit?: number }
export interface BackgroundCron { id: string; schedule: string; recurring: boolean; prompt: string }

export interface Scenario {
  prompt: string;
  /** The terminal's transcript, one line each, with ANSI styles. */
  transcript: string[];
  edits: ScenarioEdit[];
  state: ScenarioState;
  /** `permission`: the Bash command asked for. */
  command?: string;
  /** `question`: the choices offered. */
  options?: string[];
  /** `working`: the spinner's text and how many subagents run. */
  spinner?: string;
  agents?: number;
  /** The status line: cost in USD, lines added/removed, context used (%). */
  cost: number;
  added: number;
  removed: number;
  context: number;
  background?: { agents?: BackgroundAgent[]; shells?: BackgroundShell[]; crons?: BackgroundCron[] };
  /** The Claude account it runs as (world/accounts.ts); absent: the default one. */
  account?: Exclude<WorldAccount['id'], 'default'>;
}

export type ScenarioName = 'auth-refactor' | 'billing-tests' | 'onboarding-copy' | 'db-migration' | 'docs';

/** By session name, in the screenshots' sidebar order. */
export const SCENARIOS: Record<ScenarioName, Scenario> = {
  "auth-refactor": {
    "prompt": "Move sessions to the token store",
    "transcript": [
      "\u001b[35m>\u001b[0m Move sessions to the token store",
      "",
      "\u001b[1m●\u001b[0m Read(src/auth/session.ts)",
      "  \u001b[2m⎿  Read 15 lines\u001b[0m",
      "",
      "\u001b[1m●\u001b[0m Update(src/auth/session.ts)",
      "  \u001b[2m⎿  \u001b[32m+7\u001b[0m \u001b[31m-2\u001b[0m\u001b[2m  expiry with clock skew\u001b[0m",
      "",
      "\u001b[1m●\u001b[0m Sessions now expire through",
      "  the token store. Let me run the",
      "  auth tests."
    ],
    "edits": [{ "file": "src/auth/session.ts", "content": "import { TokenStore } from './tokens';\n\nexport interface Session {\n  userId: string;\n  expiresAt: number;\n}\n\nconst store = new TokenStore();\nconst SKEW_MS = 30_000;\n\nexport function readSession(token: string, now = Date.now()): Session | null {\n  const entry = store.get(token);\n  if (!entry) return null;\n  if (entry.expiresAt - SKEW_MS < now) {\n    store.delete(token);\n    return null;\n  }\n  return { userId: entry.userId, expiresAt: entry.expiresAt };\n}\n" }],
    "state": "permission", "command": "npm test -- auth", "cost": 1.84, "added": 7, "removed": 2, "context": 41
  },
  "billing-tests": {
    "prompt": "Cover rounding and currencies",
    "transcript": [
      "\u001b[35m>\u001b[0m Cover rounding and currencies",
      "",
      "\u001b[1m●\u001b[0m 2 Explore agents",
      "  \u001b[2m⎿  rounding edge cases\u001b[0m",
      "  \u001b[2m⎿  currency handling\u001b[0m",
      "",
      "\u001b[1m●\u001b[0m Update(tests/billing.test.ts)",
      "  \u001b[2m⎿  \u001b[32m+4\u001b[0m\u001b[2m  rounds to cents\u001b[0m"
    ],
    "edits": [{ "file": "tests/billing.test.ts", "content": "import { expect, test } from 'vitest';\nimport { invoiceTotal } from '../src/billing/invoice';\n\ntest('adds tax', () => {\n  expect(invoiceTotal([{ sku: 'A1', quantity: 2, unitPrice: 10 }], 0.2)).toBe(24);\n});\n\ntest('rounds to cents', () => {\n  expect(invoiceTotal([{ sku: 'B2', quantity: 3, unitPrice: 0.1 }], 0)).toBe(0.3);\n});\n" }],
    "state": "working", "spinner": "Writing tests…", "agents": 2, "cost": 0.92, "added": 4, "removed": 0, "context": 27,
    "background": {
      "agents": [
        {
          "id": "a1", "description": "rounding edge cases",
          "task": "Find where invoice totals are rounded and list the edge cases our tests miss: halves, refunds, many small items.",
          "steps": [
            { "tool": "Grep", "input": { "pattern": "Math.round", "path": "src" }, "result": "src/billing/invoice.ts" },
            { "tool": "Read", "input": { "file_path": "src/billing/invoice.ts" }, "result": 6 },
            { "tool": "Read", "input": { "file_path": "tests/billing.test.ts" }, "result": 10 },
            { "tool": "Grep", "input": { "pattern": "toBeCloseTo", "path": "tests" }, "result": "No matches found" },
            { "text": "invoiceTotal rounds once, after tax. Untested: x.xx5 halves, refunds with negative quantities, and many 0.1 items adding up." },
            { "tool": "Read", "input": { "file_path": "src/billing/discounts.ts" }, "result": 24 }
          ]
        },
        {
          "id": "a2", "description": "currency formats",
          "task": "Check how amounts are formatted per currency and whether invoices assume two decimals.",
          "steps": [
            { "tool": "Grep", "input": { "pattern": "currency", "path": "src" }, "result": "src/billing/format.ts\nsrc/pages/cart.tsx" },
            { "tool": "Read", "input": { "file_path": "src/billing/format.ts" }, "result": 18 },
            { "tool": "Grep", "input": { "pattern": "Intl.NumberFormat", "path": "src" }, "result": "src/billing/format.ts" }
          ]
        }
      ],
      "shells": [
        {
          "id": "b7k2m9q4x", "description": "Run billing tests", "command": "npm test -- billing",
          "output": [
            "> acme-store@0.1.0 test",
            "> vitest run billing",
            "",
            " RUN  v3.2.4",
            "",
            " ✓ tests/billing.test.ts (2)",
            "   ✓ adds tax",
            "   ✓ rounds to cents",
            " ✓ tests/billing/currency.test.ts (4)",
            "   ✓ formats EUR with two decimals",
            "   ✓ formats JPY without decimals",
            "   ✓ formats CHF amounts",
            "   ✓ keeps the sign of refunds",
            " ❯ tests/billing/rounding.test.ts (4)",
            "   ✓ rounds after tax, not per line",
            "   ✓ sums many small items exactly",
            "   × rounds half up on x.xx5",
            "     → expected 10.01 to be 10.02",
            "   ✓ rounds refunds like charges",
            " ✓ tests/billing/discounts.test.ts (3)",
            "   ✓ applies a percentage discount",
            "   ✓ never goes below zero",
            "   ✓ stacks a coupon on a sale",
            " ✓ tests/billing/tax.test.ts (3)",
            "   ✓ applies the reduced rate"
          ]
        }
      ]
    }
  },
  "onboarding-copy": {
    "prompt": "Make the welcome page friendlier",
    "transcript": [
      "\u001b[35m>\u001b[0m Make the welcome page friendlier",
      "",
      "\u001b[1m●\u001b[0m Update(src/pages/welcome.tsx)",
      "  \u001b[2m⎿  \u001b[32m+3\u001b[0m \u001b[31m-2\u001b[0m\u001b[2m  warmer greeting\u001b[0m",
      "",
      "\u001b[1m●\u001b[0m Done. Returning customers are",
      "  greeted by name, with a link",
      "  back to their cart."
    ],
    "edits": [{ "file": "src/pages/welcome.tsx", "content": "export function Welcome({ name }: { name: string }) {\n  return (\n    <main>\n      <h1>Good to see you, {name}</h1>\n      <p>Your cart is right where you left it.</p>\n      <a href=\"/cart\">Continue shopping</a>\n    </main>\n  );\n}\n" }],
    "state": "done", "cost": 0.41, "added": 3, "removed": 2, "context": 18
  },
  "db-migration": {
    "prompt": "Add a status column to orders",
    "transcript": [
      "\u001b[35m>\u001b[0m Add a status column to orders",
      "",
      "\u001b[1m●\u001b[0m Read(prisma/schema.prisma)",
      "  \u001b[2m⎿  Read 5 lines\u001b[0m",
      "",
      "\u001b[1m●\u001b[0m Adding an enum and a migration:",
      "",
      "  \u001b[35menum\u001b[0m \u001b[36mOrderStatus\u001b[0m {",
      "    pending",
      "    paid",
      "    shipped",
      "  }",
      "",
      "  \u001b[35mmodel\u001b[0m \u001b[36mOrder\u001b[0m {",
      "    ...",
      "    status \u001b[36mOrderStatus\u001b[0m",
      "  }",
      "",
      "\u001b[1m●\u001b[0m Orders already in the database",
      "  need a status. Which one should",
      "  they get?"
    ],
    "edits": [],
    "options": ["paid", "pending", "Type something"],
    "state": "question", "cost": 0.23, "added": 0, "removed": 0, "context": 12
  },
  "docs": {
    "prompt": "Document the checkout flow",
    "transcript": [
      "\u001b[35m>\u001b[0m Document the checkout flow",
      "",
      "\u001b[1m●\u001b[0m Update(README.md)",
      "  \u001b[2m⎿  \u001b[32m+5\u001b[0m\u001b[2m  checkout section\u001b[0m"
    ],
    "edits": [{ "file": "README.md", "content": "# acme-store\n\nThe Acme online store: catalog, cart, checkout and invoices.\n\n## Checkout\n\n1. The cart is validated against current stock.\n2. Payment is authorised, then captured when the order ships.\n" }],
    "state": "working", "spinner": "Writing docs…", "agents": 0, "cost": 0.37, "added": 5, "removed": 0, "context": 15,
    "account": "work",
    "background": {
      "crons": [{ "id": "c1", "schedule": "*/30 * * * *", "recurring": true, "prompt": "check the preview deploy" }]
    }
  }
};
