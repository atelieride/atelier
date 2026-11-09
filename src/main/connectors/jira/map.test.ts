import { describe, expect, test } from 'vitest';
import { bodyOf, dueOf, htmlToText, issueUrl, priorityLevel, projectRef, projectType, siteOf, timeOf, toDetail, toSummary } from './map';
import type { JiraIssue } from './tools';

// Sites, links, status tones, priorities, dates and bodies.

const SITE = 'https://acme.atlassian.net';
const issue = (f: Partial<JiraIssue['fields']> = {}): JiraIssue => ({
  id: '10103', key: 'ATL-3',
  fields: {
    summary: 'Billing export drops the last row', project: { id: '10001', key: 'ATL', name: 'Atelier', projectTypeKey: 'software' },
    status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } }, ...f
  }
});

describe('sites and links', () => {
  test('only https://<label>.atlassian.net, normalized', () => {
    expect(siteOf('https://acme.atlassian.net')).toBe(SITE);
    expect(siteOf('ACME.atlassian.net')).toBe(SITE);
    expect(siteOf('https://acme.atlassian.net/')).toBe(SITE);
    for (const bad of ['http://acme.atlassian.net', 'https://acme.atlassian.net/jira', 'https://acme.atlassian.net:8443', 'https://u:p@acme.atlassian.net',
      'https://atlassian.net', 'https://acme.atlassian.net.evil.example', 'https://evil.example/acme.atlassian.net', 'https://a.b.atlassian.net', 'https://acme.jira.com', '', null]) {
      expect(siteOf(bad), String(bad)).toBeNull();
    }
  });

  test('issue links are built from the site and a validated key', () => {
    expect(issueUrl(SITE, 'ATL-3')).toBe('https://acme.atlassian.net/browse/ATL-3');
    expect(() => issueUrl(SITE, 'ATL-3/../x')).toThrow();
    expect(() => issueUrl('https://evil.example', 'ATL-3')).toThrow();
  });

  test('a pasted project reference: key, issue key, links on this site; another site is named as such', () => {
    expect(projectRef('ATL', SITE)).toEqual({ key: 'ATL' });
    expect(projectRef(' atl-12 ', SITE)).toEqual({ key: 'ATL' });
    expect(projectRef('https://acme.atlassian.net/browse/SUP-4', SITE)).toEqual({ key: 'SUP' });
    expect(projectRef('https://acme.atlassian.net/jira/software/projects/ATL/boards/1', SITE)).toEqual({ key: 'ATL' });
    expect(projectRef('https://acme.atlassian.net/jira/servicedesk/projects/SUP/queues/custom/1', SITE)).toEqual({ key: 'SUP' });
    expect(projectRef('https://acme.atlassian.net/jira/software/c/projects/WEB/issues', SITE)).toEqual({ key: 'WEB' });
    expect(projectRef('https://other.atlassian.net/browse/ATL-1', SITE)).toBe('other-site');
    for (const bad of ['https://evil.example/browse/ATL-1', 'https://acme.atlassian.net/wiki/spaces/X', 'not a key', '']) expect(projectRef(bad, SITE), bad).toBeNull();
  });

  test('project types', () => {
    expect(projectType('service_desk')).toBe('service_desk');
    expect(projectType('software')).toBe('software');
    expect(projectType('product_discovery')).toBe('other');
    expect(projectType(undefined)).toBe('other');
  });
});

describe('summaries', () => {
  test('key as display id, numeric id as task id, category as state hex, project as list, link from the site', () => {
    expect(toSummary(issue(), SITE)).toEqual({
      id: '10103', displayId: 'ATL-3', title: 'Billing export drops the last row', status: { name: 'To Do' },
      listName: 'Atelier', url: 'https://acme.atlassian.net/browse/ATL-3'
    });
    expect(toSummary(issue({ status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } }), SITE).status).toEqual({ name: 'In Review', color: '#60A5FA' });
    expect(toSummary(issue({ status: { name: 'Shipped', statusCategory: { key: 'done' } } }), SITE).status).toEqual({ name: 'Shipped', color: '#34D399' });
    expect(toSummary(issue({ status: { name: 'Odd', statusCategory: { key: 'undefined' } } }), SITE).status).toEqual({ name: 'Odd' });
  });

  test('due, updated, priority; a title with controls and bidi becomes one clean line', () => {
    const s = toSummary(issue({ summary: 'Fix\u202e evil\nline', duedate: '2026-10-24', updated: '2026-10-19T23:12:16.840+0200', priority: { name: 'High' } }), SITE);
    expect(s.title).toBe('Fix evil line');
    expect(s.due).toBe(new Date(2026, 9, 24).getTime());
    expect(s.updatedAt).toBe(Date.parse('2026-10-19T23:12:16.840+02:00'));
    expect(s.priority).toBe('High');
  });

  test('dates: only real ones', () => {
    expect(dueOf('2026-02-30')).toBeUndefined();
    expect(dueOf('tomorrow')).toBeUndefined();
    expect(dueOf(null)).toBeUndefined();
    expect(timeOf('garbage')).toBeUndefined();
  });

  test('priorities on automations\' scale', () => {
    expect(['Highest', 'High', 'Medium', 'Low', 'Lowest', 'Whatever'].map(priorityLevel)).toEqual(['urgent', 'high', 'normal', 'low', 'low', undefined]);
  });
});

describe('bodies', () => {
  test('Markdown as given, cleaned', () => {
    expect(bodyOf('**Bold**\n\n* one\n* two\u200b', 'markdown')).toBe('**Bold**\n\n* one\n* two');
    expect(bodyOf(null, 'markdown')).toBe('');
  });

  test('HTML (mentions, lists, code, links, entities) to text; scripts and attributes gone', () => {
    const html = '<p>Ping <span data-mention-id="x">@Grace Hopper</span> &amp; check <a href="https://evil.example">this</a></p><ul><li>one</li><li>two</li></ul><pre><code>npm test &lt;x&gt;</code></pre><script>alert(1)</script>';
    expect(htmlToText(html)).toBe('Ping @Grace Hopper & check this\n\n- one\n- two\n\n```\nnpm test <x>\n```');
    expect(bodyOf(html, 'html')).toContain('- one');
    // The other envelope carries no format: HTML is recognized by its shape.
    expect(bodyOf(html, undefined)).not.toMatch(/<\/?(p|span|ul|li|a|pre|code|script)\b/);
    // Markdown with a stray "<" stays Markdown.
    expect(bodyOf('a < b and <c>', 'markdown')).toBe('a < b and <c>');
  });

  test('capped at 32 KB on a character boundary', () => {
    expect(Buffer.byteLength(bodyOf('é'.repeat(40_000), 'markdown'))).toBeLessThanOrEqual(32 * 1024);
  });

  test('a detail is the summary plus the body', () => {
    const d = toDetail({ ...issue({ description: '<p>Hi</p>' }), appliedContentFormat: 'html' }, SITE);
    expect(d).toMatchObject({ id: '10103', displayId: 'ATL-3', body: 'Hi' });
  });
});
