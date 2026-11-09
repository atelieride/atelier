// Hook and status-line payloads come from Claude Code with the OS's own paths: on Windows `C:\Users\…`.
// atelierd makes the fields Atelier reads canonical (`C:/Users/…`) before any reducer sees
// them, so the shared logic keeps one path form. POSIX payloads are passed through as they are.
import { isAbsPath, toCanonical } from './paths';
import { pathStyle, type PathStyle } from './platform';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const TOP = ['cwd', 'transcript_path', 'agent_transcript_path'] as const;
const NESTED = { tool_input: ['file_path', 'notebook_path', 'path'], workspace: ['current_dir', 'project_dir'] } as const;

function canonicalFields(o: Obj, keys: readonly string[]): Obj {
  let out: Obj | null = null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== 'string' || !isAbsPath(v, 'win32')) continue;
    out ??= { ...o };
    out[k] = toCanonical(v, 'win32');
  }
  return out ?? o;
}

/** The payload with its path fields canonical on Windows; the same value on POSIX. */
export function canonicalPayload(payload: unknown, style: PathStyle = pathStyle()): unknown {
  if (style !== 'win32' || !isObj(payload)) return payload;
  let out = canonicalFields(payload, TOP);
  for (const [field, keys] of Object.entries(NESTED)) {
    const inner = out[field];
    if (!isObj(inner)) continue;
    const next = canonicalFields(inner, keys);
    if (next !== inner) out = { ...out, [field]: next };
  }
  return out;
}
