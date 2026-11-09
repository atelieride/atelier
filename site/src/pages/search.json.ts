import type { APIRoute } from 'astro';
import md from '../../../CHANGELOG.md?raw';
import { bento, keys, rows } from '../content/features';
import { renderReleases } from '../lib/releases';
import { buildIndex } from '../lib/search';

// The header's search index: a static file, fetched on first open.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(buildIndex({ rows, bento, keys, releases: await renderReleases(md) })), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
