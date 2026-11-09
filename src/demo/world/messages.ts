// What ✦ writes in the live demo: the sessions' work in the fictional acme-store, one
// conventional commit message each, as Claude would write it from the staged diff and what the session was asked. The
// demo picks by the staged paths (bridge/git-write.ts); no model runs in a browser.

export interface DemoCommitMessage {
  /** The paths this work touches: a folder (ending in /) or a file. */
  paths: string[];
  subject: string;
  /** Wrapped at 72, as the system prompt asks. */
  body: string;
  /** One line for a commit that holds several sessions' work. */
  line: string;
}

export const COMMIT_MESSAGES: readonly DemoCommitMessage[] = [
  {
    paths: ['src/auth/'],
    subject: 'refactor(auth): read sessions through the token store',
    body: 'Allow 30 s of clock skew when a session expires and drop the expired\ntoken from the store, so a stale token is never read twice.',
    line: 'Read sessions through the token store, dropping expired tokens.'
  },
  {
    paths: ['src/billing/', 'tests/billing.test.ts'],
    subject: 'test(billing): cover rounding and currencies',
    body: 'Check that invoice totals round to the cent after tax, so a 0.1 unit\nprice never adds up to 0.30000000000000004.',
    line: 'Cover rounding to the cent in invoice totals.'
  },
  {
    paths: ['src/pages/'],
    subject: 'feat(onboarding): make the welcome page friendlier',
    body: 'Greet returning customers by name and link straight back to the cart\nthey left.',
    line: 'Make the welcome page friendlier, with a link back to the cart.'
  },
  {
    paths: ['prisma/'],
    subject: 'feat(orders): add a status column to orders',
    body: 'New orders start as pending; the migration adds the OrderStatus enum\nand backfills the orders already there.',
    line: 'Add an order status column and its migration.'
  },
  {
    paths: ['README.md'],
    subject: 'docs: document the checkout flow',
    body: 'Describe how the cart is checked against stock and when payment is\nauthorised and captured.',
    line: 'Document the checkout flow.'
  }
];

/** Nothing staged that the world knows: the invoices' totals, as before staging existed in the demo. */
export const FALLBACK_MESSAGE = 'feat(invoices): show totals on the welcome page\n\nSum each invoice\'s line items and show the total under it.';
