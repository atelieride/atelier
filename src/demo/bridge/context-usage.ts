// Context usage in the live demo: the sheet opens on fictional numbers
// (world/context.ts) after a short analysis that reports progress on the demo's clock, as main's private copy does
// (start, the MCP servers connecting, the count). A chunk of its own, loaded on the first call (bridge/inert.ts): the
// first paint carries none of it.
import type { ContextResult } from '@shared/context-usage';
import type { Cancel } from '../engine/clock';
import { DEMO_HOME } from '../world/accounts';
import { contextReport, contextTokens } from '../world/context';
import type { DemoContext } from './context';
import { notInDemo } from './not-in-demo';

/** The servers connecting (the one that failed never counts, as in main), then the count: about a second and a half. */
const STEPS: readonly { at: number; connected?: number }[] = [{ at: 350, connected: 1 }, { at: 650, connected: 3 }, { at: 900, connected: 4 }, { at: 1100 }];
const CONNECTING = 4;
const DONE_MS = 1600;

const sessionOf = (ctx: DemoContext, terminalId: string) => ctx.state.terminals.find((t) => t.id === terminalId && t.session) ?? null;

/** Each demo's analyses under way, by terminal: how to stop one (a new analysis of its terminal does, as in main). */
const running = new WeakMap<DemoContext, Map<string, () => void>>();

export function analyze(ctx: DemoContext, terminalId: string): Promise<ContextResult> {
  const mine = running.get(ctx) ?? new Map<string, () => void>();
  running.set(ctx, mine);
  mine.get(terminalId)?.();
  ctx.events.emit('contextProgress', { terminalId, phase: 'start' });
  const timers: Cancel[] = STEPS.map((s) => ctx.clock.after(s.at, () => ctx.events.emit('contextProgress', s.connected === undefined
    ? { terminalId, phase: 'count' }
    : { terminalId, phase: 'mcp', connected: s.connected, total: CONNECTING })));
  return new Promise((done) => {
    const finish = (r: ContextResult) => {
      for (const cancel of timers) cancel();
      if (mine.get(terminalId) === stop) mine.delete(terminalId);
      done(r);
    };
    const stop = () => finish({ ok: false, kind: 'exit', message: 'Stopped' });
    mine.set(terminalId, stop);
    timers.push(ctx.clock.after(DONE_MS, () => {
      // The session as it is when the count ends (a beat may have moved it on meanwhile).
      const t = sessionOf(ctx, terminalId);
      if (!t?.session) { finish({ ok: false, kind: 'no-session', message: 'No Claude session in this terminal' }); return; }
      const report = contextReport({ pct: t.session.contextPct ?? 0, configDir: t.configDir ?? `${DEMO_HOME}/.claude`, home: DEMO_HOME, root: ctx.world.project.root, at: ctx.now() });
      finish({ ok: true, report });
    }));
  });
}

/** The conversation now, as the transcript's last input would say: the status line's context %. */
export function live(ctx: DemoContext, terminalId: string): number | null {
  const t = sessionOf(ctx, terminalId);
  return t?.session ? contextTokens(t.session.contextPct ?? 0) : null;
}

/** The memory and settings files the report lists are the fictional user's, on their Mac. */
export function open(): Promise<never> {
  notInDemo('Files outside the project');
  return Promise.reject(new Error('not in the demo'));
}
