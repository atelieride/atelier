// Jira issues as Atelier's tasks. Main only. Text is untrusted: titles become one clean
// line, bodies are cleaned and capped (the prompt builder fences them as data), status colors pass only as one of our
// state hexes (from the status category, never Jira's own colors), and links are built from the saved site and a
// validated key — never taken from a reply.
import { cleanText } from '@shared/clean-text';
import { MAX_TASK_BODY_BYTES, type JiraProjectType, type TaskDetail, type TaskSummary } from '@shared/tasks';
import { capUtf8, oneLine } from '../text';
import { ISSUE_KEY, PROJECT_KEY, SITE_URL, type JiraIssue } from './tools';

/** Jira's status categories as the `#rrggbb` a TaskStatus carries: exactly theme.css's state tokens (To Do: none, idle). */
const CATEGORY_HEX: Readonly<Record<string, string>> = Object.freeze({ indeterminate: '#60A5FA', done: '#34D399' });

/** A site URL as saved: `https://<label>.atlassian.net`, lowercase, nothing after the host; null when it isn't one. */
export function siteOf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  const site = `https://${u.hostname.toLowerCase()}`;
  return SITE_URL.test(site) ? site : null;
}

/** The host shown as the connection's name ("acme.atlassian.net"). */
export const hostOf = (site: string): string => new URL(site).hostname;

export function issueUrl(site: string, key: string): string {
  if (!SITE_URL.test(site) || !ISSUE_KEY.test(key)) throw new TypeError('not a Jira site and key');
  return `${site}/browse/${key}`;
}

export function projectType(raw: string | undefined): JiraProjectType {
  return raw === 'software' || raw === 'business' || raw === 'service_desk' ? raw : 'other';
}

/** Jira's priority names on automations' scale (Highest → urgent … Lowest → low); others have none. */
export function priorityLevel(name: string | undefined): 'urgent' | 'high' | 'normal' | 'low' | undefined {
  switch (name?.trim().toLowerCase()) {
    case 'highest': case 'blocker': case 'critical': return 'urgent';
    case 'high': case 'major': return 'high';
    case 'medium': return 'normal';
    case 'low': case 'lowest': case 'minor': case 'trivial': return 'low';
    default: return undefined;
  }
}

/** `duedate` (yyyy-MM-dd) at local midnight, what the palette's day labels expect. */
export function dueOf(raw: string | null | undefined): number | undefined {
  const d = raw ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
  if (!d) return undefined;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const at = new Date(y, m - 1, day);
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === day ? at.getTime() : undefined;
}

/** Jira's timestamps ("2026-10-19T23:12:16.840+0200") as ms; the offset gets the colon ISO wants. */
export function timeOf(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : undefined;
}

export function toSummary(i: JiraIssue, site: string): TaskSummary {
  const f = i.fields;
  const color = f.status?.statusCategory ? CATEGORY_HEX[f.status.statusCategory.key] : undefined;
  const out: TaskSummary = {
    id: i.id, displayId: i.key, title: oneLine(f.summary) || i.key,
    status: { name: oneLine(f.status?.name, 100), ...(color ? { color } : {}) },
    listName: oneLine(f.project.name, 200), url: issueUrl(site, i.key)
  };
  const priority = oneLine(f.priority?.name, 60);
  if (priority) out.priority = priority;
  const due = dueOf(f.duedate);
  if (due !== undefined) out.due = due;
  const updatedAt = timeOf(f.updated);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  return out;
}

/** HTML from Jira (a description Markdown can't hold: mentions, media, panels): bounded tags to text, nothing else. */
export function htmlToText(html: string): string {
  const s = html.slice(0, 256 * 1024)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<pre\b[^>]*>\s*(?:<code\b[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi, (_m, code: string) => `\n\`\`\`\n${code.replace(/<[^>]*>/g, '')}\n\`\`\`\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|tr|table|section)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|blockquote|tr|table|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const looksHtml = (s: string) => /^\s*</.test(s) && /<\/?(p|div|span|ul|ol|li|pre|code|a|br|h[1-6]|table)\b/i.test(s);

/** The description as the prompt's body: Markdown as Jira gives it, HTML reduced to text; cleaned, 32 KB at most. */
export function bodyOf(description: string | null | undefined, format: string | undefined): string {
  if (!description) return '';
  const text = format === 'html' || (format === undefined && looksHtml(description)) ? htmlToText(description) : description;
  return capUtf8(cleanText(text), MAX_TASK_BODY_BYTES);
}

export function toDetail(i: JiraIssue & { appliedContentFormat?: string | undefined }, site: string): TaskDetail {
  return { ...toSummary(i, site), body: bodyOf(i.fields.description, i.appliedContentFormat) };
}

/**
 * A pasted project reference: a key ("ATL"), an issue key ("ATL-12") or a link on this site (…/browse/ATL-12,
 * …/projects/ATL, …/jira/software/projects/ATL/boards/1, …/jira/servicedesk/projects/SUP/queues). `other-site`: a link
 * to another Jira site. Null: not a project reference.
 */
export function projectRef(raw: string, site: string): { key: string } | 'other-site' | null {
  const s = raw.trim();
  const bare = s.toUpperCase();
  if (PROJECT_KEY.test(bare)) return { key: bare };
  if (ISSUE_KEY.test(bare)) return { key: bare.slice(0, bare.lastIndexOf('-')) };
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const origin = siteOf(u.origin);
  if (!origin) return null;
  if (origin !== site) return 'other-site';
  const m = /^\/(?:browse\/([A-Z][A-Z0-9_]{0,19})-\d+|(?:jira\/(?:software|servicedesk|core|business)\/(?:c\/)?)?projects\/([A-Z][A-Z0-9_]{0,19}))(?:[/?#]|$)/i.exec(u.pathname);
  const key = (m?.[1] ?? m?.[2])?.toUpperCase();
  return key && PROJECT_KEY.test(key) ? { key } : null;
}
