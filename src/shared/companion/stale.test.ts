import { describe, expect, it } from 'vitest';
import type { Attribution } from '../attribution';
import { changedAfter } from './stale';

const a = (o: Partial<Attribution>): Attribution => ({ path: 'a.ts', terminalId: 't', sessionId: 's1', color: '#fff', title: 'x', at: 100, ...o });

describe('changedAfter', () => {
  it('keeps only that session, strictly after the time, de-duplicated in first-change order', () => {
    const attrs = [a({ path: 'b.ts', at: 200 }), a({ path: 'a.ts', at: 150 }), a({ path: 'b.ts', at: 300 }), a({ path: 'c.ts', at: 100 }), a({ path: 'd.ts', at: 500, sessionId: 's2' })];
    expect(changedAfter(attrs, 's1', 100)).toEqual(['b.ts', 'a.ts']);
  });
  it('excludes unclear and maybe attributions', () => {
    expect(changedAfter([a({ at: 200, unclear: ['s2'] }), a({ path: 'm.ts', at: 200, maybe: true })], 's1', 100)).toEqual([]);
  });
  it('prefers changedAt over at for tool-call entries', () => {
    expect(changedAfter([a({ path: 'x.ts', at: 500, changedAt: 50, via: 'bash' })], 's1', 100)).toEqual([]);
    expect(changedAfter([a({ path: 'y.ts', at: 50, changedAt: 500, via: 'bash' })], 's1', 100)).toEqual(['y.ts']);
  });
});
