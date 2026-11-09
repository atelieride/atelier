import { describe, expect, test, vi } from 'vitest';
import type { AtelierApi } from '@shared/api';
import { MAKES_WAY, OBSERVED, observeApi } from './observe';

describe('observeApi', () => {
  const make = () => {
    const input = vi.fn();
    const head = vi.fn(async () => ({ original: 'x' }));
    const ns = { terminals: { input, list: vi.fn() }, git: { head, status: vi.fn(), message: vi.fn() }, docker: { logs: vi.fn(), inspect: vi.fn(), tail: vi.fn(), watchLogs: vi.fn() }, background: { watch: vi.fn() }, companion: { ask: vi.fn(), catchUp: vi.fn(), thread: vi.fn() } };
    return { api: { ...ns, project: vi.fn() } as unknown as AtelierApi, input, head };
  };

  test('reports the observed calls and passes them through, answers included', async () => {
    const { api, input, head } = make();
    const seen: [string, unknown[]][] = [];
    const o = observeApi(api, (name, args) => seen.push([name, args]));
    o.terminals.input('t1', 'hello');
    await expect(o.git.head('/p/a.ts')).resolves.toEqual({ original: 'x' });
    expect(input).toHaveBeenCalledWith('t1', 'hello');
    expect(head).toHaveBeenCalledWith('/p/a.ts');
    expect(seen).toEqual([['terminals.input', ['t1', 'hello']], ['git.head', ['/p/a.ts']]]);
  });

  test('everything else is the bridge itself, untouched', () => {
    const { api } = make();
    const o = observeApi(api, () => {});
    expect(o.project).toBe(api.project);
    expect(o.terminals.list).toBe(api.terminals.list);
    expect(o.git.status).toBe(api.git.status);
    expect(api.terminals.input).not.toBe(o.terminals.input); // the original object is not mutated
  });

  test('a throwing observer never breaks the call', () => {
    const { api, input } = make();
    const o = observeApi(api, () => { throw new Error('observer'); });
    expect(() => o.terminals.input('t', 'x')).not.toThrow();
    expect(input).toHaveBeenCalled();
  });

  test('watches what the checklist needs, nothing more', () => {
    expect([...OBSERVED].sort()).toEqual(['background.watch', 'companion.ask', 'companion.catchUp', 'companion.thread', 'docker.inspect', 'docker.logs', 'docker.tail', 'docker.watchLogs', 'git.head', 'git.message', 'terminals.input']);
  });

  // With Catch me up on open turned off, opening Ask calls only companion.thread: the list must move then too.
  test('the calls after which "Things to try" makes way at once: every Ask call, its opening (companion.thread) first', () => {
    expect([...MAKES_WAY].sort()).toEqual(['companion.ask', 'companion.catchUp', 'companion.thread']);
    for (const name of MAKES_WAY) expect(OBSERVED).toContain(name);
  });
});
