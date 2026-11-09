import { afterEach, expect, test, vi } from 'vitest';
import { copyText } from './clipboard';
import { useApp } from './store';

const g = globalThis as { window?: unknown };
afterEach(() => { delete g.window; useApp.setState({ toast: null }); });

test('Copy over the clipboard limit says so instead of failing silently (the editor menu\'s Copy too)', async () => {
  const write = vi.fn((text: string) => Promise.resolve(text.length < 10));
  g.window = { atelier: { clipboard: { write } } };
  await copyText('short');
  expect(useApp.getState().toast).toBeNull();
  await copyText('x'.repeat(20));
  expect(write).toHaveBeenCalledTimes(2);
  expect(useApp.getState().toast?.text).toBe('Too large to copy (over 16 MB).');
});
