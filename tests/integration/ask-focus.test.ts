import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Ask: its controls set their own box-shadow in some states (open, dock, stop, disabled), which
// beats the global :focus-visible ring (theme.css). Each of them restates the ring for keyboard focus.

const layout = readFileSync(join(__dirname, '../../src/renderer/layout.css'), 'utf8');
const RING = '0 0 0 2px var(--bg-0), 0 0 0 3.5px var(--violet)';

test('every Ask control state with its own shadow keeps the keyboard focus ring', () => {
  const rule = (selector: string) => {
    const at = layout.split('\n').find((l) => l.split('{')[0]!.split(',').map((s) => s.trim()).includes(selector));
    return at ?? '';
  };
  for (const s of [
    '.sb-ask:focus-visible', '.sb-ask.is-open:focus-visible', '.ask-ib:focus-visible', '.ask-ib.is-dock:focus-visible', '.ask-pick:focus-visible', '.ask-send:focus-visible',
    '.ask-send.is-stop:focus-visible', '.ask-send[aria-disabled="true"]:focus-visible', '.ask-ib.is-stale:focus-visible', '.ask-why:focus-visible', '.ask-sg:focus-visible',
    // Answers (Task 14): file chips, Detail toggles, the actions, the stale bar's Refresh and Try again.
    '.ask-fchip:focus-visible', '.ask-detail-hd:focus-visible', '.ask-act:focus-visible', '.ask-stale-go:focus-visible', '.ask-err-go:focus-visible',
    // Attention (Task 15): the needs-you card's and the limit item's buttons, its Cancel, the picker at its limit, the row's mark.
    '.ask-btn:focus-visible', '.ask-btn.is-amber:focus-visible', '.ask-btn.is-primary:focus-visible', '.ask-lim-cancel:focus-visible',
    '.ask-pick.is-limit:focus-visible', '.row-ask:focus-visible',
    // Catch me up in the composer's row.
    '.ask-cu:focus-visible'
  ]) {
    expect(rule(s), s).toContain(RING);
  }
  expect(layout.lastIndexOf('.ask-fchip:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.ask-fchip:hover'));
  expect(layout.lastIndexOf('.ask-act:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.ask-act:hover'));
  expect(layout.lastIndexOf('.ask-err-go:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.ask-err-go:hover'));
  // Declared after the states they must win over (same specificity for the hover ones).
  expect(layout.lastIndexOf('.ask-send.is-stop:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.ask-send.is-stop:hover'));
  expect(layout.lastIndexOf('.sb-ask.is-open:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.sb-ask.is-open {'));
  expect(layout.lastIndexOf('.ask-ib.is-stale:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.ask-ib.is-stale:hover'));
  expect(layout.lastIndexOf('.ask-sg:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.ask-sg:hover'));
  expect(layout.lastIndexOf('.ask-why:focus-visible')).toBeGreaterThan(layout.lastIndexOf('.ask-why:hover'));
  for (const s of ['.ask-btn', '.ask-btn.is-amber', '.ask-btn.is-primary', '.ask-pick.is-limit', '.row-ask', '.ask-cu']) {
    expect(layout.lastIndexOf(`${s}:focus-visible`), s).toBeGreaterThan(layout.lastIndexOf(`${s}:hover`));
  }
});

test('a disabled control: hover changes nothing (the stale refresh never glows brighter), keyboard focus keeps its ring', () => {
  const rule = (selector: string) => layout.split('\n').find((l) => l.split('{')[0]!.split(',').map((s) => s.trim()).includes(selector)) ?? '';
  const shadow = (selector: string) => /box-shadow:\s*([^;]+);/.exec(rule(selector))?.[1] ?? '';
  // The stale refresh while Ask is busy: its hover is its rest state, declared after the hover it must beat.
  expect(shadow('.ask-ib.is-stale[aria-disabled="true"]:hover')).toBe(shadow('.ask-ib.is-stale'));
  expect(layout.lastIndexOf('.ask-ib.is-stale[aria-disabled="true"]:hover')).toBeGreaterThan(layout.lastIndexOf('.ask-ib.is-stale:hover'));
  // Disabled and hovered, the ring stays: declared after the disabled hover (same specificity).
  for (const s of ['.ask-ib.is-stale', '.ask-why', '.ask-stale-go', '.ask-err-go', '.ask-cu']) {
    const focus = `${s}[aria-disabled="true"]:focus-visible`;
    expect(rule(focus), focus).toContain(RING);
    expect(layout.lastIndexOf(focus), focus).toBeGreaterThan(layout.lastIndexOf(`${s}[aria-disabled="true"]:hover`));
  }
});

test('the needs-you card is the only amber in Ask, and the row\'s mark never moves at rest', () => {
  const rules = layout.split('\n').filter((l) => /^\.ask[-\w.]*|^\.row-ask/.test(l));
  const amber = rules.filter((l) => /var\(--(waiting|tint-waiting|edge-waiting|glow-waiting)\)/.test(l)).map((l) => l.split('{')[0]!.trim());
  // The live strip's "Needs you" chip, an unclear verdict or point and a final card's "not done" are the
  // session's state too: named, nothing else.
  expect(amber.filter((s) => !/^\.ask-needs|^\.ask-btn\.is-amber|^\.ask-verdict\.is-unclear|^\.ask-gl\.is-unclear|^\.ask-pt-tm\.is-open/.test(s))).toEqual([]);
  const mark = layout.split('\n').filter((l) => l.startsWith('.row-ask')).join('\n');
  expect(mark).toContain('.row-ask');
  expect(mark).not.toMatch(/animation:[^;]*infinite/);
});
