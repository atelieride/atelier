import { describe, expect, test } from 'vitest';
import { SCENARIOS } from '../world/scenarios';
import { SPINNER_GLYPHS, choicesOf, claudeScreen, screenOf, spinnerFrame, spinnerLine, visibleLength, wrapLine } from './claude-screen';

// The Claude screen is a port of tests/e2e/fake-claude-demo.pl's draw(): the screenshots keep the
// Perl, the demo draws the same bytes in the browser and again on every resize.

const ESC = '\u001b';
const DIM = `${ESC}[2m`;
const RST = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;

/** What the Perl prints, written out by hand from draw() and @bottom (rows × cols as `stty size` reports them). */
function perl(transcript: string[], bottom: string[], rows: number, cols: number): string {
  let out = `${ESC}[2J${ESC}[H`;
  for (const l of transcript) out += `${l}\r\n`;
  const top = rows - bottom.length;
  out += `${ESC}[${top};1H${DIM}${'─'.repeat(cols)}${RST}`;
  bottom.forEach((b, i) => { out += `${ESC}[${top + 1 + i};1H${b}`; });
  const prompt = bottom.indexOf('> ');
  out += prompt >= 0 ? `${ESC}[?25h${ESC}[${top + 1 + prompt};3H` : `${ESC}[?25l`;
  return out;
}

describe('claudeScreen: the Perl drawing, byte for byte', () => {
  test('permission: the Bash command and the three-way menu, cursor hidden', () => {
    const s = SCENARIOS['auth-refactor'];
    const bottom = [` ${BOLD}Bash command${RST}`, '   npm test -- auth', '', ' Do you want to proceed?', ` ${ESC}[36m❯ 1. Yes${RST}`, "   2. Yes, and don't ask again", '   3. No, tell Claude what to do'];
    expect(claudeScreen(screenOf(s), 31, 79)).toBe(perl(s.transcript, bottom, 31, 79));
  });

  test('question: the options, the first one picked', () => {
    const s = SCENARIOS['db-migration'];
    const bottom = [` ${ESC}[36m❯ 1. paid${RST}`, '   2. pending', '   3. Type something'];
    expect(claudeScreen(screenOf(s), 40, 100)).toBe(perl(s.transcript, bottom, 40, 100));
  });

  test('working: the spinner, then the prompt with the cursor in it', () => {
    const s = SCENARIOS['billing-tests'];
    const bottom = [`${ESC}[38;5;211m✻ Writing tests…${RST} ${DIM}(esc to interrupt)${RST}`, '', '> ', ''];
    expect(claudeScreen(screenOf(s), 36, 99)).toBe(perl(s.transcript, bottom, 36, 99));
  });

  test('done: an empty prompt', () => {
    const s = SCENARIOS['onboarding-copy'];
    expect(claudeScreen(screenOf(s), 24, 60)).toBe(perl(s.transcript, ['', '> ', ''], 24, 60));
  });

  test('another pick moves the ❯ and the colour (the runtime answers arrow keys)', () => {
    const screen = claudeScreen(screenOf(SCENARIOS['db-migration']), 30, 80, { selected: 1 });
    expect(screen).toContain(`   1. paid`);
    expect(screen).toContain(` ${ESC}[36m❯ 2. pending${RST}`);
  });

  test('the divider follows the width and the bottom area the height', () => {
    const narrow = claudeScreen(screenOf(SCENARIOS.docs), 20, 40);
    const wide = claudeScreen(screenOf(SCENARIOS.docs), 50, 120);
    expect(narrow).toContain(`${ESC}[16;1H${DIM}${'─'.repeat(40)}${RST}`);
    expect(wide).toContain(`${ESC}[46;1H${DIM}${'─'.repeat(120)}${RST}`);
  });

  test('screenOf keeps only what the drawing needs', () => {
    expect(screenOf(SCENARIOS['auth-refactor'])).toEqual({ transcript: SCENARIOS['auth-refactor'].transcript, state: 'permission', command: 'npm test -- auth' });
    expect(Object.keys(screenOf(SCENARIOS['db-migration'])).sort()).toEqual(['options', 'state', 'transcript']);
  });
});

describe('claudeScreen: what the live demo animates', () => {
  const base = screenOf(SCENARIOS['onboarding-copy']);

  test('typed text shows after the prompt and the cursor follows it', () => {
    const screen = claudeScreen({ ...base, input: 'add a footer' }, 24, 60);
    expect(screen).toContain(`${ESC}[23;1H> add a footer`);
    expect(screen.endsWith(`${ESC}[?25h${ESC}[23;15H`)).toBe(true);
  });

  test('a multi-line prompt grows the bottom area upwards', () => {
    const screen = claudeScreen({ ...base, input: 'one\ntwo' }, 24, 60);
    expect(screen).toContain(`${ESC}[20;1H${DIM}`);
    expect(screen).toContain(`${ESC}[22;1H> one`);
    expect(screen).toContain(`${ESC}[23;1H  two`);
    expect(screen.endsWith(`${ESC}[23;6H`)).toBe(true);
  });

  test('text wider than the screen shows its end', () => {
    expect(claudeScreen({ ...base, input: 'x'.repeat(100) }, 24, 40)).toContain(`> …${'x'.repeat(36)}`);
  });

  test('an edit permission: its heading, file, question and choices', () => {
    const s = { ...base, state: 'permission' as const, permission: { title: 'Edit file', detail: ['README.md'], question: 'Do you want to make this edit to README.md?', choices: ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No, and tell Claude what to do differently (esc)'] } };
    const screen = claudeScreen(s, 30, 80, { selected: 2 });
    expect(screen).toContain(` ${BOLD}Edit file${RST}`);
    expect(screen).toContain('   README.md');
    expect(screen).toContain(' Do you want to make this edit to README.md?');
    expect(screen).toContain(` ${ESC}[36m❯ 3. No, and tell Claude what to do differently (esc)${RST}`);
    expect(screen.endsWith(`${ESC}[?25l`)).toBe(true);
    expect(choicesOf(s)).toBe(3);
    expect(choicesOf(screenOf(SCENARIOS['db-migration']))).toBe(3);
    expect(choicesOf(base)).toBe(0);
  });

  test('the spinner with its glyph, seconds and tokens', () => {
    const s = { ...screenOf(SCENARIOS['billing-tests']), glyph: '✶', elapsed: 12, tokens: 1234 };
    expect(spinnerLine(s)).toBe(`${ESC}[38;5;211m✶ Writing tests…${RST} ${DIM}(12s · ↓ 1.2k tokens · esc to interrupt)${RST}`);
    expect(spinnerLine({ ...s, tokens: 640 })).toContain('↓ 640 tokens');
  });

  test('a spinner frame redraws only its line and puts the cursor back in the prompt', () => {
    const s = { ...screenOf(SCENARIOS['billing-tests']), glyph: '✳', input: 'hi' };
    expect(spinnerFrame(s, 36, 99)).toBe(`${ESC}[33;1H${ESC}[2K${spinnerLine(s)}${ESC}[?25h${ESC}[35;5H`);
    expect(spinnerFrame(base, 36, 99)).toBe('');
  });

  test('a transcript taller than the screen keeps its last lines (a long line takes the rows it wraps to)', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    // 24 rows, 3 for the bottom, 1 for the divider: 20 rows above it.
    expect(claudeScreen({ ...base, transcript: lines }, 24, 60)).toContain(`${ESC}[2J${ESC}[Hline 20\r\n`);
    // A 130-character line wraps to 3 rows at 60 columns: 17 short lines fit before it.
    const wide = claudeScreen({ ...base, transcript: [...lines.slice(0, 38), 'y'.repeat(130)] }, 24, 60);
    expect(wide).toContain(`${ESC}[2J${ESC}[Hline 21\r\n`);
    expect(wide).toContain(`line 37\r\n${'y'.repeat(130)}\r\n`);
  });

  test('in a narrow pane the spinner drops its counters and menu lines are cut, never wrapped into the next row', () => {
    const s = { ...screenOf(SCENARIOS['billing-tests']), glyph: '✶', elapsed: 42, tokens: 2400 };
    expect(visibleLength(spinnerLine(s, 36))).toBeLessThanOrEqual(36);
    expect(spinnerLine(s, 50)).toContain('(42s · esc to interrupt)');
    expect(spinnerLine(s, 36)).toContain('(42s)');
    expect(spinnerLine(s, 20)).not.toContain('(');
    expect(visibleLength(spinnerLine(s, 10))).toBe(10);
    const permission = claudeScreen(screenOf(SCENARIOS['auth-refactor']), 30, 20);
    for (const row of permission.split(/\u001b\[\d+;1H/).slice(2)) expect(visibleLength(row.replace(/\u001b\[\?25l$/, ''))).toBeLessThanOrEqual(20);
  });

  test("a text line wider than the pane wraps at spaces, indented under Claude's ●", () => {
    const line = `${ESC}[1m●${ESC}[0m One test fails: the skew is applied the wrong way round`;
    expect(wrapLine(line, 24)).toEqual([`${ESC}[1m●${ESC}[0m One test fails: the`, '  skew is applied the', '  wrong way round']);
    expect(wrapLine('short', 24)).toEqual(['short']);
    expect(claudeScreen({ ...base, transcript: [line] }, 24, 24)).toContain('the\r\n  skew is applied the\r\n');
  });

  test('visibleLength ignores styles', () => {
    expect(visibleLength(`${ESC}[1m●${ESC}[0m Read(x)`)).toBe(9);
  });

  test("the glyphs go back and forth, Claude Code's", () => {
    expect(SPINNER_GLYPHS.join('')).toBe('·✢✳✶✻✽✻✶✳✢');
  });
});
