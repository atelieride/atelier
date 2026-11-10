import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// `deploy` and `stats` act on the site's own Cloudflare account. A shell often exports CLOUDFLARE_API_TOKEN for other
// work, on another account: read here, it would win over the Keychain item and wrangler would fail to authenticate, or
// act on the wrong account. Only the ATELIER_-prefixed variables override the Keychain items.
const site = join(__dirname, '../..');
const deploy = (JSON.parse(readFileSync(join(site, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.deploy!;
const stats = readFileSync(join(site, 'scripts/stats.mjs'), 'utf8');

test('deploy reads its token and account from ATELIER_CLOUDFLARE_* or the Keychain, never from the generic variables', () => {
  expect(deploy).not.toMatch(/\$\{?CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)\b/);
  expect(deploy).toContain('${ATELIER_CLOUDFLARE_API_TOKEN:-$(security find-generic-password -s atelier-cloudflare-mcp -w)}');
  expect(deploy).toContain('${ATELIER_CLOUDFLARE_ACCOUNT_ID:-$(security find-generic-password -s atelier-cloudflare-account -w)}');
});

test('stats reads its token and account from ATELIER_CLOUDFLARE_* or the Keychain, never from the generic variables', () => {
  expect(stats).not.toMatch(/process\.env\.CLOUDFLARE_/);
  expect(stats).toContain("process.env.ATELIER_CLOUDFLARE_API_TOKEN || keychain('atelier-cloudflare-mcp')");
  expect(stats).toContain("process.env.ATELIER_CLOUDFLARE_ACCOUNT_ID || keychain('atelier-cloudflare-account')");
});
