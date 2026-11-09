import type { AtelierApi } from '@shared/api';

// A thin observer around the demo's bridge ("the app is never instrumented"): the
// few calls the checklist reads are reported, then passed through unchanged. Copies, never mutates, the bridge.

export const OBSERVED = ['terminals.input', 'git.head', 'git.message', 'docker.logs', 'docker.inspect', 'docker.tail', 'docker.watchLogs', 'background.watch', 'companion.ask', 'companion.catchUp', 'companion.thread'] as const;

export type ObservedCall = (typeof OBSERVED)[number];

/**
 * Calls after which "Things to try" measures its place again at once (make-way.ts), not at the next look: an Ask
 * panel just opened (companion.thread, also with Catch me up on open turned off) or grew. Only Catch me up and a
 * question tick the Ask item (checklist.ts).
 */
export const MAKES_WAY: readonly ObservedCall[] = ['companion.thread', 'companion.catchUp', 'companion.ask'];

export function observeApi(api: AtelierApi, report: (name: ObservedCall, args: unknown[]) => void): AtelierApi {
  const out: Record<string, unknown> = { ...api };
  for (const name of OBSERVED) {
    const [ns, method] = name.split('.') as [string, string];
    const target = (out[ns] === (api as unknown as Record<string, unknown>)[ns] ? { ...(out[ns] as object) } : out[ns]) as Record<string, unknown>;
    const original = (api as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[ns]![method]!;
    const owner = (api as unknown as Record<string, object>)[ns];
    target[method] = (...args: unknown[]) => {
      try { report(name, args); } catch (e) { console.error(e); }
      return original.apply(owner, args);
    };
    out[ns] = target;
  }
  return out as unknown as AtelierApi;
}
