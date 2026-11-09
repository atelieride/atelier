// background.* in the demo: the Background inspector follows billing-tests' agents
// and its vitest shell. Their feeds were compiled (compile/beats-feeds.ts) and move on the engine's clock from the
// demo's start, watched or not; a watcher gets the whole feed at once, then each new line or timeline step, as main's
// BackgroundHub sends them (a shell's lines as deltas with their sequence, an agent's timeline whole each time). A test
// watcher's feed (billing-tests' vitest --watch) also grows with the working tree: each change to a file its tests
// import, once it runs, appends the compiled rerun block, as vitest prints one.
import type { AtelierApi } from '@shared/api';
import { feedKey, type BackgroundFeed } from '@shared/background-feed';
import type { CompiledFeed } from '../engine/beats-types';
import { resolved, type DemoContext } from './context';

export function createBackground(ctx: DemoContext): AtelierApi['background'] {
  const feeds = ctx.world.beats.feeds;
  /** How far each feed has got: lines shown (a shell) or the frame shown (an agent). */
  const progress = new Map<string, number>();
  const watched = new Set<string>();
  /** Each output feed's lines: the compiled ones, then the reruns a watcher appended. */
  const lines = new Map(Object.entries(feeds).flatMap(([key, f]) => (f.kind === 'output' ? [[key, [...f.lines]]] : [])));

  const full = (key: string, f: CompiledFeed): BackgroundFeed => {
    const n = progress.get(key)!;
    if (f.kind === 'timeline') {
      const frame = f.frames[n]!;
      return { key, kind: 'timeline', entries: frame.entries, meta: frame.meta, at: ctx.now() };
    }
    const all = lines.get(key)!;
    return { key, kind: 'output', lines: all.slice(0, n), live: '', reset: true, seq: n, dropped: 0, exit: n >= all.length ? f.exit : null, at: ctx.now() };
  };

  for (const [key, f] of Object.entries(feeds)) {
    progress.set(key, f.kind === 'output' ? f.shown : 0);
    f.times.forEach((ms) => {
      ctx.clock.after(ms, () => {
        const n = progress.get(key)! + 1;
        progress.set(key, n);
        if (!watched.has(key)) return;
        if (f.kind === 'timeline') ctx.events.emit('backgroundFeed', full(key, f));
        else ctx.events.emit('backgroundFeed', { key, kind: 'output', lines: [f.lines[n - 1]!], live: '', reset: false, seq: n, dropped: 0, exit: n >= f.lines.length ? f.exit : null, at: ctx.now() });
      });
    });
    if (f.kind === 'output' && f.rerun) {
      const { match, lines: block } = f.rerun;
      const related = new RegExp(match);
      // Running once its first run is all out (`after` is when it starts): reruns follow the compiled lines.
      const running = () => progress.get(key)! >= f.lines.length;
      const root = `${ctx.world.project.root}/`;
      ctx.events.on.fsChanged((paths) => {
        const file = paths.map((p) => (p.startsWith(root) ? p.slice(root.length) : null)).find((rel) => rel !== null && related.test(rel));
        if (!running() || !file) return;
        const added = block.map((l) => l.replace('{file}', file));
        const all = lines.get(key)!;
        all.push(...added);
        const n = progress.get(key)! + added.length;
        progress.set(key, n);
        if (watched.has(key)) ctx.events.emit('backgroundFeed', { key, kind: 'output', lines: added, live: '', reset: false, seq: n, dropped: 0, exit: null, at: ctx.now() });
      });
    }
  }

  return {
    watch(terminalId, itemId) {
      const key = feedKey(terminalId, itemId);
      const f = feeds[key];
      if (!f) return resolved({ ok: false, reason: 'missing' });
      watched.add(key);
      // The whole feed first (main sends a snapshot on every watch), before the reply as main may.
      ctx.events.emit('backgroundFeed', full(key, f));
      return resolved({ ok: true });
    },
    unwatch(terminalId, itemId) { watched.delete(feedKey(terminalId, itemId)); },
    // The demo world has no self-paced loop: a loop's transcript details are never there.
    loop: () => resolved({ ok: false, reason: 'missing' })
  };
}
