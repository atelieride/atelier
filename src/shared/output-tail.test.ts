import { describe, expect, test } from 'vitest';
import { BUFFER_LINES, LINE_MAX, OutputTail } from './output-tail';

const enc = (s: string) => new TextEncoder().encode(s);

describe('OutputTail', () => {
  test('lines split across chunks; the unfinished one is live', () => {
    const t = new OutputTail();
    expect(t.push(enc('one\ntw'))).toEqual(['one']);
    expect(t.live).toBe('tw');
    expect(t.push(enc('o\nthree'))).toEqual(['two']);
    expect(t.lines).toEqual(['one', 'two']);
    expect([t.live, t.seq]).toEqual(['three', 2]);
  });
  test('a UTF-8 sequence split across chunks', () => {
    const t = new OutputTail();
    const b = enc('✓ ok\n');
    t.push(b.slice(0, 2));
    expect(t.push(b.slice(2))).toEqual(['✓ ok']);
  });
  test('ANSI escapes are stripped; CRLF is a newline', () => {
    const t = new OutputTail();
    expect(t.push(enc('\x1b[32m✓\x1b[0m pass\r\n\x1b]8;;http://x\x07link\x1b]8;;\x07\n'))).toEqual(['✓ pass', 'link']);
  });
  test('carriage returns keep the last segment; the live line is capped', () => {
    const t = new OutputTail();
    t.push(enc('10%\r50%\r90%'));
    expect(t.live).toBe('90%');
    t.push(enc('\rdone\n'));
    expect(t.lines).toEqual(['done']);
    t.push(enc('x'.repeat(LINE_MAX * 3)));
    expect(t.live.length).toBe(LINE_MAX + 1);
    expect(t.live.endsWith('…')).toBe(true);
  });
  test('long lines are clipped with an ellipsis', () => {
    const t = new OutputTail();
    const [line] = t.push(enc(`${'y'.repeat(LINE_MAX + 50)}\n`));
    expect(line!.length).toBe(LINE_MAX + 1);
    expect(line!.endsWith('…')).toBe(true);
  });
  test('the buffer keeps the last lines and counts the dropped ones', () => {
    const t = new OutputTail();
    t.push(enc(Array.from({ length: BUFFER_LINES + 3 }, (_, i) => `l${i}`).join('\n') + '\n'));
    expect(t.lines.length).toBe(BUFFER_LINES);
    expect(t.lines[0]).toBe('l3');
    expect(t.dropped).toBe(3);
    expect(t.seq).toBe(BUFFER_LINES + 3);
  });
  test('the exit trailer is the exit code, not a line (with the blank line before it)', () => {
    const t = new OutputTail();
    expect(t.push(enc('probe-output-location\n\n[exited with code 0]\n'))).toEqual(['probe-output-location']);
    expect(t.exit).toBe(0);
    expect(t.lines).toEqual(['probe-output-location']);
    const f = new OutputTail();
    f.push(enc('boom\n[exited with code 1]\n'));
    expect(f.exit).toBe(1);
  });
  test('reset starts over', () => {
    const t = new OutputTail();
    t.push(enc('a\nb'));
    t.reset();
    expect([t.lines, t.live, t.exit, t.dropped, t.seq]).toEqual([[], '', null, 0, 0]);
  });
  test('a blank line before the trailer split across chunks is dropped, never taken back', () => {
    const t = new OutputTail();
    expect(t.push(enc('a\n\n'))).toEqual(['a']);
    expect(t.push(enc('[exited with code 0]\n'))).toEqual([]);
    expect([t.lines, t.seq, t.exit]).toEqual([['a'], 1, 0]);
  });
  test('a held blank line is emitted before the next line', () => {
    const t = new OutputTail();
    expect(t.push(enc('a\n\n'))).toEqual(['a']);
    expect(t.push(enc('b\n'))).toEqual(['', 'b']);
    expect([t.lines, t.seq]).toEqual([['a', '', 'b'], 3]);
  });
  test('an ANSI escape split across chunks does not show in the live line', () => {
    const t = new OutputTail();
    t.push(enc('\x1b[3'));
    expect(t.live).toBe('');
    expect(t.push(enc('2mok\n'))).toEqual(['ok']);
    expect(t.live).toBe('');
  });
  test('a single chunk of 200,000 lines is buffered without spreading arguments', () => {
    const t = new OutputTail();
    const big = Array.from({ length: 200_000 }, (_, i) => `n${i}`).join('\n') + '\n';
    expect(t.push(enc(big)).length).toBe(200_000);
    expect(t.lines.length).toBe(BUFFER_LINES);
    expect([t.seq, t.dropped]).toEqual([200_000, 200_000 - BUFFER_LINES]);
  });
  test('an OSC cut short by the chunk boundary keeps its escape and stays out of live', () => {
    const t = new OutputTail();
    t.push(enc('\x1b]8;;http://x'));
    expect(t.live).toBe('');
    expect(t.push(enc('\x07link\x1b]8;;\x07\n'))).toEqual(['link']);
  });
  test('an OSC cut short before its ST terminator is completed by the next chunk', () => {
    const t = new OutputTail();
    t.push(enc('\x1b]8;;http://x\x1b'));
    expect(t.live).toBe('');
    expect(t.push(enc('\\link\x1b]8;;\x1b\\\n'))).toEqual(['link']);
  });
  test('a completed line with an unterminated OSC has it stripped', () => {
    const t = new OutputTail();
    expect(t.push(enc('a\x1b]8;;http://x\nb\n'))).toEqual(['a', 'b']);
  });
  test('CRLF split between its CR and LF keeps the line', () => {
    const t = new OutputTail();
    expect(t.push(enc('abc\r'))).toEqual([]);
    expect(t.live).toBe('abc');
    expect(t.push(enc('\n'))).toEqual(['abc']);
  });
  test('a long unfinished segment ending in CR is bounded and still completes', () => {
    const t = new OutputTail();
    t.push(enc(`${'a'.repeat(9000)}\r`));
    expect(t.push(enc('bb\n'))).toEqual(['bb']);
  });
  test('an exit trailer mid-chunk is not a line, and lines after it are kept', () => {
    const t = new OutputTail();
    expect(t.push(enc('a\n[exited with code 0]\nb\n'))).toEqual(['a', 'b']);
    expect([t.lines, t.exit]).toEqual([['a', 'b'], 0]);
  });
  test('an exit trailer without its newline stays live and does not set the exit code', () => {
    const t = new OutputTail();
    expect(t.push(enc('done\n[exited with code 0]'))).toEqual(['done']);
    expect([t.live, t.exit, t.lines]).toEqual(['[exited with code 0]', null, ['done']]);
  });
});
