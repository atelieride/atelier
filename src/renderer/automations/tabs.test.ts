import { expect, test } from 'vitest';
import type { AutomationView } from '@shared/api';
import { autoKey, autoTabTitle, parseAutoKey } from './tabs';

// Automations tabs: one per automation, and one for every project's list.

test('an automation and every project’s list have their keys, which give them back', () => {
  expect(autoKey(null)).toBe('au:all');
  expect(autoKey('a1')).toBe('au:a1');
  expect(parseAutoKey('au:all')).toEqual({ id: null });
  expect(parseAutoKey('au:a1')).toEqual({ id: 'a1' });
});

test('a tab is named by its automation, or “All automations”', () => {
  const list = [{ automation: { id: 'a1', name: 'Triage bugs' } }] as unknown as AutomationView[];
  expect(autoTabTitle('a1', list)).toBe('Triage bugs');
  expect(autoTabTitle(null, list)).toBe('All automations');
  expect(autoTabTitle('gone', list)).toBe('Automations');
});

test('a malformed key names nothing', () => {
  for (const k of ['au:', 'au:../x', 'automations', 'rd:keys']) expect(parseAutoKey(k)).toBeNull();
});
