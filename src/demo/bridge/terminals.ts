// terminals.* in the demo: the five scripted Claude sessions, new sessions and new terminals
// (the demo's shell), each run by a program (engine/claude.ts, engine/shell.ts) as atelierd runs a PTY. `attach` sends
// the screen as a snapshot event before it resolves, then the program's output arrives as data (terminal-hub.ts
// attachFor); every change to a terminal sends the whole list, as main does; a closed terminal sends its exit first.
import type { AtelierApi } from '@shared/api';
import { accountsFor, launchAccount } from '@shared/claude-accounts';
import type { TerminalInfo } from '@shared/protocol';
import { DEMO_HOME, accountDir } from '../world/accounts';
import { beatForPrompt } from '../engine/beats';
import { createClaude, welcomeScreen, type Program, type TermHost } from '../engine/claude';
import { createShell } from '../engine/shell';
import { notInDemo } from './not-in-demo';
import { noop, resolved, type DemoContext } from './context';

/** The Perl's size when `stty` says nothing; the renderer resizes before it shows anything. */
const DEFAULT_SIZE = { cols: 99, rows: 36 };
/** How long Claude takes to start in a new session (its SessionStart): the renderer shows it as starting meanwhile. */
export const CLAUDE_START_MS = 900;

/** A fresh id shaped like atelierd's (a v4 UUID); the page may not be a secure context, so not only randomUUID. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface DemoTerminals {
  api: AtelierApi['terminals'];
  /** A new Claude session, as ⌘N opens one (the shell's `claude` too): its terminal, shown as starting until Claude is. */
  createSession(o: { name?: string; account?: string }): TerminalInfo;
}

export function createDemoTerminals(ctx: DemoContext): DemoTerminals {
  const { state, events, world } = ctx;
  const root = world.project.root;
  const programs = new Map<string, Program>();
  /** Shells' default titles ("Terminal N"): a cleared name falls back to it. */
  const defaults = new Map<string, string>();
  /** The free-prompt beats go in turn across sessions, so two prompts in a row never play the same one. */
  let turn = 0;
  /** atelierd's colour counter: the next terminal takes the next colour. */
  let colorIndex = world.sessions.length;

  const publish = () => events.emit('terminals', state.terminals);
  const find = (id: string) => state.terminals.find((t) => t.id === id);
  const update = (id: string, f: (t: TerminalInfo) => TerminalInfo) => {
    const i = state.terminals.findIndex((t) => t.id === id);
    if (i < 0) return;
    const next = f(state.terminals[i]!);
    if (next === state.terminals[i]) return;
    state.terminals = state.terminals.map((t, k) => (k === i ? next : t));
    publish();
  };
  const hostFor = (id: string): TermHost => ({
    id,
    info: () => find(id),
    update: (f) => update(id, f),
    write(data) { if (data && state.attached.has(id)) events.emit('data', id, data); },
    size: () => state.sizes.get(id) ?? DEFAULT_SIZE
  });
  const pick = (text: string) => beatForPrompt(text, world.beats, turn++);
  const claude = (id: string, screen: Parameters<typeof createClaude>[2]['screen'], beat?: string) =>
    programs.set(id, createClaude(ctx, hostFor(id), { screen, pick, ...(beat ? { beat } : {}) }));

  for (const s of world.sessions) claude(s.terminal.id, s.screen, world.beats.sessions[s.terminal.id]?.beat);
  startCrons();

  const base = (o: { name?: string; foreground: string }): TerminalInfo => ({
    id: newId(), projectRoot: root, cwd: root, title: '', name: o.name?.trim() || null,
    color: world.beats.colors[colorIndex++ % world.beats.colors.length]!, foreground: o.foreground, createdAt: ctx.now(), session: null, profile: 'atelier'
  });

  /**
   * A Claude session: shown at once as starting (no session yet), its SessionStart a moment later. It runs as the
   * account asked for, else the one set for new sessions; an unknown id is refused, as main refuses it. Its config dir
   * is known from SessionStart on, as atelierd learns it from the transcript path.
   */
  function createSession(o: { name?: string; account?: string }): TerminalInfo {
    const defaultDir = accountDir(DEMO_HOME, 'default');
    const configDir = launchAccount(accountsFor(state.settings.claudeAccounts, defaultDir), o.account).dir ?? defaultDir;
    const t = base({ ...(o.name !== undefined && { name: o.name }), foreground: 'claude' });
    const info: TerminalInfo = { ...t, title: t.name ?? `Claude · ${world.project.name}` };
    state.terminals = [...state.terminals, info];
    claude(info.id, welcomeScreen(world.beats.fresh.transcript));
    publish();
    ctx.clock.after(CLAUDE_START_MS, () => update(info.id, (x) => {
      const now = ctx.now();
      const session = { ...world.beats.fresh.session, sessionId: newId(), cwd: root, updatedAt: now, lastMessageAt: null };
      return { ...x, title: x.name ?? x.title, session, configDir };
    }));
    return info;
  }

  /** A terminal: the demo's shell, "Terminal N" with the lowest number free (atelierd's numbering). */
  function createTerminal(): TerminalInfo {
    const taken = new Set(state.terminals.flatMap((x) => { const d = defaults.get(x.id); return d ? [Number(d.slice('Terminal '.length))] : []; }));
    let n = 1;
    while (taken.has(n)) n++;
    const t = base({ foreground: 'zsh' });
    defaults.set(t.id, `Terminal ${n}`);
    const info: TerminalInfo = { ...t, title: t.name ?? `Terminal ${n}` };
    state.terminals = [...state.terminals, info];
    programs.set(info.id, createShell(ctx, hostFor(info.id), {
      claude() {
        const s = createSession({});
        // As a notification click does: the new session is selected (the renderer opens its tab).
        events.emit('select', s.id);
      },
      exit: () => close(info.id)
    }));
    publish();
    return info;
  }

  function close(id: string): void {
    const p = programs.get(id);
    if (!p && !find(id)) return;
    p?.dispose();
    programs.delete(id);
    defaults.delete(id);
    state.attached.delete(id);
    state.sizes.delete(id);
    state.prompts.delete(id);
    state.scripted.delete(id);
    state.cleared.delete(id);
    // The PTY's exit first, then the list without it (atelierd's order).
    events.emit('exit', id);
    state.terminals = state.terminals.filter((t) => t.id !== id);
    publish();
  }

  /** Crons count down by themselves (the chip reads `next`); when one fires, its next time comes `period` later. */
  function startCrons(): void {
    for (const [id, periods] of Object.entries(world.beats.crons)) {
      for (const [cronId, period] of Object.entries(periods)) {
        const arm = () => {
          const next = find(id)?.work?.crons.find((c) => c.id === cronId)?.next;
          if (next == null) return;
          ctx.clock.after(Math.max(0, next - ctx.now()), () => {
            update(id, (t) => (t.work ? { ...t, work: { ...t.work, crons: t.work.crons.map((c) => (c.id === cronId && c.next !== null ? { ...c, next: c.next + period } : c)) } } : t));
            arm();
          });
        };
        arm();
      }
    }
  }

  const notYet = (what: string) => (): Promise<TerminalInfo> => { notInDemo(what); return Promise.reject(new Error(`${what} is not in the demo`)); };

  const api: AtelierApi['terminals'] = {
    list: () => resolved(state.terminals),
    create: async () => { await null; return createTerminal(); },
    shells: () => resolved([]),
    createSession: async (o) => { await null; return createSession({ ...(o.name ? { name: o.name } : {}), ...(o.account ? { account: o.account } : {}) }); },
    rename(id, name) {
      const given = name?.trim() || null;
      // atelierd's title: the given name, else the session's title or first prompt, else "Claude · folder" or "Terminal N".
      update(id, (t) => {
        const fallback = defaults.get(id) ?? t.session?.title ?? t.session?.autoTitle ?? `Claude · ${world.project.name}`;
        return { ...t, name: given, title: given ?? fallback };
      });
      return noop();
    },
    markSeen(id) {
      update(id, (t) => (t.session?.unread ? { ...t, session: { ...t.session, unread: false } } : t));
      return noop();
    },
    folder: (id) => resolved(find(id)?.session?.cwd ?? root),
    openFolder: () => { notInDemo('Show in Finder'); return noop(); },
    resume: notYet('Resume'),
    dismiss(id) { close(id); return noop(); },
    close(id) { close(id); return noop(); },
    async attach(id) {
      // After the caller's await, like an IPC round trip; the snapshot event comes before the reply.
      await null;
      const p = programs.get(id);
      if (!p || !find(id)) throw new Error('unknown terminal');
      events.emit('snapshot', id, p.snapshot());
      state.attached.add(id);
    },
    detach(id) { state.attached.delete(id); return noop(); },
    kill(id) { close(id); return noop(); },
    stop(ids) { for (const id of ids) close(id); return noop(); },
    input(id, data) { programs.get(id)?.input(data); },
    resize(id, cols, rows) {
      const prev = state.sizes.get(id);
      if (prev && prev.cols === cols && prev.rows === rows) return;
      state.sizes.set(id, { cols, rows });
      if (state.attached.has(id)) programs.get(id)?.resize();
    },
    triggerMatched: () => {}
  };
  return { api, createSession };
}

export function createTerminals(ctx: DemoContext): AtelierApi['terminals'] {
  return createDemoTerminals(ctx).api;
}
