import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useApp } from '../store';
import type { CloseSessionsAsk } from '@shared/asks';

const CS: CloseSessionsAsk = { kind: 'close-sessions', what: 'quit', windows: 0, projects: [] };

// main's questions: shown in the window, answered once through asks.answer.
const answer = vi.fn(async (_id: string, _a: string) => true);
const shown = vi.fn(async (_id: string) => true);

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { atelier: { asks: { answer, shown } } };
  answer.mockClear();
  useApp.setState({ mainAsk: null });
});
afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window; });

test('a question is shown until answered; the answer goes back once with its id', () => {
  useApp.getState().receiveAsk({ id: 'ask-1', request: CS });
  expect(useApp.getState().mainAsk?.request.kind).toBe('close-sessions');
  useApp.getState().answerMain('stop');
  expect(answer).toHaveBeenCalledWith('ask-1', 'stop');
  expect(useApp.getState().mainAsk).toBeNull();
  useApp.getState().answerMain('cancel');
  expect(answer).toHaveBeenCalledTimes(1);
});

test('a new question while one is open: the open one gets its safe answer (Wait for a quit with git running)', () => {
  useApp.getState().receiveAsk({ id: 'ask-1', request: { kind: 'quit-git', title: 'A push is running in api', detail: '', ops: [] } });
  useApp.getState().receiveAsk({ id: 'ask-2', request: CS });
  expect(answer).toHaveBeenCalledWith('ask-1', 'wait');
  expect(useApp.getState().mainAsk?.id).toBe('ask-2');
});

test('a question closes the palette, a context menu and the background popover: nothing covers it or keeps the keys', () => {
  useApp.setState({ paletteOpen: true, menu: { x: 1, y: 1, items: [] } as never, bgPopover: { id: 't1' } as never });
  useApp.getState().receiveAsk({ id: 'ask-1', request: CS });
  expect(useApp.getState()).toMatchObject({ paletteOpen: false, menu: null, bgPopover: null });
});

test('the page tells main it got the question (main falls back to its native dialog when a hung page never does)', () => {
  shown.mockClear();
  useApp.getState().receiveAsk({ id: 'ask-7', request: CS });
  expect(shown).toHaveBeenCalledWith('ask-7');
});

test('main gave up on the question (the page was too slow; its native dialog asks): the sheet goes, never two prompts', async () => {
  shown.mockImplementationOnce(async () => false);
  useApp.getState().receiveAsk({ id: 'ask-8', request: CS });
  await vi.waitFor(() => expect(useApp.getState().mainAsk).toBeNull());
});

test('a withdrawn question leaves its sheet; another open question stays', () => {
  useApp.getState().receiveAsk({ id: 'ask-9', request: CS });
  useApp.getState().withdrawAsk('ask-1');
  expect(useApp.getState().mainAsk?.id).toBe('ask-9');
  useApp.getState().withdrawAsk('ask-9');
  expect(useApp.getState().mainAsk).toBeNull();
  expect(answer).not.toHaveBeenCalled();
});
