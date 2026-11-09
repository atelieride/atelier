import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
const tmux = vi.hoisted(() => ({ listPanes: vi.fn(async () => ({ status: 'ok' as const, panes: [] })), capturePane: vi.fn(async () => [] as string[]) }));
vi.mock('./tmux/panes', () => tmux);
import type { WebContents } from 'electron';
import { ServicesHub } from './services-hub';

// Services (tmux) is off until turned on in Settings › Appearance (2026-11-02): off, Atelier never runs tmux.

const wc = () => {
  const sent: [string, unknown][] = [];
  return { sent, w: { id: 1, isDestroyed: () => false, send: (c: string, p: unknown) => { sent.push([c, p]); }, once: () => {} } as unknown as WebContents };
};

beforeEach(() => { vi.useFakeTimers(); tmux.listPanes.mockClear(); });
afterEach(() => vi.useRealTimers());

test('turned off: no tmux at all, on open, on its ticks or on focus', async () => {
  const hub = new ServicesHub({ focused: () => true, enabled: () => false });
  hub.open('/p', wc().w);
  hub.onFocus();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(tmux.listPanes).not.toHaveBeenCalled();
});

test('turned on later: it lists at once and keeps its pace; turned off again: the panes go, tmux stops', async () => {
  let on = false;
  tmux.listPanes.mockResolvedValue({ status: 'ok', panes: [{ id: '%1', session: 's', window: 0, index: 0, title: 'web', command: 'npm', running: true }] } as never);
  const hub = new ServicesHub({ focused: () => true, enabled: () => on });
  const { w, sent } = wc();
  hub.open('/p', w);
  on = true;
  hub.settingsChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(tmux.listPanes).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(tmux.listPanes).toHaveBeenCalledTimes(2);
  on = false;
  hub.settingsChanged();
  const calls = tmux.listPanes.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(tmux.listPanes).toHaveBeenCalledTimes(calls);
  expect(sent.at(-1)).toEqual(['ev:services', { status: 'ok', panes: [] }]);
});
