// Notion ids and pasted links (Review Focus 2), one rule for both sides: main parses the link it
// is asked to add (markup.ts and tools.ts re-export these), the Settings picker only uses it to offer "Add this
// database" and never fetches anything itself. Pure.

/** A Notion id: 32 hex digits, dashes optional (uuid form), any case. */
export const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** 32 lowercase hex for a Notion id (with or without dashes, any case); anything else → null. */
export function notionId(s: string): string | null {
  return NOTION_ID.test(s) ? s.replace(/-/g, '').toLowerCase() : null;
}

const LINK_HOSTS = new Set(['notion.so', 'www.notion.so', 'notion.com', 'www.notion.com', 'app.notion.com']);
const SITE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.notion\.site$/;
const ID_AT_END = /(?:^|-)([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The 32-hex id in a pasted Notion link or id: a bare id (dashes allowed), or an https link (the scheme may be left
 * out) on notion.so, notion.com (www. or app.) or <workspace>.notion.site whose last path segment is the id (32 hex or
 * a dashed uuid) or ends in "-<id>". The query (`?v=<view id>`, `&p=`) and the hash are ignored: the view's id is
 * never taken. Else null.
 */
export function notionIdFromLink(s: string): string | null {
  const t = s.trim();
  if (!t || t.length > 2000) return null;
  const bare = notionId(t);
  if (bare) return bare;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
  } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!LINK_HOSTS.has(host) && !SITE_HOST.test(host)) return null;
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  const m = ID_AT_END.exec(last);
  return m ? notionId(m[1]!) : null;
}
