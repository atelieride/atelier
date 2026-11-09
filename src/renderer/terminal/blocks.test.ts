import { describe, expect, test } from 'vitest';
import { BlockModel, jumpLine, markPayload, readRange, type BlockEnv, type BufferLike, type LineRef } from './blocks';

/** A marker like xterm's: a line that moves when the buffer is trimmed, disposed when its line goes away. */
class Ref implements LineRef {
  isDisposed = false;
  constructor(public line: number) {}
  dispose() { this.isDisposed = true; this.line = -1; }
}

/** A fake terminal: a cursor, markers, and the text typed for each command. */
function fake() {
  const cur = { line: 0, x: 0 };
  const refs: Ref[] = [];
  const commands = new Map<number, string>();
  const env: BlockEnv = {
    mark: () => { const r = new Ref(cur.line); refs.push(r); return r; },
    cursorX: () => cur.x,
    readCommand: (line) => commands.get(line) ?? ''
  };
  const model = new BlockModel(env);
  /** Moves the cursor, then the mark arrives there. */
  const at = (line: number, x: number, mark: string) => { cur.line = line; cur.x = x; model.handle(mark); };
  /** A whole command: prompt at `line`, `out` output lines, exit code (null: no D). */
  const run = (line: number, cmd: string, out: number, code: number | null) => {
    at(line, 0, 'A'); at(line, 8, 'B'); commands.set(line, cmd);
    at(line + 1, 0, 'C');
    if (code !== null) at(line + 1 + out, 0, `D;${code}`);
    return line + 1 + out;
  };
  return { cur, refs, model, at, run, trim: (n: number) => { for (const r of refs) { if (r.isDisposed) continue; r.line -= n; if (r.line < 0) r.dispose(); } } };
}

describe('block model', () => {
  test('A B C D: one finished block with its command, exit code and output range', () => {
    const f = fake();
    f.run(0, 'ls -la', 3, 0);
    f.at(4, 0, 'A'); f.at(4, 8, 'B');
    const [b, open] = f.model.list();
    expect(f.model.list()).toHaveLength(2);
    expect(b!.command).toBe('ls -la');
    expect(f.model.status(b!)).toBe('ok');
    expect(f.model.range(b!, 4)).toEqual({ start: 0, end: 3 });
    expect(f.model.outputRange(b!, 4)).toEqual({ start: 1, end: 3 });
    // The prompt being typed is not a command yet: no bar.
    expect(f.model.status(open!)).toBe('prompt');
  });

  test('exit codes: non-zero fails; a command without output has no output range', () => {
    const f = fake();
    let next = f.run(0, 'false', 0, 1);
    next = f.run(next, 'true', 0, 0);
    const [a, b] = f.model.list();
    expect(f.model.status(a!)).toBe('fail');
    expect(a!.exitCode).toBe(1);
    expect(f.model.status(b!)).toBe('ok');
    expect(f.model.outputRange(a!, next)).toBeNull();
    expect(f.model.range(a!, next)).toEqual({ start: 0, end: 0 });
  });

  test('a running command reaches the cursor; output without a trailing newline ends on the D line', () => {
    const f = fake();
    f.at(0, 0, 'A'); f.at(0, 8, 'B'); f.at(1, 0, 'C');
    const [b] = f.model.list();
    expect(f.model.status(b!)).toBe('running');
    expect(f.model.range(b!, 7)).toEqual({ start: 0, end: 7 });
    expect(f.model.outputRange(b!, 7)).toEqual({ start: 1, end: 7 });
    f.at(5, 3, 'D;0');
    expect(f.model.outputRange(b!, 9)).toEqual({ start: 1, end: 5 });
  });

  test('a repeated A on the prompt (redraw after a resize, an empty Enter) is the same prompt, moved', () => {
    const f = fake();
    f.at(0, 0, 'A'); f.at(0, 8, 'B');
    f.at(0, 0, 'A'); f.at(0, 8, 'B');
    f.at(1, 0, 'A'); f.at(1, 8, 'B');
    expect(f.model.list()).toHaveLength(1);
    expect(f.model.list()[0]!.prompt.line).toBe(1);
    // The replaced markers are released.
    expect(f.refs.filter((r) => !r.isDisposed).map((r) => r.line)).toEqual([1, 1]);
  });

  test('a missing D: the next prompt closes the block with an unknown status', () => {
    const f = fake();
    f.at(0, 0, 'A'); f.at(0, 8, 'B'); f.at(1, 0, 'C');
    f.at(6, 0, 'A');
    const [b] = f.model.list();
    expect(f.model.status(b!)).toBe('unknown');
    expect(f.model.outputRange(b!, 6)).toEqual({ start: 1, end: 5 });
    expect(f.model.list()).toHaveLength(2);
  });

  test('marks out of order: B, C or D without what comes before never break the model', () => {
    const f = fake();
    f.at(0, 0, 'D;0');
    expect(f.model.list()).toHaveLength(0);
    f.at(0, 0, 'C');
    expect(f.model.list()).toHaveLength(1);
    expect(f.model.status(f.model.list()[0]!)).toBe('running');
    f.at(2, 0, 'D;2');
    expect(f.model.status(f.model.list()[0]!)).toBe('fail');
    f.at(3, 4, 'B');
    expect(f.model.list()).toHaveLength(2);
    f.model.handle('Z;junk'); f.model.handle(''); f.model.handle('D;notanumber');
    expect(f.model.list()).toHaveLength(2);
  });

  test('a nested shell (marks inside a running command) degrades to plain blocks', () => {
    const f = fake();
    f.at(0, 0, 'A'); f.at(0, 8, 'B'); f.at(1, 0, 'C'); // zsh
    f.run(2, 'echo hi', 1, 0); // inside it
    f.at(4, 0, 'A'); f.at(4, 8, 'B');
    f.at(5, 0, 'D;0'); // the outer zsh exits: no running block to close, ignored
    const st = f.model.list().map((b) => f.model.status(b));
    expect(st).toEqual(['unknown', 'ok', 'prompt']);
  });

  test('scrollback trim: blocks whose prompt left the buffer disappear', () => {
    const f = fake();
    let next = f.run(0, 'a', 2, 0);
    next = f.run(next, 'b', 2, 0);
    f.trim(2);
    expect(f.model.prune()).toBe(true);
    expect(f.model.list().map((b) => b.command)).toEqual(['b']);
    expect(f.model.prune()).toBe(false);
  });

  test('clear screen: blocks shown from a line on are dropped, the earlier ones stay', () => {
    const f = fake();
    let next = f.run(0, 'a', 2, 0);
    next = f.run(next, 'b', 2, 0);
    f.at(next, 0, 'A'); f.at(next, 8, 'B'); f.at(next + 1, 0, 'C'); // `clear` running
    f.model.dropFrom(3);
    expect(f.model.list().map((b) => b.command)).toEqual(['a']);
    // Its D now has nothing to close.
    f.at(0, 0, 'D;0');
    expect(f.model.list()).toHaveLength(1);
  });

  test('clear screen under a long output: the block keeps the lines above the erased screen', () => {
    const f = fake();
    const next = f.run(0, 'ls', 20, 0); // output 1..20, D on 21
    f.at(next, 0, 'A'); f.at(next, 8, 'B');
    // The screen shows lines 15..; Ctrl+L erases it (xterm then disposes the markers on erased lines).
    f.model.dropFrom(15, (line) => { const r = new Ref(line); f.refs.push(r); return r; });
    for (const r of f.refs) if (!r.isDisposed && r.line >= 15) r.dispose();
    f.model.prune();
    const [b] = f.model.list();
    expect(f.model.list()).toHaveLength(1);
    expect(f.model.range(b!, 40)).toEqual({ start: 0, end: 14 });
  });

  test('a finished block whose end marker is gone never follows the cursor', () => {
    const f = fake();
    f.run(0, 'ls', 3, 0);
    const [b] = f.model.list();
    b!.end!.ref.dispose();
    expect(f.model.range(b!, 50).end).toBeLessThan(50);
    expect(f.model.outputRange(b!, 50)).toEqual({ start: 1, end: 1 });
  });

  test('reset forgets everything and releases the markers', () => {
    const f = fake();
    f.run(0, 'a', 2, 0);
    f.model.reset();
    expect(f.model.list()).toEqual([]);
    expect(f.refs.every((r) => r.isDisposed)).toBe(true);
  });

  test('bounded: the oldest blocks go first', () => {
    const f = fake();
    const m = new BlockModel({ mark: () => new Ref(f.cur.line), cursorX: () => 0, readCommand: () => 'x' }, 3);
    for (let i = 0; i < 5; i++) { f.cur.line = i * 2; m.handle('A'); m.handle('C'); f.cur.line = i * 2 + 1; m.handle('D;0'); }
    expect(m.list().map((b) => b.prompt.line)).toEqual([4, 6, 8]);
  });

  test('blockAt: the finished or running block covering a line, never the bare prompt', () => {
    const f = fake();
    const next = f.run(0, 'a', 2, 0);
    f.at(next, 0, 'A'); f.at(next, 8, 'B');
    expect(f.model.blockAt(1, next)?.command).toBe('a');
    expect(f.model.blockAt(next, next)).toBeNull();
    expect(f.model.blockAt(99, next)).toBeNull();
  });
});

describe('block model: continuation prompts, silent shells, marks with a nonce', () => {
  /** A fake whose readCommand reads real line texts, as the view does (to the line before the cursor by default). */
  function withText(lines: string[]) {
    const cur = { line: 0, x: 0 };
    let clock = 0;
    const env: BlockEnv = {
      mark: () => new Ref(cur.line),
      cursorX: () => cur.x,
      readCommand: (line, col, until) => {
        const last = until ?? cur.line - 1;
        const out: string[] = [];
        for (let y = line; y <= last; y++) out.push((lines[y] ?? '').slice(y === line ? col : 0));
        return out.join('\n');
      },
      now: () => clock
    };
    const model = new BlockModel(env);
    const at = (line: number, x: number, mark: string) => { cur.line = line; cur.x = x; model.handle(mark); };
    return { model, at, tick: (ms: number) => { clock += ms; } };
  }

  test('a multi-line command: its PS2 continuation prompts (each followed by B) are not part of Copy command', () => {
    const f = withText(['~/p › for i in 1 2; do', 'for> echo $i', 'for> done', '1', '2']);
    f.at(0, 0, 'A'); f.at(0, 6, 'B');
    f.at(1, 5, 'B');
    f.at(2, 5, 'B');
    // zle redraws the continuation line (resize): the same line, read once.
    f.at(2, 5, 'B');
    f.at(3, 0, 'C'); f.at(5, 0, 'D;0');
    const [b] = f.model.list();
    expect(b!.command).toBe('for i in 1 2; do\necho $i\ndone');
    expect(f.model.range(b!, 5)).toEqual({ start: 0, end: 4 });
  });

  test('a shell that stops marking (exec zsh, a nested shell): the running block ends as unknown once a shell is in front and no mark came for a while', () => {
    const f = withText(['~/p › exec zsh', 'user prompt %']);
    f.at(0, 0, 'A'); f.at(0, 6, 'B'); f.at(1, 0, 'C');
    const [b] = f.model.list();
    f.tick(60_000);
    // A long command (not a shell in front) keeps running however long it takes.
    expect(f.model.expire(false)).toBe(false);
    expect(f.model.status(b!)).toBe('running');
    f.tick(-60_000 + 2_000);
    expect(f.model.expire(true)).toBe(false);
    f.tick(10_000);
    expect(f.model.expire(true)).toBe(true);
    expect(f.model.status(b!)).toBe('unknown');
    // Its late D (the nested shell exits) changes nothing; the parent's next prompt starts a new block.
    f.at(3, 0, 'D;0');
    expect(f.model.status(b!)).toBe('unknown');
    f.at(4, 0, 'A');
    expect(f.model.list()).toHaveLength(2);
  });

  test('marks carry the shell nonce: without it (a program printing fake marks) they are ignored', () => {
    expect(markPayload('A;atelier=n0nce', 'n0nce')).toBe('A');
    expect(markPayload('D;1;atelier=n0nce', 'n0nce')).toBe('D;1');
    expect(markPayload('D;atelier=n0nce', 'n0nce')).toBe('D');
    expect(markPayload('B;atelier=n0nce;aid=7', 'n0nce')).toBe('B');
    for (const fake of ['A', 'D;1', 'C;atelier=other', 'D;0;atelier=n0nc', 'B;atelier=']) expect(markPayload(fake, 'n0nce'), fake).toBeNull();
    // An atelierd without nonces (older build): marks as they are.
    expect(markPayload('D;2', undefined)).toBe('D;2');
    expect(markPayload('A;atelier=x', undefined)).toBe('A');
    expect(markPayload('Z;atelier=n0nce', 'n0nce')).toBeNull();
  });
});

describe('jump targets', () => {
  const starts = [0, 10, 20, 30];
  test('previous: the last command starting above the anchor; next: the first below', () => {
    expect(jumpLine(starts, 'prev', 25)).toBe(20);
    expect(jumpLine(starts, 'prev', 20)).toBe(10);
    expect(jumpLine(starts, 'prev', 0)).toBeNull();
    expect(jumpLine(starts, 'next', 10)).toBe(20);
    expect(jumpLine(starts, 'next', 30)).toBeNull();
    expect(jumpLine([], 'prev', 5)).toBeNull();
  });
});

describe('reading text from the buffer', () => {
  const buf = (lines: { text: string; wrapped?: boolean }[]): BufferLike => ({
    getLine: (y) => {
      const l = lines[y];
      return l && { isWrapped: !!l.wrapped, translateToString: (trim?: boolean, start = 0, end?: number) => { const s = l.text.slice(start, end); return trim ? s.replace(/\s+$/, '') : s; } };
    }
  });
  test('lines joined with newlines, wrapped lines continue the previous one, trailing blanks trimmed', () => {
    const b = buf([{ text: '~/p › ls -la   ' }, { text: 'a.txt  ' }, { text: 'very long li' }, { text: 'ne continues', wrapped: true }, { text: '' }]);
    expect(readRange(b, 0, 6, 0)).toBe('ls -la');
    expect(readRange(b, 1, 0, 3)).toBe('a.txt\nvery long line continues');
    expect(readRange(b, 1, 0, 4)).toBe('a.txt\nvery long line continues\n');
    expect(readRange(b, 0, 6, 0, 8)).toBe('ls');
    expect(readRange(b, 3, 0, 1)).toBe('');
    expect(readRange(b, 7, 0, 9)).toBe('');
  });
});

describe('input start (click to move the cursor)', () => {
  test('B in phase input: where the typed command starts; none before B, while running or once finished', () => {
    const f = fake();
    expect(f.model.inputStart()).toBeNull();
    f.at(0, 0, 'A');
    expect(f.model.inputStart()).toBeNull();
    f.at(0, 8, 'B');
    expect(f.model.inputStart()).toEqual({ line: 0, col: 8 });
    f.at(1, 0, 'C');
    expect(f.model.inputStart()).toBeNull();
    f.at(2, 0, 'D;0');
    expect(f.model.inputStart()).toBeNull();
  });

  test('after a PS2 continuation prompt: the last B (earlier lines are history to zsh)', () => {
    const f = fake();
    f.at(0, 0, 'A'); f.at(0, 8, 'B');
    f.at(1, 5, 'B');
    expect(f.model.inputStart()).toEqual({ line: 1, col: 5 });
  });

  test('a start whose line left the buffer: none', () => {
    const f = fake();
    f.at(0, 0, 'A'); f.at(0, 8, 'B');
    f.trim(1);
    expect(f.model.inputStart()).toBeNull();
  });
});
