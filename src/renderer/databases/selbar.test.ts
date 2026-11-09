import { describe, expect, test, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MenuItem } from '../menu-model';
import { formatsMenu, SelBar, type SelBarProps } from './SelBar';

// The grid's action bar: "N rows" · Send to <session> ⌥↩ · Ask in New
// Session · Copy as JSON ▾ (JSON, CSV, Markdown, SQL INSERT) · ×. Floating over the grid's foot, clear of the footer,
// the scrollbars and an inspector lying over the rows; its labels fold to icons (with tooltips) in a narrow grid.

const props = (o: Partial<SelBarProps> = {}): SelBarProps => ({
  count: 2, target: 'db-migration', right: 0, bottom: 0, formatsOpen: false,
  onSend: vi.fn(), onAsk: vi.fn(), onCopy: vi.fn(), onFormats: vi.fn(), onClear: vi.fn(), ...o
});
const html = (o: Partial<SelBarProps> = {}) => renderToStaticMarkup(createElement(SelBar, props(o)));

type Host = ReactElement<Record<string, unknown>>;
function hosts(node: ReactNode, out: Host[] = []): Host[] {
  if (Array.isArray(node)) {
    for (const n of node) hosts(n as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as Host;
  if (typeof el.type === 'function') return hosts((el.type as (p: unknown) => ReactNode)(el.props), out);
  if (typeof el.type === 'string') out.push(el);
  return hosts(el.props.children as ReactNode, out);
}
const button = (p: SelBarProps, label: string) => hosts(createElement(SelBar, p)).find((e) => e.type === 'button' && e.props['aria-label'] === label)!;

describe('the action bar', () => {
  test('a toolbar named by the count: "N rows", then Send to <session> with ⌥↩, Ask in New Session, Copy as JSON ▾, Clear', () => {
    const out = html();
    expect(out).toMatch(/^<div class="db-selwrap"[^>]*><div class="db-selbar" role="toolbar" aria-label="2 rows">/);
    expect(out).toContain('<span class="db-selbar-n">2 rows</span>');
    expect(out).toMatch(/<button type="button" class="btn-primary sm sel-send" aria-label="Send to db-migration" data-tip="Send to db-migration: typed into its prompt, not sent">/);
    expect(out).toContain('<span class="dk-ellipsis db-sel-label">Send to db-migration</span><span class="kbd-in">⌥↩</span>');
    expect(out).toMatch(/aria-label="Ask in New Session" data-tip="Ask in New Session">[\s\S]*?<span class="db-sel-label">Ask in New Session<\/span>/);
    expect(out).toMatch(/aria-label="Copy as JSON" data-tip="Copy as JSON">[\s\S]*?<span class="db-sel-label">Copy as JSON<\/span>/);
    expect(out).toMatch(/class="btn-ghost sm db-split-more" aria-label="Copy as…" data-tip="Copy as JSON, CSV, Markdown or SQL INSERT" aria-haspopup="menu" aria-expanded="false"/);
    expect(out).toMatch(/class="icon-btn db-selbar-x" aria-label="Clear selection" data-tip="Clear selection"/);
    expect(html({ count: 1 })).toContain('<span class="db-selbar-n">1 row</span>');
    expect(html({ count: 1200 })).toContain('<span class="db-selbar-n">1,200 rows</span>');
    expect(html({ formatsOpen: true })).toContain('aria-haspopup="menu" aria-expanded="true"');
    // Send's own icon, shown only once its label folds away in a narrow grid (selbar.css).
    expect(html()).toMatch(/<span class="db-sel-icon"><svg[\s\S]*?<\/svg><\/span><span class="dk-ellipsis db-sel-label">/);
  });

  test('no session to send to: Send disabled, its tooltip says why (the Docker and Redis bars\' words), no ⌥↩ hint', () => {
    const out = html({ target: null });
    expect(out).toMatch(/<button type="button" class="btn-primary sm sel-send" aria-label="Send to a session" data-tip="No Claude session to send to: start one first." disabled="">/);
    expect(out).toContain('<span class="dk-ellipsis db-sel-label">Send to a session</span>');
    expect(out).not.toContain('kbd-in');
  });

  test('every button does its own thing', () => {
    const p = props();
    (button(p, 'Send to db-migration').props.onClick as () => void)();
    (button(p, 'Ask in New Session').props.onClick as () => void)();
    (button(p, 'Copy as JSON').props.onClick as () => void)();
    (button(p, 'Clear selection').props.onClick as () => void)();
    const at = { currentTarget: { id: 'chevron' } };
    (button(p, 'Copy as…').props.onClick as (e: unknown) => void)(at);
    expect(p.onSend).toHaveBeenCalledTimes(1);
    expect(p.onAsk).toHaveBeenCalledTimes(1);
    expect(p.onCopy).toHaveBeenCalledWith('json');
    expect(p.onClear).toHaveBeenCalledTimes(1);
    expect(p.onFormats).toHaveBeenCalledWith(at);
  });

  test('Copy as ▾: JSON, CSV, Markdown, SQL INSERT, each copying its format', () => {
    const copy = vi.fn();
    const items = formatsMenu(copy).filter((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep');
    expect(items.map((i) => i.label)).toEqual(['JSON', 'CSV', 'Markdown', 'SQL INSERT']);
    for (const i of items) i.run();
    expect(copy.mock.calls.map((c) => c[0])).toEqual(['json', 'csv', 'markdown', 'insert']);
  });

  test('clear of what it floats over: the grid\'s scrollbars and an inspector lying over the rows\' right side', () => {
    expect(html()).toMatch(/^<div class="db-selwrap" style="right:0;bottom:0">/);
    expect(html({ right: 340, bottom: 8 })).toMatch(/^<div class="db-selwrap" style="right:340px;bottom:8px">/);
  });
});
