// A connector's ToolSet: the read-only allowlist of one MCP server's tools, with a strict
// argument schema and a reply parser for each. Every connector defines its own in its tools.ts; the MCP client
// (client.ts) asks `isAllowed` before it reads a call's arguments or builds a request, so a name that is not in the set
// is never sent, whatever the caller (or the server's tools/list) says.
//
// READ-ONLY: `isAllowed` is an exact string match against a Set that is private to defineToolSet's closure; `names` is
// a frozen copy for display and tests, so nothing that touches it changes the check.
import type { z } from 'zod';
import { InvalidArguments, NotAllowed, SchemaChanged } from '../errors';

export interface ToolSet<N extends string, A extends Record<N, unknown>, R extends Record<N, unknown>> {
  /** The allowlisted names, for display and tests (a frozen copy). */
  readonly names: readonly N[];
  /** The names a server must list: every name but the optional ones (a frozen copy). */
  readonly required: readonly N[];
  /** Exact membership: no trimming, no case folding, no normalization; anything but a string is refused. */
  isAllowed(name: unknown): name is N;
  /** Validates the arguments of one tool (strict: only what Atelier sends). Throws InvalidArguments (NotAllowed for a foreign name). */
  parseArgs<K extends N>(name: K, args: unknown): A[K];
  /** Parses one tool's data. A reply of the wrong shape → SchemaChanged (NotAllowed for a foreign name). */
  parseReply<K extends N>(name: K, data: unknown): R[K];
}

/** Any ToolSet, for code that is generic over the connector. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolSet = ToolSet<string, any, any>;
export type ToolName<T extends AnyToolSet> = T['names'][number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolArgs<T extends AnyToolSet, K extends ToolName<T> = ToolName<T>> = T extends ToolSet<string, infer A, any> ? A[K & keyof A] : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolReply<T extends AnyToolSet, K extends ToolName<T> = ToolName<T>> = T extends ToolSet<string, any, infer R> ? R[K & keyof R] : never;

/** `optional`: a nice-to-have the server may lack without the connector being `unavailable` (its caller copes). */
export interface ToolSpec { args: z.ZodType; reply: z.ZodType; optional?: boolean }

/** A read-only Set: add/delete/clear throw, so even a stray reference cannot widen it. */
export function frozenSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const s = new Set(values);
  const refuse = () => { throw new TypeError('ALLOWED_TOOLS is read-only'); };
  Object.defineProperties(s, { add: { value: refuse }, delete: { value: refuse }, clear: { value: refuse } });
  return Object.freeze(s);
}

export function defineToolSet<S extends Record<string, ToolSpec>>(spec: S): ToolSet<
  Extract<keyof S, string>,
  { [K in Extract<keyof S, string>]: z.input<S[K]['args']> },
  { [K in Extract<keyof S, string>]: z.output<S[K]['reply']> }
> {
  type N = Extract<keyof S, string>;
  const specs = new Map<string, ToolSpec>(Object.entries(spec));
  /** The check's own Set: closure-private, so nothing outside this call can reach it. */
  const allowed: ReadonlySet<string> = new Set(specs.keys());
  const isAllowed = (name: unknown): name is N => typeof name === 'string' && allowed.has(name);
  return {
    names: Object.freeze([...specs.keys()] as N[]),
    required: Object.freeze([...specs].filter(([, x]) => !x.optional).map(([n]) => n) as N[]),
    isAllowed,
    parseArgs(name, args) {
      if (!isAllowed(name)) throw new NotAllowed();
      const r = specs.get(name)!.args.safeParse(args);
      if (!r.success) throw new InvalidArguments(name);
      return r.data as never;
    },
    parseReply(name, data) {
      if (!isAllowed(name)) throw new NotAllowed();
      const r = specs.get(name)!.reply.safeParse(data);
      if (!r.success) throw new SchemaChanged(`unexpected ${name} reply`);
      return r.data as never;
    }
  };
}

/** The ToolSet's required tools that a tools/list reply lacks (→ the connector is `unavailable`). */
export function missingTools(set: AnyToolSet, available: Iterable<string>): string[] {
  const have = new Set(available);
  return set.required.filter((n) => !have.has(n));
}
