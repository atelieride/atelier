import { describe, expect, it } from 'vitest';
import { askAccountChoices, cleanKnown } from './known';
import { isSettingText } from '@shared/settings';

describe('cleanKnown', () => {
  it('caps at the limit', () => expect(cleanKnown('x'.repeat(2100), 2000)).toHaveLength(2000));
  it('turns CRLF into newlines and drops control characters settings would refuse', () => {
    const out = cleanKnown('a\r\nb\u0000\tc\u0007', 2000);
    expect(out).toBe('a\nb\tc');
    expect(isSettingText(out, 2000)).toBe(true);
  });
  it('never splits a surrogate pair at the cut', () => expect(cleanKnown('ab😀', 3)).toBe('ab'));
  it('keeps a whole pair that fits', () => expect(cleanKnown('ab😀', 4)).toBe('ab😀'));
  it('leaves normal text alone', () => expect(cleanKnown('Postgres: skip the basics.', 2000)).toBe('Postgres: skip the basics.'));
});

describe('askAccountChoices', () => {
  const acc = (id: string, name: string) => ({ id, name, dir: '', color: 1 });
  it('is empty with one account (the row is hidden)', () => expect(askAccountChoices({ list: [acc('default', 'Personal')], newSession: 'default', dismissed: [] }, "The session's")).toEqual([]));
  it("starts with the session's, then each account", () => {
    expect(askAccountChoices({ list: [acc('default', 'Personal'), acc('work', 'Work')], newSession: 'default', dismissed: [] }, "The session's"))
      .toEqual([{ value: 'session', label: "The session's" }, { value: 'default', label: 'Personal' }, { value: 'work', label: 'Work' }]);
  });
});
