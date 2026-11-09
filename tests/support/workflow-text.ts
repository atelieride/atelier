// The shell scripts of a GitHub Actions workflow, read from its text: every `run:` step, as `run: x`, `- run: x` or a
// block scalar (`|`, `>`, with `-`/`+`). Used by the workflow guards to check that no GitHub expression is expanded
// inside a script (script injection): values reach scripts through `env:` only.

const RUN = /^(\s*)(-\s+)?run:\s*(.*)$/;
const BLOCK = /^[|>][-+]?\s*$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

export function runScripts(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RUN.exec(lines[i]!);
    if (!m) continue;
    const value = m[3]!.trim();
    if (!BLOCK.test(value)) {
      out.push(value);
      continue;
    }
    // A block scalar: the lines indented deeper than the `run` key (blank lines included) belong to it.
    const keyCol = m[1]!.length + (m[2]?.length ?? 0);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() !== '' && indentOf(l) <= keyCol) break;
      body.push(l);
    }
    while (body.length && body[body.length - 1]!.trim() === '') body.pop();
    const cut = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf));
    out.push(body.map((l) => l.slice(Number.isFinite(cut) ? cut : 0)).join('\n'));
    i = j - 1;
  }
  return out;
}
