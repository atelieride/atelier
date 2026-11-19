import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';

// The store keeps the Claude session This session follows as the front changes.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { addEventListener: () => {}, atelier: {} };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const term = (id: string, claude: boolean): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: claude ? 'claude' : 'zsh', createdAt: 1,
  session: claude ? ({ state: 'idle', unread: false, updatedAt: 0 } as unknown as TerminalInfo['session']) : null
});
const st = () => useApp.getState();

beforeEach(() => useApp.setState({ terminals: [], selectedId: null, changesSession: null, changesScope: 'all' }));

test('Changes follows the Claude session in front; a plain terminal in front keeps the last one; its terminal gone, none', () => {
  const alfa = term('alfa', true), beta = term('beta', true), sh = term('sh', false);
  useApp.setState({ terminals: [alfa, beta, sh], selectedId: 'alfa' });
  expect(st().changesSession).toBe('alfa');
  useApp.setState({ selectedId: 'beta' });
  expect(st().changesSession).toBe('beta');
  useApp.setState({ selectedId: 'sh' });
  expect(st().changesSession).toBe('beta');
  useApp.setState({ terminals: [alfa, sh] });
  expect(st().changesSession).toBeNull();
});

test('the Show choice is the store\'s, every value of it', () => {
  for (const scope of ['ws', 'activity', 'session', 'all'] as const) {
    st().setChangesScope(scope);
    expect(st().changesScope).toBe(scope);
  }
});
