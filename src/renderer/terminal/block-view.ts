// Command blocks on screen: the OSC 133 parser hook and markers of one terminal, drawn as an overlay —
// a gutter bar per command (green exit 0, rose otherwise, neutral while running or when the end never came), Copy
// buttons on hover, the command pinned at the top while you scroll inside its output, ⌘↑/⌘↓ jumps.
// An overlay rather than xterm decorations: a decoration taller than the viewport disappears as soon as its first
// line scrolls out, and the bar of a long output must stay.
import type { Terminal } from '@xterm/xterm';
import { BlockModel, jumpLine, markPayload, readRange, type Block } from './blocks';
import { clickToMove } from './click-to-move';

export interface BlockActions {
  copy(text: string, what: 'output' | 'command'): void;
  words: { copyOutput: string; copyCommand: string; exit: (code: number | null) => string; jumpTo: string };
  /** The terminal's mark nonce (from atelierd); undefined: an atelierd without nonces, marks taken as they are. */
  nonce?: () => string | undefined;
  /** A shell is the terminal's foreground process (a running block there with no marks is a shell that doesn't mark). */
  shellInFront?: () => boolean;
}

/** How far the sticky line reaches into the left gutter (CSS: 5px padding + 6px dot + 7px gap). */
const STICKY_GUTTER = 18;
const STATUS_CLASS ={ running: 'is-running', ok: 'is-ok', fail: 'is-fail', unknown: 'is-unknown', prompt: '' } as const;

export class CommandBlocks {
  readonly model: BlockModel;
  private enabled = true;
  private readonly layer: HTMLDivElement;
  private readonly bars: HTMLDivElement[] = [];
  private readonly sticky: HTMLButtonElement;
  private readonly actions: HTMLDivElement;
  private hover: Block | null = null;
  private stickyBlock: Block | null = null;
  private lastJump: { line: number; ydisp: number } | null = null;
  private flash: { id: number; until: number } | null = null;
  /** The lowest line the cursor reached since the last mark (click to move: a long command's rows, see clickToMove). */
  private reached = -1;
  private raf = 0;

  constructor(private readonly term: Terminal, private readonly host: HTMLElement, private readonly act: BlockActions) {
    const buf = () => term.buffer.active;
    const cursorLine = () => buf().baseY + buf().cursorY;
    this.model = new BlockModel({
      // Marks belong to the normal screen: a full-screen app's own output is never a block.
      mark: () => (buf().type === 'normal' ? term.registerMarker(0) ?? null : null),
      cursorX: () => buf().cursorX,
      readCommand: (line, col, until) => {
        if (until !== undefined) return readRange(buf(), line, col, until);
        const cur = cursorLine();
        return cur > line ? readRange(buf(), line, col, cur - 1) : readRange(buf(), line, col, line, buf().cursorX);
      },
      now: () => performance.now()
    });
    term.parser.registerOscHandler(133, (data) => {
      // Only the marks of this terminal's own shell (its nonce): a program printing fake marks is ignored.
      const mark = markPayload(data, act.nonce?.());
      if (mark !== null && buf().type === 'normal') { this.model.handle(mark); this.reached = cursorLine(); this.schedule(); }
      return true;
    });
    // Erase in display (clear, Ctrl+L), before xterm erases (and disposes the markers on the erased lines): blocks on
    // the screen are gone, one that started in the scrollback ends above it. ED 3 (scrollback) trims the buffer and
    // disposes those markers by itself.
    term.parser.registerCsiHandler({ final: 'J' }, (params) => {
      if (params[0] === 2 && buf().type === 'normal') {
        const b = buf();
        // registerMarker takes an offset from the cursor's line.
        this.model.dropFrom(b.baseY, (line) => term.registerMarker(line - (b.baseY + b.cursorY)) ?? null);
        this.hover = null;
        this.schedule();
      }
      return false;
    });
    for (const ev of [term.onRender, term.onScroll, term.onResize, term.buffer.onBufferChange]) ev(() => this.schedule());
    term.onCursorMove(() => { if (buf().type === 'normal') this.reached = Math.max(this.reached, cursorLine()); });

    this.layer = el('div', 'cb-layer');
    this.sticky = el('button', 'cb-sticky');
    this.sticky.type = 'button';
    this.sticky.addEventListener('mousedown', (e) => e.preventDefault());
    this.sticky.addEventListener('click', () => { if (this.stickyBlock) this.scrollTo(this.stickyBlock); });
    this.actions = el('div', 'cb-actions');
    const button = (label: string, run: () => void) => {
      const b = el('button', 'cb-btn');
      b.type = 'button';
      b.textContent = label;
      // The terminal keeps the keyboard and its selection.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      return b;
    };
    this.actions.append(
      button(act.words.copyCommand, () => { if (this.hover) this.copyCommand(this.hover); }),
      button(act.words.copyOutput, () => { if (this.hover) this.copyOutput(this.hover); })
    );
    this.layer.append(this.sticky, this.actions);
    host.append(this.layer);
    // The overlay's own elements (sticky line, buttons, bars) must not stop the terminal from scrolling.
    this.layer.addEventListener('wheel', (e) => {
      e.preventDefault();
      term.element?.querySelector('.xterm-screen')?.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    host.addEventListener('mousemove', (e) => this.onMove(e.clientY));
    host.addEventListener('mouseleave', () => { if (this.hover) { this.hover = null; this.schedule(); } });
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.hover = null;
    this.schedule();
  }

  /** Forgotten on a full redraw (attach, reconnection): the snapshot carries no marks. */
  reset(): void {
    this.model.reset();
    this.hover = null; this.stickyBlock = null; this.lastJump = null;
    this.schedule();
  }

  /** ⌘↑/⌘↓ apply: blocks on, marks seen (an Atelier-profile shell), the normal screen in front. */
  canJump(): boolean {
    return this.enabled && this.model.seen && this.term.buffer.active.type === 'normal';
  }

  private cursorLine(): number { const b = this.term.buffer.active; return b.baseY + b.cursorY; }

  /** Commands (running or finished) in buffer order. */
  private commands(): Block[] {
    this.model.prune();
    return this.model.list().filter((b) => this.model.status(b) !== 'prompt');
  }

  jump(dir: 'prev' | 'next'): void {
    const buf = this.term.buffer.active;
    const starts = this.commands().map((b) => b.prompt.line);
    // Repeated jumps go on from the last target even when the viewport could not scroll that far (end of buffer).
    const anchor = this.lastJump && this.lastJump.ydisp === buf.viewportY ? this.lastJump.line
      : buf.viewportY >= buf.baseY && dir === 'prev' ? this.cursorLine() : buf.viewportY;
    const target = jumpLine(starts, dir, anchor);
    if (target === null) {
      if (dir === 'next') { this.term.scrollToBottom(); this.lastJump = null; }
      return;
    }
    this.term.scrollToLine(target);
    this.lastJump = { line: target, ydisp: this.term.buffer.active.viewportY };
    const b = this.commands().find((x) => x.prompt.line === target);
    if (b) this.flash = { id: b.id, until: performance.now() + 700 };
    this.schedule();
    setTimeout(() => this.schedule(), 720);
  }

  private scrollTo(b: Block): void {
    this.term.scrollToLine(b.prompt.line);
    this.flash = { id: b.id, until: performance.now() + 700 };
    this.schedule();
    setTimeout(() => this.schedule(), 720);
  }

  /** The output as text (no trailing blank lines), '' when it has none. */
  outputOf(b: Block): string {
    const r = this.model.outputRange(b, this.cursorLine());
    return r ? readRange(this.term.buffer.active, r.start, 0, r.end).replace(/\n+$/, '') : '';
  }

  /** The last command that finished (palette: copy its output). */
  lastFinished(): Block | null {
    return this.commands().filter((b) => b.phase === 'done').at(-1) ?? null;
  }

  copyOutput(b: Block): void { this.act.copy(this.outputOf(b), 'output'); }
  copyCommand(b: Block): void { this.act.copy(b.command, 'command'); }

  /** The command under a point of the screen (context menu, hover), when blocks are on. */
  blockAtY(clientY: number): Block | null {
    if (!this.enabled || this.term.buffer.active.type !== 'normal') return null;
    const g = this.geometry();
    if (!g) return null;
    const row = Math.floor((clientY - g.screen.top) / g.cell);
    if (row < 0 || row >= this.term.rows) return null;
    this.model.prune();
    return this.model.blockAt(this.term.buffer.active.viewportY + row, this.cursorLine());
  }

  /**
   * The arrows that move zsh's cursor to a clicked point of the command being typed,
   * or null when the point is not in it or the shell is not at its prompt.
   */
  clickMove(clientX: number, clientY: number): string | null {
    const buf = this.term.buffer.active;
    const start = this.model.inputStart();
    const g = this.geometry();
    if (buf.type !== 'normal' || !start || !g) return null;
    const row = Math.floor((clientY - g.screen.top) / g.cell);
    const col = Math.floor((clientX - g.screen.left) / (g.screen.width / this.term.cols));
    if (row < 0 || row >= this.term.rows || col < 0 || col >= this.term.cols) return null;
    const cursor = { line: buf.baseY + buf.cursorY, col: buf.cursorX };
    return clickToMove(buf, this.term.cols, start, cursor, { line: buf.viewportY + row, col }, this.term.modes.applicationCursorKeysMode, this.reached);
  }

  private onMove(clientY: number): void {
    if (!this.enabled || !this.model.seen) return;
    const b = this.blockAtY(clientY);
    if (b !== this.hover) { this.hover = b; this.schedule(); }
  }

  private geometry(): { screen: DOMRect; host: DOMRect; cell: number } | null {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !this.term.rows) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.height === 0) return null;
    return { screen: rect, host: this.host.getBoundingClientRect(), cell: rect.height / this.term.rows };
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private render(): void {
    // A shell in front that stopped marking (exec zsh, a nested shell): its running block ends here, unknown.
    this.model.expire(this.act.shellInFront?.() ?? false);
    const buf = this.term.buffer.active;
    const g = this.geometry();
    const list = this.enabled && buf.type === 'normal' && g ? this.commands() : [];
    this.layer.hidden = list.length === 0;
    if (!g || list.length === 0) {
      for (const b of this.bars) b.hidden = true;
      this.sticky.hidden = true; this.actions.hidden = true; this.stickyBlock = null;
      return;
    }
    const top = buf.viewportY;
    const bottom = top + this.term.rows - 1;
    const cursor = this.cursorLine();
    const offTop = g.screen.top - g.host.top;
    const offLeft = g.screen.left - g.host.left;
    const now = performance.now();
    let used = 0;
    for (const b of list) {
      const r = this.model.range(b, cursor);
      if (r.end < top || r.start > bottom) continue;
      const from = Math.max(r.start, top);
      const to = Math.min(r.end, bottom);
      const bar = this.bars[used] ?? this.newBar();
      used++;
      const status = this.model.status(b);
      bar.className = `cb-bar ${STATUS_CLASS[status]}${r.start < top ? ' is-cut-top' : ''}${r.end > bottom ? ' is-cut-bottom' : ''}${this.flash && this.flash.id === b.id && this.flash.until > now ? ' is-flash' : ''}${this.hover === b ? ' is-hover' : ''}`;
      bar.dataset.status = status;
      bar.dataset.block = String(b.id);
      bar.dataset.tip = status === 'running' ? b.command : `${this.act.words.exit(b.exitCode)}${b.command ? ` · ${b.command}` : ''}`;
      bar.style.top = `${offTop + (from - top) * g.cell}px`;
      bar.style.height = `${(to - from + 1) * g.cell}px`;
      bar.style.left = `${offLeft}px`;
      bar.hidden = false;
    }
    for (let i = used; i < this.bars.length; i++) this.bars[i]!.hidden = true;

    // Sticky command: the top line is inside a command's block, below its prompt line.
    const at = this.model.blockAt(top, cursor);
    const sticky = at && at.prompt.line < top && at.command ? at : null;
    this.stickyBlock = sticky;
    this.sticky.hidden = !sticky;
    if (sticky) {
      const status = this.model.status(sticky);
      this.sticky.className = `cb-sticky ${STATUS_CLASS[status]}`;
      this.sticky.textContent = sticky.command;
      this.sticky.dataset.tip = this.act.words.jumpTo;
      this.sticky.style.top = `${offTop}px`;
      // From the gutter (its status dot lines up with the bars) to the screen's right edge; the text on the columns.
      this.sticky.style.left = `${offLeft - STICKY_GUTTER}px`;
      this.sticky.style.width = `${g.screen.width + STICKY_GUTTER}px`;
      // Exactly the top row: the line under it stays readable.
      this.sticky.style.height = `${g.cell}px`;
      this.sticky.style.fontSize = `${this.term.options.fontSize ?? 13}px`;
    }

    // Hover buttons: at the right, on the block's first visible line (under the sticky line when it is there).
    const h = this.hover && list.includes(this.hover) ? this.hover : null;
    this.actions.hidden = !h;
    if (h) {
      const r = this.model.range(h, cursor);
      if (r.end < top || r.start > bottom) { this.actions.hidden = true; return; }
      const row = Math.max(r.start, top) + (sticky === h ? 1 : 0);
      this.actions.style.top = `${offTop + (row - top) * g.cell}px`;
      this.actions.style.right = `${g.host.right - g.screen.right + 8}px`;
      const [cmd, out] = this.actions.children as unknown as [HTMLButtonElement, HTMLButtonElement];
      cmd.hidden = !h.command;
      out.hidden = this.model.outputRange(h, cursor) === null;
      if (cmd.hidden && out.hidden) this.actions.hidden = true;
    }
  }

  private newBar(): HTMLDivElement {
    const bar = el('div', 'cb-bar');
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    // A bar leads to its command's first line.
    bar.addEventListener('click', () => {
      const b = this.commands().find((x) => String(x.id) === bar.dataset.block);
      if (b) this.scrollTo(b);
    });
    this.layer.prepend(bar);
    this.bars.push(bar);
    return bar;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  e.hidden = true;
  return e;
}
