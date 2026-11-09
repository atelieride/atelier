import { afterEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SheetFrame } from './SheetFrame';
import { openerOf } from './sheet-keys';

// Where the focus goes back when a sheet closes: what had it as the sheet first rendered. A child's
// mount effect runs before the frame's own, so a frame that read the focus in its effect found it already inside the
// sheet and gave it back to nothing. A server render runs no effect: only a read made while rendering shows here.

afterEach(() => vi.unstubAllGlobals());

test('the opener is read as the frame renders, before any of its children (whose mount effects run before the frame\'s)', () => {
  const log: string[] = [];
  const opener = { focus: () => {}, isConnected: true };
  vi.stubGlobal('document', { get activeElement() { log.push('read'); return opener; } });
  function Child() {
    log.push('child');
    return null;
  }
  renderToStaticMarkup(createElement(SheetFrame, { title: 'Add Connection', icon: 'databases', onClose: () => {}, children: createElement(Child) }));
  expect(log[0]).toBe('read');
  expect(log).toContain('child');
});

test('the opener: what had the focus as the sheet rendered; that one gone by its mount (a menu\'s item, which gave the focus back to its own opener), what has it then, unless already inside', () => {
  const el = (connected: boolean) => ({ isConnected: connected });
  const row = el(true);
  const item = el(false);
  const field = el(true);
  const inside = (e: unknown) => e === field;
  expect(openerOf(row, field, inside)).toBe(row);
  expect(openerOf(item, row, inside)).toBe(row);
  expect(openerOf(item, field, inside)).toBeNull();
  expect(openerOf(null, row, inside)).toBe(row);
  expect(openerOf(null, null, inside)).toBeNull();
});

test('without a document (a server render) the frame still draws', () => {
  const out = renderToStaticMarkup(createElement(SheetFrame, { title: 'T', icon: 'databases', onClose: () => {}, children: 'body' }));
  expect(out).toContain('role="dialog"');
});
