// The Background inspector's feeds, compiled: billing-tests' agents and vitest shell
// as main's BackgroundHub would send them while they run. An agent's timeline comes from the transcript Claude Code
// writes (the same JSONL tests/e2e/fake-claude-demo.pl writes for the screenshots), read by the app's own
// TranscriptReader once per step, here at build time; the runtime reveals the frames on its clock. Node, build time
// only; relative imports.
import { TranscriptReader } from '../../shared/transcript';
import type { CompiledFeed } from '../engine/beats-types';
import type { AgentStep, BackgroundAgent } from '../world/scenarios';

/** The ISO time a transcript line carries. */
const stamp = (ms: number) => new Date(ms).toISOString();

/** Relative file paths in a tool's input made absolute in the project (the inspector shows them relative again). */
function inProject(input: Record<string, string>, root: string): Record<string, string> {
  const out = { ...input };
  for (const k of ['file_path', 'path']) if (out[k] && !out[k]!.startsWith('/')) out[k] = `${root}/${out[k]}`;
  return out;
}

/** The JSONL lines of an agent's transcript: the task, then each step (tool call and result, or text) at its time. */
export function transcriptLines(a: BackgroundAgent, root: string, times: number[], start: number): string[][] {
  const task = JSON.stringify({ type: 'user', timestamp: stamp(start), message: { role: 'user', content: a.task } });
  const perStep = a.steps.map((s: AgentStep, i) => {
    const n = i + 1;
    const t = times[i]!;
    const msg = { role: 'assistant', model: 'claude-haiku-5-5', id: `msg_${a.id}_${n}`, usage: { input_tokens: 1800 + 150 * n, output_tokens: 120, cache_creation_input_tokens: 0 } };
    if ('text' in s) return [JSON.stringify({ type: 'assistant', timestamp: stamp(t), message: { ...msg, content: [{ type: 'text', text: s.text }] } })];
    const use = `toolu_${a.id}_${n}`;
    const result = typeof s.result === 'number' ? Array.from({ length: s.result }, (_, k) => `line ${k + 1}`).join('\n') : s.result;
    return [
      JSON.stringify({ type: 'assistant', timestamp: stamp(t), message: { ...msg, content: [{ type: 'tool_use', id: use, name: s.tool, input: inProject(s.input, root) }] } }),
      JSON.stringify({ type: 'user', timestamp: stamp(t + 1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use, content: result, ...(s.error ? { is_error: true } : {}) }] } })
    ];
  });
  return [[task], ...perStep];
}

/**
 * An agent's feed: its timeline after each step (`shown` of them done before the demo starts, the others at `times`,
 * ms after it), each frame read from the transcript so far by TranscriptReader.
 */
export function agentFeed(a: BackgroundAgent, root: string, t0: number, o: { shown: number; times: readonly number[] }): CompiledFeed {
  if (o.shown + o.times.length !== a.steps.length) throw new Error(`feed ${a.id}: ${a.steps.length} steps, ${o.shown} shown + ${o.times.length} timed`);
  // Steps done before the demo: 4 s apart, ending 2 s before it starts.
  const at = a.steps.map((_, i) => (i < o.shown ? t0 - 2000 - (o.shown - 1 - i) * 4000 : t0 + o.times[i - o.shown]!));
  const lines = transcriptLines(a, root, at, (at[0] ?? t0) - 3000);
  const enc = new TextEncoder();
  const frames: Extract<CompiledFeed, { kind: 'timeline' }>['frames'] = [];
  for (let k = o.shown; k <= a.steps.length; k++) {
    const r = new TranscriptReader();
    r.push(enc.encode(`${lines.slice(0, k + 1).flat().join('\n')}\n`), root);
    frames.push({ entries: r.shown(), meta: { ...r.meta } });
  }
  return { kind: 'timeline', frames, shown: 0, times: [...o.times] };
}

/** A shell's feed: `shown` lines at the start, the rest evenly until `until` ms, then its exit code. */
export function shellFeed(lines: string[], o: { shown: number; until: number; exit: number | null }): CompiledFeed {
  const rest = lines.length - o.shown;
  const first = 2000;
  const times = Array.from({ length: rest }, (_, i) => (rest === 1 ? o.until : Math.round(first + (i * (o.until - first)) / (rest - 1))));
  return { kind: 'output', lines, shown: o.shown, times, exit: o.exit };
}

/** A test watcher's feed: its first run from `at` on (a line every 40 ms), then a rerun block per matching change. */
export function watchFeed(o: { at: number; firstRun: readonly string[]; match: string; rerun: readonly string[] }): CompiledFeed {
  return { kind: 'output', lines: [...o.firstRun], shown: 0, times: o.firstRun.map((_, i) => o.at + 300 + i * 40), exit: null, rerun: { after: o.at, match: o.match, lines: [...o.rerun] } };
}
