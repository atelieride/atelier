import type { APIRoute } from 'astro';
import { config } from '../config';
import { bento, rows, yourMac } from '../content/features';
import { llmsTxt } from '../lib/llms';

// For AI assistants, from the same copy as the pages.
export const GET: APIRoute = () => new Response(llmsTxt(config, { yourMac, rows, bento }), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
