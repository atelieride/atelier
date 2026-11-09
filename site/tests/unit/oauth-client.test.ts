import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The app's OAuth client, published as a Client ID Metadata Document (CIMD, draft-ietf-oauth-client-id-metadata-
// document): an authorization server that supports it (Atlassian) fetches this file and the URL itself is the
// client_id, so the app registers nothing and ships no secret. It is public by design: it may only describe a public
// native client whose redirects come back to the user's own Mac.

const URL_ = 'https://useatelier.dev/oauth/client.json';
const doc = JSON.parse(readFileSync(join(__dirname, '../../public/oauth/client.json'), 'utf8')) as Record<string, unknown>;

test('the client_id is the document\'s own URL', () => {
  expect(doc.client_id).toBe(URL_);
});

test('a public native client: no secret, no key, authorization code + refresh only', () => {
  expect(doc.token_endpoint_auth_method).toBe('none');
  expect(doc.application_type).toBe('native');
  expect(doc.grant_types).toEqual(['authorization_code', 'refresh_token']);
  expect(doc.response_types).toEqual(['code']);
  for (const k of ['client_secret', 'jwks', 'jwks_uri']) expect(doc).not.toHaveProperty(k);
});

test('redirects only to the loopback listener on 127.0.0.1, over plain http, at /callback', () => {
  const uris = doc.redirect_uris as string[];
  expect(uris.length).toBeGreaterThan(0);
  for (const u of uris) {
    const p = new URL(u);
    expect(p.protocol, u).toBe('http:');
    expect(p.hostname, u).toBe('127.0.0.1');
    expect(p.pathname, u).toBe('/callback');
    expect(p.search + p.hash + p.username + p.password, u).toBe('');
  }
});

test('names the app and points only at useatelier.dev', () => {
  expect(doc.client_name).toBe('Atelier');
  for (const k of ['client_uri', 'logo_uri', 'policy_uri']) {
    expect(new URL(doc[k] as string).origin, k).toBe('https://useatelier.dev');
  }
});
