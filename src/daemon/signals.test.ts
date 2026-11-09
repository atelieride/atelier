import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expectMode } from '../../tests/support/platform';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalBook } from './signals';

const installed = new Set(['Notification', 'Stop']);
const hook = (type: string) => ({ hook_event_name: 'Notification', session_id: 's', notification_type: type });

let dir: string;
let logs: string[];
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), 'signals-')); logs = []; });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
const make = (now = () => 1000) => new SignalBook({ file: join(dir, 'claude-signals.json'), installed, log: (m) => logs.push(m), now });

describe('SignalBook', () => {
  test('notes a hook with the foreground version and round-trips through the file at 0600', () => {
    const b = make();
    b.noteHook(hook('brand_new'), '/usr/bin/2.1.320');
    b.flush();
    const file = join(dir, 'claude-signals.json');
    expectMode(file, 0o600);
    const again = make();
    expect(again.view()).toEqual(b.view());
    expect(again.view().entries[0]).toMatchObject({ kind: 'notification', value: 'brand_new', version: '2.1.320', count: 1 });
    expect(again.view().lastVersion).toBe('2.1.320');
  });

  test('a missing file starts empty silently; a broken one starts empty with one log line', () => {
    expect(make().view().entries).toEqual([]);
    expect(logs).toEqual([]);
    writeFileSync(join(dir, 'claude-signals.json'), '{nope');
    expect(make().view().entries).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  test('status payloads are noted', () => {
    const b = make();
    b.noteStatus({ rate_limits: { five_hour: {} } }, null);
    expect(b.view().entries[0]).toMatchObject({ kind: 'status', value: 'rate_limits.five_hour', version: null });
  });

  test('changed and the save are debounced together', () => {
    const b = make();
    const changed = vi.fn();
    b.on('changed', changed);
    b.noteHook(hook('a_new'), null);
    b.noteHook(hook('b_new'), null);
    expect(changed).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'claude-signals.json'))).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]?.[0].entries).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, 'claude-signals.json'), 'utf8')).entries).toHaveLength(2);
    b.noteHook(hook('c_new'), null);
    vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  test('a recognized payload changes nothing', () => {
    const b = make();
    const changed = vi.fn();
    b.on('changed', changed);
    b.noteHook(hook('idle_prompt'), null);
    vi.advanceTimersByTime(5000);
    expect(changed).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'claude-signals.json'))).toBe(false);
  });

  test('two Claude Code versions at once: once the higher is seen, alternating payloads with no findings neither save nor emit', () => {
    const b = make();
    const changed = vi.fn();
    b.on('changed', changed);
    b.noteHook(hook('idle_prompt'), '/x/2.1.316');
    b.noteHook(hook('idle_prompt'), '/x/2.1.320');
    vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenCalledTimes(1);
    const file = join(dir, 'claude-signals.json');
    rmSync(file);
    for (let i = 0; i < 10; i++) {
      b.noteHook(hook('idle_prompt'), i % 2 ? '/x/2.1.320' : '/x/2.1.316');
      b.noteStatus({}, i % 2 ? '2.1.316' : '2.1.320');
      vi.advanceTimersByTime(2000);
    }
    expect(changed).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
    expect(b.view().lastVersion).toBe('2.1.320');
  });

  test('flush writes at once and cancels the timer; dispose drops it', () => {
    const b = make();
    const changed = vi.fn();
    b.on('changed', changed);
    b.noteHook(hook('a_new'), null);
    b.flush();
    expect(existsSync(join(dir, 'claude-signals.json'))).toBe(true);
    b.noteHook(hook('b_new'), null);
    b.dispose();
    vi.advanceTimersByTime(5000);
    expect(changed).not.toHaveBeenCalled();
  });

  test('clear empties the entries, keeps lastVersion, resets since', () => {
    let t = 1000;
    const b = make(() => t);
    b.noteHook(hook('a_new'), '2.1.320');
    t = 5000;
    b.clear();
    expect(b.view()).toEqual({ lastVersion: '2.1.320', since: 5000, entries: [] });
    b.flush();
    expect(make().view().lastVersion).toBe('2.1.320');
  });

  test('a throwing changed listener never escapes the timer and is logged; later saves and emits still happen', () => {
    const b = make();
    const good = vi.fn();
    b.on('changed', () => { throw new Error('listener boom'); });
    b.on('changed', good);
    b.noteHook(hook('a_new'), null);
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('listener boom');
    expect(JSON.parse(readFileSync(join(dir, 'claude-signals.json'), 'utf8')).entries).toHaveLength(1);
    b.noteHook(hook('b_new'), null);
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(logs).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, 'claude-signals.json'), 'utf8')).entries).toHaveLength(2);
  });

  test('noting never throws', () => {
    const b = make();
    expect(() => b.noteHook(undefined, null)).not.toThrow();
    expect(() => b.noteStatus(undefined, null)).not.toThrow();
  });
});
