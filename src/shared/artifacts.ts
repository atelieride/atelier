/**
 * The Artifacts a Claude Code session published (claude.ai pages made with its `Artifact` tool), read from the
 * session's transcript JSONL. Only `assistant` lines (the tool call and its input) and `user` lines (the tool result
 * and Claude Code's structured `toolUseResult`) are read; Claude Code calls the line format internal, so anything
 * unexpected is skipped. Pure and incremental: main feeds it the transcript's text as it grows.
 */

export interface SessionArtifact {
  /** The artifact's page, `https://claude.ai/artifact/<id>` (or `/code/artifact/<uuid>`). */
  url: string;
  /** One line, at most TITLE_CHARS; the URL's id when Claude Code gave none. */
  title: string;
  /** ms of the last publish this session made to it (its result line's timestamp; 0 when unknown). */
  at: number;
}

export const MAX_ARTIFACTS = 50;
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{6,64}$/;
const TITLE_CHARS = 120;
/** Calls waiting for their result, and results already seen: bounded, the oldest dropped first. */
const MAX_TRACKED = 256;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** What a call asked for, kept until its result arrives. */
interface Pending { action: string | null; asset: boolean; title: string | null; url: string | null }

function cleanTitle(raw: string | null): string | null {
  if (!raw) return null;
  const one = raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  const points = Array.from(one);
  return points.length > TITLE_CHARS ? `${points.slice(0, TITLE_CHARS - 1).join('').trimEnd()}…` : one;
}

/** Bounded insertion-ordered set/map helper: drops the oldest key past MAX_TRACKED. */
function bound<K, V>(m: Map<K, V>): void {
  while (m.size > MAX_TRACKED) m.delete(m.keys().next().value as K);
}

export class ArtifactLog {
  private readonly byUrl = new Map<string, SessionArtifact>();
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<string, true>();
  /**
   * The text after the last newline: a line still being written. (A read that starts inside a line leaves a fragment
   * first: it never parses, so it is skipped like any malformed line.)
   */
  private carry: string[] = [];

  /** More of the transcript's text, in order. True when the list changed. */
  push(text: string): boolean {
    const nl = text.lastIndexOf('\n');
    // No line ends in it: kept whole (a long line arrives over many reads without being searched again).
    if (nl < 0) { if (text) this.carry.push(text); return false; }
    const lines = (this.carry.join('') + text.slice(0, nl)).split('\n');
    this.carry = nl + 1 < text.length ? [text.slice(nl + 1)] : [];
    let changed = false;
    for (const line of lines) if (this.relevant(line) && this.line(line)) changed = true;
    return changed;
  }

  /** Newest first; published in the same second (the transcript's times are often whole seconds), the later publish first. */
  list(): SessionArtifact[] {
    // byUrl holds them in publish order (each publish moves its page last); the sort is stable.
    return [...this.byUrl.values()].reverse().sort((a, b) => b.at - a.at);
  }

  /** Whether the result of that tool call has been read (main stops waiting for it). */
  resultSeen(toolUseId: string): boolean {
    return this.seen.has(toolUseId);
  }

  /** Cheap test before JSON.parse: an Artifact call, or the result of one still pending. */
  private relevant(line: string): boolean {
    if (line.includes('"Artifact"')) return true;
    if (this.pending.size === 0 || !line.includes('"tool_result"')) return false;
    for (const id of this.pending.keys()) if (line.includes(id)) return true;
    return false;
  }

  private line(line: string): boolean {
    let o: unknown;
    try { o = JSON.parse(line); } catch { return false; }
    if (!isObj(o) || !isObj(o.message) || !Array.isArray(o.message.content)) return false;
    if (o.type === 'assistant') {
      for (const b of o.message.content) {
        if (!isObj(b) || b.type !== 'tool_use' || b.name !== 'Artifact') continue;
        const id = str(b.id);
        if (!id) continue;
        const input = isObj(b.input) ? b.input : {};
        this.pending.set(id, { action: str(input.action), asset: input.asset === true, title: str(input.title), url: str(input.url) });
        bound(this.pending);
      }
      return false;
    }
    if (o.type !== 'user') return false;
    let changed = false;
    for (const b of o.message.content) {
      if (!isObj(b) || b.type !== 'tool_result') continue;
      const id = str(b.tool_use_id);
      const call = id ? this.pending.get(id) : undefined;
      if (!id || !call) continue;
      this.pending.delete(id);
      this.seen.set(id, true);
      bound(this.seen);
      if (b.is_error === true) continue;
      if (this.apply(call, isObj(o.toolUseResult) ? o.toolUseResult : {}, Date.parse(str(o.timestamp) ?? ''))) changed = true;
    }
    return changed;
  }

  /**
   * A publish (the default action) creates or updates the artifact its result names; an asset upload is not a publish
   * of the page. A delete removes it. Reads, comments, listings and the rest change nothing.
   */
  private apply(call: Pending, out: Obj, at: number): boolean {
    if (call.action === 'delete') return !!call.url && this.byUrl.delete(call.url);
    if ((call.action !== null && call.action !== 'publish') || call.asset) return false;
    const url = str(out.url);
    if (!url || !ARTIFACT_URL.test(url)) return false;
    const old = this.byUrl.get(url);
    const title = cleanTitle(str(out.title)) ?? cleanTitle(call.title) ?? old?.title ?? url.slice(url.lastIndexOf('/') + 1);
    this.byUrl.delete(url);
    this.byUrl.set(url, { url, title, at: Number.isFinite(at) ? at : old?.at ?? 0 });
    if (this.byUrl.size > MAX_ARTIFACTS) {
      const oldest = this.list().at(-1)!;
      this.byUrl.delete(oldest.url);
    }
    return true;
  }
}
