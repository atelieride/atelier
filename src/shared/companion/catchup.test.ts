import { describe, expect, it } from 'vitest';
import { CATCHUP_LIMITS, CATCHUP_SCHEMA, parseCatchUp } from './catchup';

const good = () => ({
  points: [
    { n: 1, text: 'Fix the login redirect', status: 'done', at: '12:41', note: null },
    { n: 2, text: 'Re-run the tests', status: 'in_progress', at: null, note: 'Re-running them · 1 of 3 failures left' },
  ],
  where: 'It fixed the redirect and is re-running the tests.',
  choices: ['Kept the old timeout value'],
  leftOpen: null,
});

describe('parseCatchUp', () => {
  it('accepts a valid catch-up', () => {
    expect(parseCatchUp(good())).toEqual(good());
  });
  it('rejects too many points, long text, bad status, bad time, too many choices, extra keys', () => {
    const p = { n: 1, text: 'x', status: 'done', at: null, note: null };
    expect(parseCatchUp({ ...good(), points: Array.from({ length: 13 }, () => p) })).toBeNull();
    expect(parseCatchUp({ ...good(), points: [{ ...p, text: 'x'.repeat(81) }] })).toBeNull();
    expect(parseCatchUp({ ...good(), points: [{ ...p, status: 'blocked' }] })).toBeNull();
    expect(parseCatchUp({ ...good(), points: [{ ...p, at: '25:61' }] })).toBeNull();
    expect(parseCatchUp({ ...good(), points: [{ ...p, note: 'x'.repeat(101) }] })).toBeNull();
    expect(parseCatchUp({ ...good(), choices: ['a', 'b', 'c', 'd'] })).toBeNull();
    expect(parseCatchUp({ ...good(), choices: ['x'.repeat(101)] })).toBeNull();
    expect(parseCatchUp({ ...good(), where: 'x'.repeat(401) })).toBeNull();
    expect(parseCatchUp({ ...good(), leftOpen: 'x'.repeat(301) })).toBeNull();
    expect(parseCatchUp({ ...good(), extra: 1 })).toBeNull();
    expect(parseCatchUp({ ...good(), points: [{ ...p, extra: 1 }] })).toBeNull();
  });
  it('counts characters as the schema does (code points): emoji at the limit pass, one more is refused', () => {
    const p = { n: 1, text: 'x', status: 'done', at: null, note: null };
    const emoji = '😀';
    expect(parseCatchUp({ ...good(), points: [{ ...p, text: emoji.repeat(80) }] })).not.toBeNull();
    expect(parseCatchUp({ ...good(), points: [{ ...p, text: emoji.repeat(81) }] })).toBeNull();
    expect(parseCatchUp({ ...good(), where: emoji.repeat(400) })).not.toBeNull();
    expect(parseCatchUp({ ...good(), choices: [emoji.repeat(100)], leftOpen: emoji.repeat(300) })).not.toBeNull();
    expect(parseCatchUp({ ...good(), points: [{ ...p, note: emoji.repeat(100) }] })).not.toBeNull();
  });
  it('rejects non-objects and never throws', () => {
    for (const v of [null, undefined, 1, 'x', [], { points: 3 }, { points: [null], where: '', choices: [], leftOpen: null }]) {
      expect(parseCatchUp(v)).toBeNull();
    }
  });
  it('keeps the schema limits in step with the validator', () => {
    const s = CATCHUP_SCHEMA as any;
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['points', 'where', 'choices', 'leftOpen']);
    expect(s.properties.points.maxItems).toBe(CATCHUP_LIMITS.points);
    expect(s.properties.where.maxLength).toBe(CATCHUP_LIMITS.where);
    expect(s.properties.choices.maxItems).toBe(CATCHUP_LIMITS.choices);
    expect(s.properties.choices.items.maxLength).toBe(CATCHUP_LIMITS.choice);
    expect(s.properties.leftOpen.type).toEqual(['string', 'null']);
    expect(s.properties.leftOpen.maxLength).toBe(CATCHUP_LIMITS.leftOpen);
    const pt = s.properties.points.items;
    expect(pt.additionalProperties).toBe(false);
    expect(pt.required).toEqual(['n', 'text', 'status', 'at', 'note']);
    expect(pt.properties.text.maxLength).toBe(CATCHUP_LIMITS.pointText);
    expect(pt.properties.note.maxLength).toBe(CATCHUP_LIMITS.note);
    expect(pt.properties.note.type).toEqual(['string', 'null']);
    expect(pt.properties.at.type).toEqual(['string', 'null']);
    expect(new RegExp(pt.properties.at.pattern).test('23:59')).toBe(true);
    expect(new RegExp(pt.properties.at.pattern).test('24:00')).toBe(false);
    expect(pt.properties.status.enum).toEqual(['done', 'in_progress', 'not_started', 'unclear']);
  });
});
