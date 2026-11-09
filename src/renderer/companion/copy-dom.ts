// A selection in Ask's thread as a formatted copy: the Range, cut at the thread's edges,
// turned into the plain nodes copy.ts writes from, with the formatting it sits in (a few words of a bold run, items of
// a list). Only the attributes the copy reads come along.
import { copyOf, POINT_GLYPH, type Copied, type CopyEl, type CopyNode } from './copy';

const READ = ['data-copy', 'data-copy-text', 'data-copy-wrap', 'data-copy-before', 'data-copy-pre', 'aria-hidden', 'start', 'value'];
const FORMAT = new Set(['strong', 'b', 'em', 'i', 'code']);

function shallow(el: Element): CopyEl {
  const attrs: Record<string, string> = {};
  for (const name of READ) {
    const v = el.getAttribute(name);
    if (v !== null) attrs[name] = v;
  }
  return { tag: el.localName, attrs, kids: [] };
}

function nodeOf(n: Node): CopyNode | null {
  if (n.nodeType === Node.TEXT_NODE) return n.nodeValue ?? '';
  if (n.nodeType !== Node.ELEMENT_NODE) return null;
  const el = shallow(n as Element);
  for (const k of n.childNodes) {
    const c = nodeOf(k);
    if (c !== null) el.kids.push(c);
  }
  return el;
}

const nodesOf = (r: Range): CopyNode[] => {
  const out: CopyNode[] = [];
  for (const k of r.cloneContents().childNodes) {
    const c = nodeOf(k);
    if (c !== null) out.push(c);
  }
  return out;
};

const GLYPHS = new Set<string>(Object.values(POINT_GLYPH));

/**
 * A selection running over several items that starts at its first item's first word starts at that item: what can't be
 * selected before the word (a point's glyph, a step's number) comes along, as it does for the items after it.
 */
function fromItemStart(r: Range, root: Element): void {
  const at = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
  const li = at?.closest('li');
  if (!li || !root.contains(li) || li.contains(r.endContainer)) return;
  const before = root.ownerDocument.createRange();
  before.setStart(li, 0);
  before.setEnd(r.startContainer, r.startOffset);
  const lead = copyOf(nodesOf(before)).text.trim();
  if (lead === '' || GLYPHS.has(lead)) r.setStart(li, 0);
}

/** The thread's part of the selection as a formatted copy; null when it holds nothing of the thread's to copy. */
export function selectionCopy(root: Element, sel: Selection | null): Copied | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0).cloneRange();
  const all = root.ownerDocument.createRange();
  all.selectNodeContents(root);
  if (r.compareBoundaryPoints(Range.START_TO_START, all) < 0) r.setStart(all.startContainer, all.startOffset);
  if (r.compareBoundaryPoints(Range.END_TO_END, all) > 0) r.setEnd(all.endContainer, all.endOffset);
  if (r.collapsed) return null;
  fromItemStart(r, root);
  const common = r.commonAncestorContainer;
  if (!root.contains(common)) return null;
  // What the picked nodes sit in, up to the thread: inline formatting, a file chip or a Detail's title (copied whole),
  // your question's line breaks, and the list whose items were picked.
  const wrap: CopyEl[] = [];
  for (let el = common instanceof Element ? common : common.parentElement; el && el !== root; el = el.parentElement) {
    if (el.getAttribute('data-copy') === 'skip' || el.getAttribute('aria-hidden') === 'true') return null;
    const tag = el.localName;
    const list = (tag === 'ol' || tag === 'ul') && el === common;
    if (FORMAT.has(tag) || list || el.hasAttribute('data-copy-wrap') || el.hasAttribute('data-copy-text') || el.hasAttribute('data-copy-pre')) wrap.unshift(shallow(el));
  }
  const out = copyOf(nodesOf(r), wrap);
  return out.html ? out : null;
}
