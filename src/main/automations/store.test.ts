import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { normalizeAutomation, type Automation } from '@shared/automations';
import { normalizeRun, type Run } from '@shared/automation-run';
import { posixTest } from '../../../tests/support/platform';
import { AutomationsStore } from './store';

const dir = () => join(mkdtempSync(join(tmpdir(), 'atl-auto-store-')), 'automations');
const auto = (id: string): Automation => normalizeAutomation({ id, name: id, project: '/p/acme', source: { connector: 'clickup', scopes: ['1'] } })!;
const run = (id: string, createdAt: number, state = 'closed'): Run => normalizeRun({
  id, automationId: 'a1', createdAt, state, task: { source: 'clickup', id: 't1', displayId: 'CU-1', title: 'T', url: 'https://app.clickup.com/t/t1' }
})!;
const store = (d: string, logs: string[] = []) => new AutomationsStore(d, (m) => logs.push(m));

describe('AutomationsStore: ATELIER_HOME/automations, 0600, atomic', () => {
  test('nothing on disk: no automations, no runs, an empty ledger', () => {
    const s = store(dir());
    expect(s.loadAutomations()).toEqual([]);
    expect(s.loadRuns('a1')).toEqual([]);
    expect(s.loadSeen('a1')).toEqual({ lastPollAt: null, ledger: {} });
  });

  test('automations round-trip; invalid entries and duplicates are dropped when read', () => {
    const d = dir();
    store(d).saveAutomations([auto('a1'), auto('a2')]);
    expect(store(d).loadAutomations().map((a) => a.id)).toEqual(['a1', 'a2']);
    writeFileSync(join(d, 'automations.json'), JSON.stringify({ v: 1, automations: [auto('a1'), { id: 'bad id' }, auto('a1'), auto('a3')] }));
    expect(store(d).loadAutomations().map((a) => a.id)).toEqual(['a1', 'a3']);
  });

  posixTest('every file is 0600, the folder 0700', () => {
    const d = dir();
    const s = store(d);
    s.saveAutomations([auto('a1')]);
    s.saveRuns('a1', [run('r1', 1)]);
    s.saveSeen('a1', { lastPollAt: 5, ledger: { t1: { at: 5, matched: true, done: true } } });
    expect(statSync(d).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(d)) expect(statSync(join(d, f)).mode & 0o777, f).toBe(0o600);
  });

  test('an automations file that can\'t be read is set aside, never overwritten silently', () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'automations.json'), '{ not json');
    const logs: string[] = [];
    expect(store(d, logs).loadAutomations()).toEqual([]);
    const aside = readdirSync(d).filter((f) => f.startsWith('automations.json.bad-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(d, aside[0]!), 'utf8')).toBe('{ not json');
    expect(logs.join('\n')).toContain('automations.json');
  });

  test('runs: the last 50 kept (active ones always), invalid ones dropped when read', () => {
    const d = dir();
    const s = store(d);
    s.saveRuns('a1', [run('r0', 0, 'working'), ...Array.from({ length: 60 }, (_, i) => run(`r${i + 1}`, i + 1))]);
    const back = store(d).loadRuns('a1');
    expect(back).toHaveLength(50);
    expect(back.map((r) => r.id)).toContain('r0');
    writeFileSync(join(d, 'a1.runs.json'), JSON.stringify({ v: 1, runs: [run('r1', 1), { id: 'x' }] }));
    expect(store(d).loadRuns('a1').map((r) => r.id)).toEqual(['r1']);
  });

  test('the seen ledger round-trips; a wrong one reads as empty', () => {
    const d = dir();
    store(d).saveSeen('a1', { lastPollAt: 7, ledger: { t1: { at: 7, matched: true, done: true }, t2: { at: 6, matched: false, done: false } } });
    expect(store(d).loadSeen('a1')).toEqual({ lastPollAt: 7, ledger: { t1: { at: 7, matched: true, done: true }, t2: { at: 6, matched: false, done: false } } });
    writeFileSync(join(d, 'a1.seen.json'), JSON.stringify({ v: 1, lastPollAt: 'x', ledger: { t1: { at: 'y' }, 't 2': { at: 1, matched: true, done: true }, t3: { at: 2, matched: false, done: false }, t4: { at: 3, matched: true } } }));
    expect(store(d).loadSeen('a1')).toEqual({ lastPollAt: null, ledger: { t3: { at: 2, matched: false, done: false } } });
  });

  test('remove: its runs and ledger go; the others stay', () => {
    const d = dir();
    const s = store(d);
    s.saveRuns('a1', [run('r1', 1)]);
    s.saveSeen('a1', { lastPollAt: 1, ledger: {} });
    s.saveRuns('a2', [run('r2', 1)]);
    s.remove('a1');
    expect(existsSync(join(d, 'a1.runs.json'))).toBe(false);
    expect(existsSync(join(d, 'a1.seen.json'))).toBe(false);
    expect(existsSync(join(d, 'a2.runs.json'))).toBe(true);
  });

  test('an id that isn\'t one never names a file', () => {
    const s = store(dir());
    for (const id of ['../x', 'a/b', '', '.']) {
      expect(() => s.loadRuns(id), id).toThrow();
      expect(() => s.saveSeen(id, { lastPollAt: null, ledger: {} }), id).toThrow();
      expect(() => s.remove(id), id).toThrow();
    }
  });
});
