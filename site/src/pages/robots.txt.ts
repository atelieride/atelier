import type { APIRoute } from 'astro';
import { config } from '../config';
import { robotsTxt } from '../lib/seo';

export const GET: APIRoute = () => new Response(robotsTxt(config), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
