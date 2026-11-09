// JSON navigation: what Copy Value puts on the clipboard. Pure.
import { stringOf, type JsonNode } from './parse';

/** A string's content without quotes, other scalars as written, objects and arrays as JSON (2-space indent, the file's
 * number literals kept, comments dropped). */
export function copyValue(node: JsonNode): string {
  if (node.type === 'string') return stringOf(node);
  if (!node.children) return node.raw ?? String(node.value);
  return toJson(node, '');
}

function toJson(node: JsonNode, indent: string): string {
  if (!node.children) return node.raw ?? 'null';
  const [open, close] = node.type === 'object' ? ['{', '}'] : ['[', ']'];
  if (!node.children.length) return open + close;
  const inner = indent + '  ';
  const items = node.children.map((c) => inner + (node.type === 'object' ? `${JSON.stringify(c.key)}: ` : '') + toJson(c, inner));
  return `${open}\n${items.join(',\n')}\n${indent}${close}`;
}
