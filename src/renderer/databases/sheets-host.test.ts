import { afterEach, expect, test, vi } from 'vitest';
import { DbSheetsHost } from './DbSheetsHost';
import { useDb } from './store';
import { renderLive } from './test-render';

// The one host both windows mount: the sheets' chunk loads only once a sheet
// opens, and draws it from then on.

const loads = vi.hoisted(() => ({ n: 0 }));
vi.mock('./ConnectionSheet', async () => {
  loads.n++;
  const { createElement } = await import('react');
  return { DbSheets: () => createElement('i', { id: 'db-sheets' }) };
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

afterEach(() => useDb.setState(useDb.getInitialState(), true));

test('no sheet: nothing drawn, nothing loaded; a sheet: its chunk loads, then the sheets draw', async () => {
  expect(renderLive(DbSheetsHost)).toBe('');
  await settle();
  expect(loads.n).toBe(0);

  useDb.setState({ sheet: { kind: 'add', step: 1 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(renderLive(DbSheetsHost)).not.toContain('db-sheets'); // still loading: the empty fallback
  await settle();
  expect(loads.n).toBe(1);
  expect(renderLive(DbSheetsHost)).toContain('id="db-sheets"');

  useDb.setState({ sheet: null });
  expect(renderLive(DbSheetsHost)).toBe('');
});
