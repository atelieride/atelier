import type { APIRoute } from 'astro';
import { config } from '../config';
import { sitemapXml } from '../lib/seo';

export const GET: APIRoute = () => new Response(sitemapXml(config), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
