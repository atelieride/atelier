// A scripted Claude Code session in the demo: its screen (claude-screen.ts) and what the visitor's
// keys do to it — arrows and digits move through a permission or a question, Enter answers, Esc says no; in the prompt,
// typed and pasted text edits the line and Enter submits it — and the beats it plays (beats.ts): the session's own when
// the demo starts, then a diagnosis or a free-prompt beat for each prompt. The session's state only ever changes by the
// compiled patches, stamped on its terminal; its edits go through the working tree, attributed to it.
import type { Attribution } from '@shared/attribution';
import type { TerminalInfo } from '@shared/protocol';
import type { DemoContext } from '../bridge/context';
import { notInDemo } from '../bridge/not-in-demo';
import { applyCost, applyPatch, applyWrite, beatForPrompt, play, type BeatHost, type Playing, type Vars } from './beats';
import type { BeatAsk } from './beats-types';
import { SPINNER_GLYPHS, choicesOf, claudeScreen, spinnerFrame, type ClaudeScreen } from './claude-screen';
import type { Cancel } from './clock';
import { createKeyReader, type Key } from './keys';

/** What a program (a Claude screen, the shell) needs of its terminal. */
export interface TermHost {
  readonly id: string;
  /** The terminal as the renderer knows it now. */
  info(): TerminalInfo | undefined;
  /** Changes it; the list goes out to the renderer (on.terminals). */
  update(f: (t: TerminalInfo) => TerminalInfo): void;
  /** Bytes for the screen: sent while a window is attached. */
  write(data: string): void;
  size(): { cols: number; rows: number };
}

/** A terminal's program: what attaching shows, what input does. */
export interface Program {
  snapshot(): string;
  input(data: string): void;
  /** The terminal was resized (Claude redraws, as on SIGWINCH). */
  resize(): void;
  dispose(): void;
}

export interface ClaudeOptions {
  screen: ClaudeScreen;
  /** The beat the session is in when the demo starts (it waits on its menu, or plays now). */
  beat?: string;
  /** Picks the beat for a submitted prompt (the free-prompt beats go in turn across sessions). */
  pick?: (text: string) => string;
}

const ESC = '\u001b';
const RST = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
/** Claude Code's prompt mode on: pastes arrive bracketed (the renderer's "send to session" checks it). */
const PASTE_MODE = `${ESC}[?2004h`;
const SPIN_MS = 120;
/** A paste longer than this, or with a line break, shows as a placeholder in the prompt, as Claude Code does. */
const PASTE_INLINE = 200;

/** The first line of a prompt, without control characters, at most 60 characters: the session's automatic title. */
export function autoTitleOf(text: string): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export function createClaude(ctx: DemoContext, host: TermHost, o: ClaudeOptions): Program {
  const beats = ctx.world.beats;
  const read = createKeyReader();
  const model: ClaudeScreen = { ...o.screen, transcript: [...o.screen.transcript] };
  let selected = 0;
  let ask: BeatAsk | null = null;
  /** The "Type something" answer being typed. */
  let answering = false;
  let busy = false;
  let input = '';
  const pastes = new Map<string, string>();
  let vars: Vars = {};
  let playing: Playing | null = null;
  let beat = o.beat ? beats.beats[o.beat] ?? null : null;
  /** Whose turn is playing: the session's scripted one, the visitor's latest prompt, or none (Claude at its prompt). */
  let turn: 'scripted' | 'prompt' | null = beat ? 'scripted' : null;
  let spin: Cancel | null = null;
  let ticks = 0;

  /**
   * The turn ended (its Stop, or Esc): Ask reads how. The scripted turn keeps what its
   * terminal had printed by then, styles dropped; the visitor's prompt is marked finished or interrupted.
   */
  const turnEnded = (interrupted: boolean) => {
    if (turn === 'scripted') {
      const output = model.transcript.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
      ctx.state.scripted.set(host.id, { interrupted, output });
    } else if (turn === 'prompt') {
      const list = ctx.state.prompts.get(host.id);
      const last = list?.at(-1);
      if (list && last) ctx.state.prompts.set(host.id, [...list.slice(0, -1), { ...last, outcome: interrupted ? 'interrupted' : 'finished' }]);
    }
    turn = null;
  };

  const size = () => host.size();
  const draw = () => { const { cols, rows } = size(); return claudeScreen({ ...model, input }, rows, cols, { selected }); };
  const redraw = () => host.write(draw());

  // The spinner: its glyph every 120 ms, the seconds and tokens every second (only a line is redrawn).
  const startSpinner = (elapsed: number) => {
    model.glyph = SPINNER_GLYPHS[0];
    model.elapsed = elapsed;
    model.tokens = model.tokens ?? elapsed * 47;
    if (spin) return;
    ticks = 0;
    spin = ctx.clock.every(SPIN_MS, () => {
      ticks++;
      model.glyph = SPINNER_GLYPHS[ticks % SPINNER_GLYPHS.length];
      if (ticks % Math.round(1000 / SPIN_MS) === 0) {
        model.elapsed = (model.elapsed ?? 0) + 1;
        model.tokens = (model.tokens ?? 0) + 20 + Math.floor(Math.random() * 60);
      }
      const { cols, rows } = size();
      host.write(spinnerFrame({ ...model, input }, rows, cols));
    });
  };
  const stopSpinner = () => { spin?.(); spin = null; };

  const attribution = (file: string): Attribution | undefined => {
    const t = host.info();
    if (!t) return undefined;
    return { path: `${ctx.world.project.root}/${file}`, terminalId: t.id, sessionId: t.session?.sessionId ?? '', color: t.color, title: t.title, at: ctx.now() };
  };

  const beatHost: BeatHost = {
    clock: ctx.clock,
    line(text, replaceLast) {
      if (replaceLast && model.transcript.length) model.transcript[model.transcript.length - 1] = text;
      else model.transcript.push(text);
    },
    spinner(text) {
      const was = model.state === 'working';
      model.state = 'working';
      model.spinner = text;
      busy = true;
      if (!was || !spin) startSpinner(model.elapsed ?? 0);
    },
    prompt() {
      stopSpinner();
      model.state = 'done';
      busy = false;
      playing = null;
      turnEnded(false);
    },
    ask(a) {
      stopSpinner();
      ask = a;
      selected = 0;
      busy = false;
      if (a.kind === 'permission') {
        model.state = 'permission';
        if (a.view) { model.permission = a.view; delete model.command; } else { model.command = a.command ?? ''; delete model.permission; }
      } else {
        model.state = 'question';
        model.options = a.options;
      }
    },
    session(p) { host.update((t) => applyPatch(t, p, ctx.now())); },
    cost(c) { host.update((t) => applyCost(t, c)); },
    write(w) {
      const next = applyWrite(ctx.state.files[w.file], w, vars);
      if (next !== null) ctx.worktree.write(w.file, next, attribution(w.file));
    },
    redraw
  };

  const run = (segment: string) => {
    if (!beat) return;
    playing?.cancel();
    playing = play(beatHost, beat, segment, vars, playing?.elapsed ?? 0);
  };

  /** An answer to the menu: its echo for a question, then the route, Claude at work until a step says otherwise. */
  const route = (segment: string, echo: string | null) => {
    ask = null;
    answering = false;
    selected = 0;
    delete model.options;
    delete model.permission;
    delete model.command;
    if (echo !== null) model.transcript.push('', `${ESC}[35m>${RST} ${echo}`);
    beatHost.spinner('Thinking…');
    redraw();
    run(segment);
  };

  const choose = (i: number) => {
    if (!ask || i < 0 || i >= choicesOf(model)) return;
    if (ask.kind === 'question' && ask.typed === i) {
      // "Type something": the prompt takes the answer; Enter sends it, Esc goes back to the menu.
      answering = true;
      input = '';
      model.state = 'done';
      redraw();
      return;
    }
    route(ask.routes[i]!, ask.kind === 'question' ? ask.options[i]! : null);
  };

  const submit = () => {
    const shown = input;
    const text = [...pastes].reduce((s, [marker, full]) => s.split(marker).join(full), input).trim();
    input = '';
    pastes.clear();
    if (!text) { redraw(); return; }
    const [first, ...rest] = shown.split('\n');
    model.transcript.push('', `${ESC}[35m>${RST} ${first}`, ...rest.map((l) => `  ${l}`));
    if (text === '/clear') {
      model.transcript = [];
      // A new conversation in Claude Code: Ask has nothing from before it (its requests start over).
      ctx.state.prompts.delete(host.id);
      ctx.state.cleared.add(host.id);
      // Its context is empty again: the status line starts over (the Context sheet then says "compacted since").
      host.update((t) => (t.session ? { ...t, session: { ...t.session, contextPct: 0 } } : t));
      redraw();
      return;
    }
    // Claude Code's own commands (Context usage's Compact and Run /context among them) aren't played here: one honest
    // line, never a scripted turn. A path is a prompt.
    const command = /^\/[a-z][\w:-]*(?=\s|$)/i.exec(text)?.[0];
    if (command) {
      model.transcript.push(`  ${DIM}⎿  ${command} runs in Claude Code on your Mac${RST}`);
      notInDemo(command);
      redraw();
      return;
    }
    const prompt = autoTitleOf(text);
    vars = { prompt };
    // Ask counts the visitor's prompts among "your requests".
    ctx.state.prompts.set(host.id, [...(ctx.state.prompts.get(host.id) ?? []), { text: prompt, at: ctx.now() }]);
    turn = 'prompt';
    // A new session takes its first prompt as its title (atelierd's autoTitle), unless it has a name.
    host.update((t) => {
      if (!t.session || t.session.autoTitle) return t;
      const autoTitle = autoTitleOf(text);
      return { ...t, title: t.name ?? t.session.title ?? autoTitle, session: { ...t.session, autoTitle } };
    });
    const name = o.pick?.(text) ?? beatForPrompt(text, beats, 0);
    beat = beats.beats[name] ?? null;
    model.elapsed = 0;
    model.tokens = 0;
    stopSpinner();
    playing = null;
    beatHost.spinner('Thinking…');
    redraw();
    if (beat) playing = play(beatHost, beat, beat.start, vars, 0);
  };

  /** Esc while Claude works, as in Claude Code: the turn stops where it is, the prompt is free again, and the session
   *  takes the state the app shows after an interruption (compiled with the beat; a beat without one goes on). */
  const interrupt = (): boolean => {
    const patch = beat?.interrupt;
    if (!playing || ask || model.state !== 'working' || !patch) return false;
    playing.cancel();
    playing = null;
    stopSpinner();
    busy = false;
    model.state = 'done';
    turnEnded(true);
    model.transcript.push(`  ${DIM}⎿${RST}  ${RED}Interrupted by user${RST}`);
    host.update((t) => applyPatch(t, patch, ctx.now()));
    redraw();
    return true;
  };

  /** Keys while the prompt is in front (Claude idle or done, at work, or a typed answer). */
  const edit = (k: Key) => {
    switch (k.t) {
      case 'text': input += k.text.replace(/[\u0000-\u001f\u007f]/g, ''); break;
      case 'paste': {
        const text = k.text.replace(/\r\n?/g, '\n');
        if (text.includes('\n') || text.length > PASTE_INLINE) {
          const marker = `[Pasted text #${pastes.size + 1} +${text.split('\n').length} lines]`;
          pastes.set(marker, text);
          input += marker;
        } else input += text;
        break;
      }
      case 'newline': input += '\n'; break;
      case 'backspace': input = [...input].slice(0, -1).join(''); break;
      case 'ctrl': if (k.key === 'c' || k.key === 'u') input = ''; break;
      case 'esc':
        if (answering) { answering = false; input = ''; model.state = 'question'; } else if (interrupt()) return;
        break;
      case 'enter':
        if (answering) {
          const answer = input.trim().replace(/\s+/g, ' ').slice(0, 60);
          if (!answer || !ask || ask.kind !== 'question' || ask.typed === undefined) break;
          const seg = ask.routes[ask.typed]!;
          vars = { ...vars, answer };
          input = '';
          route(seg, answer);
          return;
        }
        if (!busy && !ask) { submit(); return; }
        break;
      default: return;
    }
    redraw();
  };

  const key = (k: Key) => {
    if (ask && !answering) {
      const n = choicesOf(model);
      switch (k.t) {
        case 'up': selected = Math.max(0, selected - 1); redraw(); return;
        case 'down': selected = Math.min(n - 1, selected + 1); redraw(); return;
        case 'enter': choose(selected); return;
        case 'esc': route(ask.cancel, null); return;
        case 'text': {
          const d = Number(k.text[0]);
          if (Number.isInteger(d) && d >= 1 && d <= n) choose(d - 1);
          return;
        }
        default: return;
      }
    }
    edit(k);
  };

  // Where the session is at the start: at work (its spinner runs from its turn's start), or on its beat's first step.
  if (model.state === 'working') {
    const s = host.info()?.session;
    const since = s?.lastMessageAt ?? s?.updatedAt ?? ctx.now();
    startSpinner(Math.max(1, Math.round((ctx.now() - since) / 1000)));
    // At work from the start (billing-tests, docs): Enter is no prompt until its turn ends, as for any working session.
    busy = true;
  }
  if (beat) run(beat.start);

  return {
    snapshot: () => PASTE_MODE + draw(),
    input(data) { for (const k of read(data)) key(k); },
    resize: redraw,
    dispose() { playing?.cancel(); playing = null; stopSpinner(); }
  };
}

/** A new session's screen: the welcome, then an empty prompt. */
export function welcomeScreen(transcript: readonly string[]): ClaudeScreen {
  return { transcript: [...transcript], state: 'done' };
}
