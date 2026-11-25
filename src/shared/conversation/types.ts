// The phones' conversation view: the entries a Claude Code transcript is read into (the protocol's `Entry`, see the
// iPhone protocol's conversation section) and the limits that keep each one small. Pure types and constants.

export type ToolStatus = 'running' | 'ok' | 'error';

/** One question of an AskUserQuestion call, as the phone shows it. */
export interface AskedQuestion {
  header?: string;
  question: string;
  several?: true;
  options: { label: string; description?: string }[];
}

/** `n` counts 1, 2, 3… in the order Claude Code wrote the entries; an entry sent again with its `n` replaces it. */
interface Base {
  n: number;
  at: number | null;
  /** Esc stopped Claude here. */
  interrupted?: true;
}

export type Entry =
  | (Base & { k: 'prompt'; text: string })
  | (Base & { k: 'reply'; text: string })
  | (Base & { k: 'tool'; tool: string; target?: string; status: ToolStatus; summary?: string; detail?: string; feedback?: string })
  | (Base & { k: 'agent'; description: string; status: ToolStatus; report?: string })
  | (Base & { k: 'question'; questions: AskedQuestion[]; status: ToolStatus })
  | (Base & { k: 'answer'; text: string })
  | (Base & { k: 'todos'; items: { text: string; status: string }[] })
  | (Base & { k: 'compact' });

/** The size limits of the protocol, in characters (lines where it says so). */
export const CAPS = {
  prompt: 16384, reply: 32768, plan: 16384,
  detail: 4096, detailLines: 80, outputLines: 20, output: 2048,
  report: 8192, answer: 2048, feedback: 2048,
  target: 160, summary: 80, question: 1024, label: 120, description: 300, header: 40,
  questions: 4, options: 8, todos: 100, todo: 200
} as const;
