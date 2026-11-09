// Command blocks: the OSC 133 marks the Atelier zsh profile emits — A prompt start, B command start,
// C output start, D;<exit code> end — turned into blocks anchored to xterm markers. Pure: xterm is behind BlockEnv,
// so the model is tested without a terminal.

/** A line that follows the buffer (an xterm IMarker): it moves on trim/reflow and is disposed when its line goes. */
export interface LineRef { readonly line: number; readonly isDisposed: boolean; dispose(): void }

export interface BlockEnv {
  /** A marker on the cursor's line right now (null if the terminal can't make one). */
  mark(): LineRef | null;
  cursorX(): number;
  /**
   * The command typed from (line, col) up to the end of `until`, or (without it) up to the cursor (called at C, when
   * Enter has moved the cursor down).
   */
  readCommand(line: number, col: number, until?: number): string;
  /** A clock (ms) for marks that stop coming; without it a silent shell is only noticed at the next prompt. */
  now?(): number;
}

/** A running command with a shell in front and no mark for this long: that shell does not mark (exec zsh, nested). */
export const SILENT_SHELL_MS = 10_000;

/**
 * The OSC 133 payload to act on, or null. Atelier's shell adds its terminal's nonce (`atelier=<nonce>`) to every mark;
 * with a nonce known, marks without it (a program printing fake marks) are ignored. Without one (an atelierd from
 * before nonces) marks are taken as they are. Returns the kind with D's exit code ("A", "D;1", "D").
 */
export function markPayload(data: string, nonce: string | undefined): string | null {
  const [kind, ...params] = data.split(';');
  if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return null;
  if (nonce !== undefined && !params.includes(`atelier=${nonce}`)) return null;
  const code = kind === 'D' ? params.find((p) => !p.includes('=')) : undefined;
  return code !== undefined ? `${kind};${code}` : kind;
}

export type BlockPhase = 'prompt' | 'input' | 'running' | 'done';
export type BlockStatus = 'prompt' | 'running' | 'ok' | 'fail' | 'unknown';

export interface Block {
  id: number;
  /** A: where the block starts (the prompt line). */
  prompt: LineRef;
  /** B: where the typed command starts. */
  cmd: { ref: LineRef; col: number } | null;
  /** B again while typing (after each PS2 continuation prompt): where each continuation line's text starts. */
  more: { ref: LineRef; col: number }[];
  /** C: the first output line. */
  output: LineRef | null;
  /** D, or the next prompt when D never came: where the output ends. */
  end: { ref: LineRef; col: number } | null;
  /** D's code; null while running, when D carried none, or when it never came. */
  exitCode: number | null;
  phase: BlockPhase;
  command: string;
}

export interface Range { start: number; end: number }

const MAX_BLOCKS = 2000;

export class BlockModel {
  private blocks: Block[] = [];
  private nextId = 1;
  private lastMark = 0;
  /** Marks seen at least once: the terminal speaks OSC 133 (an Atelier-profile shell). */
  seen = false;

  constructor(private readonly env: BlockEnv, private readonly max = MAX_BLOCKS) {}

  list(): readonly Block[] { return this.blocks; }

  /** The open block (prompt, typing or running), if the last one is not finished. */
  private open(): Block | null {
    const b = this.blocks.at(-1);
    return b && b.phase !== 'done' ? b : null;
  }

  private start(): Block | null {
    const prompt = this.env.mark();
    if (!prompt) return null;
    const b: Block = { id: this.nextId++, prompt, cmd: null, more: [], output: null, end: null, exitCode: null, phase: 'prompt', command: '' };
    this.blocks.push(b);
    while (this.blocks.length > this.max) release(this.blocks.shift()!);
    return b;
  }

  /**
   * Where the text zsh still lets you edit starts: the last B of a block being typed (after a PS2 continuation prompt,
   * the lines above are history to zsh). Null unless the shell is at its prompt.
   */
  inputStart(): { line: number; col: number } | null {
    const b = this.open();
    if (b?.phase !== 'input') return null;
    const last = b.more.at(-1) ?? b.cmd;
    return last && !last.ref.isDisposed ? { line: last.ref.line, col: last.col } : null;
  }

  /** One OSC 133 payload ("A", "B", "C", "D;0", "D"); anything else is ignored. */
  handle(payload: string): void {
    const [kind, arg] = payload.split(';', 2);
    if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return;
    this.seen = true;
    this.lastMark = this.env.now?.() ?? 0;
    const cur = this.open();
    switch (kind) {
      case 'A': {
        if (cur && (cur.phase === 'prompt' || cur.phase === 'input')) {
          // The same prompt drawn again (resize, reset-prompt, an empty Enter): it moves, nothing ends.
          const ref = this.env.mark();
          if (!ref) return;
          cur.prompt.dispose(); cur.cmd?.ref.dispose(); releaseMore(cur);
          cur.prompt = ref; cur.cmd = null; cur.phase = 'prompt';
          return;
        }
        // A command that never said how it ended: closed here, status unknown.
        if (cur?.phase === 'running') this.finish(cur, null);
        this.start();
        return;
      }
      case 'B': {
        const b = cur && cur.phase !== 'running' ? cur : this.start();
        if (!b) return;
        const ref = this.env.mark();
        if (!ref) return;
        const col = this.env.cursorX();
        const last = b.more.at(-1) ?? b.cmd;
        if (b.phase === 'input' && last && !last.ref.isDisposed && ref.line > b.cmd!.ref.line) {
          // B again with no A: the end of a PS2 continuation prompt; the same line again is that prompt redrawn.
          if (last !== b.cmd && last.ref.line === ref.line) { last.ref.dispose(); b.more[b.more.length - 1] = { ref, col }; }
          else if (ref.line > last.ref.line) b.more.push({ ref, col });
          else ref.dispose();
          return;
        }
        b.cmd?.ref.dispose(); releaseMore(b);
        b.cmd = { ref, col };
        b.phase = 'input';
        return;
      }
      case 'C': {
        const b = cur && cur.phase !== 'running' ? cur : this.start();
        if (!b) return;
        b.command = b.cmd ? this.readCommand(b) : '';
        b.output = this.env.mark();
        b.phase = 'running';
        return;
      }
      case 'D': {
        if (cur?.phase !== 'running') return;
        const code = arg !== undefined && /^-?\d{1,4}$/.test(arg) ? Number(arg) : null;
        this.finish(cur, code);
        return;
      }
    }
  }

  /** The typed command: the first line from B, each continuation line from its own B (PS2 prompts left out). */
  private readCommand(b: Block): string {
    const parts = [b.cmd!, ...b.more.filter((m) => !m.ref.isDisposed)];
    const text = parts.map((p, i) => {
      const next = parts[i + 1];
      return next ? this.env.readCommand(p.ref.line, p.col, next.ref.line - 1) : this.env.readCommand(p.ref.line, p.col);
    }).join('\n');
    return text.trim();
  }

  /**
   * A running command that has had no mark for SILENT_SHELL_MS while a shell is in front: that shell doesn't mark
   * (exec zsh, a nested shell with the user's own config), so the block ends here with an unknown status instead of
   * running forever. True if it did.
   */
  expire(shellInFront: boolean): boolean {
    const cur = this.open();
    if (!shellInFront || cur?.phase !== 'running' || !this.env.now) return false;
    if (this.env.now() - this.lastMark < SILENT_SHELL_MS) return false;
    this.finish(cur, null);
    return true;
  }

  private finish(b: Block, code: number | null): void {
    const ref = this.env.mark();
    b.end = ref ? { ref, col: this.env.cursorX() } : null;
    b.exitCode = code;
    b.phase = 'done';
  }

  status(b: Block): BlockStatus {
    if (b.phase === 'prompt' || b.phase === 'input') return 'prompt';
    if (b.phase === 'running') return 'running';
    if (b.exitCode === null) return 'unknown';
    return b.exitCode === 0 ? 'ok' : 'fail';
  }

  /** The last line of a block's output, or the cursor's line while it runs. */
  private outputEnd(b: Block, cursorLine: number): number {
    if (b.phase !== 'done') return cursorLine;
    // Its end was erased without a new anchor: never follow the cursor, keep what is known to be there.
    if (!b.end || b.end.ref.isDisposed) return b.output && !b.output.isDisposed ? b.output.line : b.prompt.line;
    // A D at the start of a line comes after the output's last newline.
    return b.end.col === 0 ? b.end.ref.line - 1 : b.end.ref.line;
  }

  /** From the prompt to the output's last line. */
  range(b: Block, cursorLine: number): Range {
    const start = b.prompt.line;
    if (b.phase === 'prompt' || b.phase === 'input') return { start, end: Math.max(start, b.cmd?.ref.line ?? start) };
    const out = b.output && !b.output.isDisposed ? b.output.line : start + 1;
    return { start, end: Math.max(start, out - 1, this.outputEnd(b, cursorLine)) };
  }

  /** Output lines (null when there are none). */
  outputRange(b: Block, cursorLine: number): Range | null {
    if (!b.output || b.output.isDisposed || b.phase === 'prompt' || b.phase === 'input') return null;
    const r = { start: b.output.line, end: this.outputEnd(b, cursorLine) };
    return r.end >= r.start ? r : null;
  }

  /** The command (running or finished) whose block covers `line`. */
  blockAt(line: number, cursorLine: number): Block | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (b.phase === 'prompt' || b.phase === 'input' || b.prompt.isDisposed) continue;
      const r = this.range(b, cursorLine);
      if (line >= r.start && line <= r.end) return b;
      if (r.end < line) return null;
    }
    return null;
  }

  /** Blocks whose prompt left the buffer (scrollback trim, clear) go away. True if any did. */
  prune(): boolean {
    const keep = this.blocks.filter((b) => !b.prompt.isDisposed);
    if (keep.length === this.blocks.length) return false;
    for (const b of this.blocks) if (b.prompt.isDisposed) release(b);
    this.blocks = keep;
    return true;
  }

  /**
   * The screen is about to be erased from `line` down (clear, Ctrl+L): blocks starting there are gone, the running
   * one too; a finished block that started above keeps the lines above (its end re-anchored with `markAt`).
   */
  dropFrom(line: number, markAt?: (line: number) => LineRef | null): void {
    const keep = this.blocks.filter((b) => !b.prompt.isDisposed && b.prompt.line < line);
    for (const b of this.blocks) if (!keep.includes(b)) release(b);
    this.blocks = keep;
    if (!markAt || line < 1) return;
    for (const b of keep) {
      if (b.phase !== 'done' || this.outputEnd(b, line) < line) continue;
      const ref = markAt(line - 1);
      if (!ref) continue;
      b.end?.ref.dispose();
      // Not at column 0: the line itself is the output's last.
      b.end = { ref, col: 1 };
    }
  }

  reset(): void {
    for (const b of this.blocks) release(b);
    this.blocks = [];
  }
}

function releaseMore(b: Block): void {
  for (const m of b.more) m.ref.dispose();
  b.more = [];
}

function release(b: Block): void {
  b.prompt.dispose(); b.cmd?.ref.dispose(); b.output?.dispose(); b.end?.ref.dispose(); releaseMore(b);
}

/** ⌘↑ / ⌘↓: the command starting before / after `anchor` (block starts in buffer order). */
export function jumpLine(starts: readonly number[], dir: 'prev' | 'next', anchor: number): number | null {
  if (dir === 'prev') {
    for (let i = starts.length - 1; i >= 0; i--) if (starts[i]! < anchor) return starts[i]!;
    return null;
  }
  for (const s of starts) if (s > anchor) return s;
  return null;
}

/** The parts of xterm's IBuffer read here. */
export interface BufferLike {
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string } | undefined;
}

/**
 * Text from (fromLine, fromCol) to toLine (up to toCol, exclusive, on the last line): one line per logical line —
 * a wrapped line continues the one before it — with trailing blanks trimmed.
 */
export function readRange(buf: BufferLike, fromLine: number, fromCol: number, toLine: number, toCol?: number): string {
  let out = '';
  for (let y = fromLine; y <= toLine; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    const next = y < toLine ? buf.getLine(y + 1) : undefined;
    // A line that wraps into the next keeps its trailing characters: they are part of the same logical line.
    const continues = !!next?.isWrapped;
    const text = line.translateToString(!continues, y === fromLine ? fromCol : 0, y === toLine ? toCol : undefined);
    out += y > fromLine && !line.isWrapped ? '\n' + text : text;
  }
  return out;
}
