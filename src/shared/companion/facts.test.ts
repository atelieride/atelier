import { describe, expect, it } from 'vitest';
import { renderFacts } from './facts';
import type { LiveFacts } from './live';

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const NOW = new Date(2026, 9, 31, 12, 50, 0).getTime();
const MIN = 60_000;
const facts = (o: Partial<LiveFacts> = {}): LiveFacts => ({ state: 'working', since: NOW - 12 * MIN, work: null, files: 2, added: 120, removed: 30, ...o });
const base = { title: 'Login fix', facts: facts(), waiting: null, files: [] as { rel: string; at: number }[], costUsd: null, branch: null, now: NOW };

describe('renderFacts', () => {
  it('lists the state and since when, the background work, files with their times, lines, cost and branch', () => {
    const t1 = NOW - 9 * MIN;
    const t2 = NOW - 6 * MIN;
    const out = renderFacts({
      ...base, facts: facts({ work: '2 shells · 1 agent' }), costUsd: 1.234, branch: 'feature/auth',
      files: [{ rel: 'src/auth/refresh.ts', at: t2 }, { rel: 'src/auth/session.ts', at: t1 }]
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe(`# Atelier's facts about the session "Login fix" at ${hhmm(NOW)} (${day(NOW)})`);
    expect(lines).toContain(`- State: working, since ${hhmm(NOW - 12 * MIN)} (for 12m)`);
    expect(lines).toContain('- Background: 2 shells · 1 agent');
    expect(lines).toContain('- Lines: +120 −30');
    expect(lines).toContain('- Cost: $1.23');
    expect(lines).toContain('- Branch: feature/auth');
    expect(lines).toContain('- Files changed (2), oldest first:');
    expect(out).toContain(`  - ${hhmm(t1)} src/auth/session.ts\n  - ${hhmm(t2)} src/auth/refresh.ts`);
  });

  it('says what it waits for, and when facts are missing', () => {
    const out = renderFacts({ ...base, facts: facts({ state: 'waiting', since: null, work: null, added: 0, removed: 0 }), waiting: 'permission to run Bash: curl -H "x: sk-ant-api03-ABCDEFGHIJKLMNOP1234"' });
    const lines = out.split('\n');
    expect(lines).toContain('- State: waiting for you');
    expect(lines).toContain('- Waiting for: permission to run Bash: curl -H "x: …"');
    expect(lines).toContain('- Background: none');
    expect(lines).toContain('- Lines: +0 −0');
    expect(lines).toContain('- Cost: unknown');
    expect(lines).toContain('- Branch: unknown');
    expect(lines).toContain('- Files changed: none');
  });

  it('durations, dates of earlier days, ended sessions', () => {
    const d = (since: number, state: LiveFacts['state'] = 'idle') => renderFacts({ ...base, facts: facts({ state, since }) }).split('\n')[1];
    expect(d(NOW - 30_000)).toBe(`- State: idle, since ${hhmm(NOW - 30_000)} (for under a minute)`);
    expect(d(NOW - 75 * MIN)).toBe(`- State: idle, since ${hhmm(NOW - 75 * MIN)} (for 1h 15m)`);
    const old = NOW - 26 * 60 * MIN;
    expect(d(old, 'done')).toBe(`- State: done, since ${day(old)} ${hhmm(old)} (for 1d 2h)`);
    expect(d(NOW + 5 * MIN, 'ended')).toBe(`- State: ended (no live session), since ${hhmm(NOW + 5 * MIN)} (for under a minute)`);
    const files = renderFacts({ ...base, files: [{ rel: 'a.ts', at: old }] });
    expect(files).toContain(`  - ${day(old)} ${hhmm(old)} a.ts`);
  });

  it('names stay on one line', () => {
    const out = renderFacts({ ...base, title: 'Fix\n- State: done', branch: 'b\nx', files: [{ rel: 'a\nb.ts', at: NOW }] });
    expect(out.split('\n')[0]).toContain('"Fix - State: done"');
    expect(out).toContain('- Branch: b x');
    expect(out).toContain(' a b.ts');
    expect(out.split('\n').filter((l) => l.startsWith('- State'))).toHaveLength(1);
  });

  it('a key split by an invisible character is still redacted; cuts never split a character', () => {
    const zw = String.fromCharCode(0x200b);
    const out = renderFacts({ ...base, waiting: `permission to run Bash: export K=sk-ant-${zw}${'Ab1'.repeat(10)}`, title: `x${'😀'.repeat(200)}` });
    expect(out).not.toContain('Ab1Ab1');
    expect(out).not.toContain(zw);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });
});
