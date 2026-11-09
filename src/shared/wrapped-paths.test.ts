import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { foldersAbove, linksAt, rowFromCells, type Row, type WrappedLink } from './wrapped-paths';

const FIXTURES = join(__dirname, '../../tests/fixtures/claude-image');
const TMP = '/private/tmp/claude-501/-Users-mrossi-Developer-repos-atelier/193bc1c1-e2e9-4f29-9b4d-f247e3a0d2ee/scratchpad/shots/f24b-live-3.png';
const PROJ = '/Users/mrossi/Developer/repos/atelier/.experiments/worktrees/claude-image-links/tests/fixtures/claude-image/sample.png';

function rowsOf(text: string): Row[] {
  return text.replace(/\n$/, '').split('\n').map((t) => ({ text: t.trimEnd(), wrapped: false }));
}
const fixture = (name: string) => rowsOf(readFileSync(join(FIXTURES, name), 'utf8'));
const at = (rows: Row[]) => (y: number) => rows[y];

/** What the pieces cover, glued: must be the path itself. */
const covered = (rows: Row[], l: WrappedLink) => l.pieces.map((p) => rows[p.y]!.text.slice(p.start, p.end)).join('');

/** Every link to `path` seen from any row, checked piece by piece. */
function expectRebuilt(rows: Row[], cols: number, path: string, minPieces = 2): void {
  const seenFrom: number[] = [];
  for (let y = 0; y < rows.length; y++) {
    for (const l of linksAt(at(rows), y, cols)) {
      if (l.path !== path) continue;
      expect(covered(rows, l)).toBe(path);
      expect(l.pieces.some((p) => p.y === y)).toBe(true);
      expect(l.joined).toBe(l.pieces.length > 1);
      seenFrom.push(y);
    }
  }
  // Seen from each of its rows, at least one link with that many pieces.
  expect(seenFrom.length).toBeGreaterThanOrEqual(minPieces);
}

describe('rowFromCells', () => {
  const c = (chars: string, width: number) => ({ chars, width });
  test('text, cell width and where each code unit sits in cells', () => {
    // 日 (two cells, then its empty second half), a, 😀 (two code units, two cells), b, trailing blanks.
    const r = rowFromCells([c('日', 2), c('', 0), c('a', 1), c('😀', 2), c('', 0), c('b', 1), c('', 1), c(' ', 1)], true);
    expect(r.text).toBe('日a😀b');
    expect(r.wrapped).toBe(true);
    expect(r.width).toBe(6);
    expect(r.startCell).toEqual([0, 2, 3, 3, 5]);
    expect(r.endCell).toEqual([2, 3, 5, 5, 6]);
  });

  test('an empty row', () => {
    expect(rowFromCells([c('', 1), c('', 1)], false)).toEqual({ text: '', wrapped: false, width: 0, startCell: [], endCell: [] });
  });
});

describe('real Claude Code output', () => {
  for (const width of [90, 120, 160]) {
    for (const view of ['normal', 'transcript']) {
      test(`${view} view at ${width} columns: both absolute paths rebuilt from every row`, () => {
        const rows = fixture(`${view}-${width}.txt`);
        // At 160 columns every path fits on one row: one piece each.
        const min = width === 160 ? 1 : 2;
        expectRebuilt(rows, width, TMP, min);
        expectRebuilt(rows, width, PROJ, min);
      });
    }
  }

  test('a Read(…) header: the path without the parenthesis, the indent of the next row left out', () => {
    const rows = fixture('transcript-90.txt');
    const y = rows.findIndex((r) => r.text.startsWith('⏺ Read(/private'));
    const links = linksAt(at(rows), y + 1, 90);
    const l = links.find((x) => x.path === TMP)!;
    expect(l.pieces).toEqual([
      { y, start: 7, end: rows[y]!.text.length },
      { y: y + 1, start: 6, end: rows[y + 1]!.text.length - 1 }
    ]);
  });

  test('the prompt row (one column short of full) still continues', () => {
    const rows = fixture('normal-90.txt');
    const y = rows.findIndex((r) => r.text.startsWith('❯ Use the Read tool'));
    expect(rows[y]!.text.length).toBe(89);
    expect(linksAt(at(rows), y, 90).map((l) => l.path)).toContain(TMP);
  });
});

describe('a message with [image] attachments, as Claude Code draws it (120 columns)', () => {
  const rows = fixture('image-message.txt');
  const cols = 120;
  const dir = '/private/tmp/claude-501/-Users-mrossi-Developer-repos-store/00000000-1111-4222-8333-444444444444/scratchpad/shots/';
  const rowOf = (s: string) => rows.findIndex((r) => r.text.includes(s));

  test('each attachment rebuilt though its first row is not full (the size keeps the right)', () => {
    for (const name of ['settings-light.png', 'progress.png', 'error-dialog-2.png']) expectRebuilt(rows, cols, dir + name);
  });

  test('the piece on the [image] row starts right after the tag; the size stays out', () => {
    const y = rowOf('[image]');
    const l = linksAt(at(rows), y, cols).find((x) => x.kind === 'file')!;
    expect(l.pieces).toEqual([
      { y, start: rows[y]!.text.indexOf('/private'), end: rows[y]!.text.length },
      { y: y + 1, start: 11, end: 11 + 'ratchpad/shots/settings-light.png'.length }
    ]);
  });

  test('the folder on its own row is a folder link; the file:// URL wrapped over two rows names the same folder', () => {
    const y = rowOf(`  ${dir}`);
    expect(linksAt(at(rows), y, cols).map((l) => [l.kind, l.path])).toEqual([['folder', dir]]);
    const u = rowOf('(file://');
    for (const r of [u, u + 1]) {
      const links = linksAt(at(rows), r, cols);
      expect(links.map((l) => [l.kind, l.path, l.joined])).toEqual([['folder', dir, true]]);
    }
    // The URL's pieces: from "file://" to the last slash, without the parentheses.
    const [l] = linksAt(at(rows), u, cols);
    expect(covered(rows, l!)).toBe(`file://${dir}`);
  });

  test('a bare name in the list finds the folder written above it', () => {
    const y = rowOf('- progress.png');
    expect(linksAt(at(rows), y, cols).map((l) => l.path)).toEqual(['progress.png']);
    expect(foldersAbove(at(rows), y, cols)).toEqual([dir]);
  });

  test('no folder within reach: none', () => {
    expect(foldersAbove(at(rows), rowOf('[image]'), cols)).toEqual([]);
  });
});

describe('aligned [image] continuation', () => {
  test('only exactly under the path: one cell off is not a continuation', () => {
    const a = '  › [image]/private/tmp/claude-501/x/s';
    expect(linksAt(at(rowsOf(`${a}\n           hots/a.png      (2KB)`)), 0, 80)[0]).toMatchObject({ path: '/private/tmp/claude-501/x/shots/a.png', joined: true });
    expect(linksAt(at(rowsOf(`${a}\n            hots/a.png      (2KB)`)), 0, 80).some((l) => l.joined)).toBe(false);
    expect(linksAt(at(rowsOf(`${a}\n          hots/a.png      (2KB)`)), 0, 80).some((l) => l.joined)).toBe(false);
  });

  test('measured in cells: a wide character before [image] shifts where the path starts', () => {
    const c = (s: string, w = 1) => [...s].flatMap((ch) => (w === 2 ? [{ chars: ch, width: 2 }, { chars: '', width: 0 }] : [{ chars: ch, width: 1 }]));
    // 日 takes two cells: the path starts at cell 11 though its string index is 10.
    const a = rowFromCells([...c(' '), ...c('日', 2), ...c(' [image]/private/tmp/claude-501/x/s')], false);
    const under = (n: number) => rowFromCells(c(' '.repeat(n) + 'hots/a.png      (2KB)'), false);
    expect(linksAt(at([a, under(11)]), 0, 80).some((l) => l.joined)).toBe(true);
    expect(linksAt(at([a, under(10)]), 0, 80).some((l) => l.joined)).toBe(false);
  });

  test('a cut right after a slash: the first row alone never turns into a link to the parent folder', () => {
    const rows = rowsOf('  › [image]/private/tmp/claude-501/x/\n           a.png      (2KB)');
    const [l] = linksAt(at(rows), 0, 80);
    expect(l).toMatchObject({ kind: 'file', path: '/private/tmp/claude-501/x/a.png', joined: true });
    expect(l!.alone ?? []).toEqual([]);
  });

  test('a row without [image] still needs to be full', () => {
    const rows = rowsOf('  see /private/tmp/claude-501/x/s\n      hots/a.png');
    expect(linksAt(at(rows), 0, 80).some((l) => l.joined)).toBe(false);
  });
});

describe('file:// URLs and folders', () => {
  test('a file:// URL to an image is that path, percent-decoded', () => {
    const rows = rowsOf('open file:///tmp/claude-501/x/my%20shot.png now');
    expect(linksAt(at(rows), 0, 80)).toEqual([{ kind: 'file', path: '/tmp/claude-501/x/my shot.png', line: null, col: null, joined: false, pieces: [{ y: 0, start: 5, end: 43 }] }]);
  });

  test('only absolute folders are folder links; a relative one or a bare slash is not', () => {
    expect(linksAt(at(rowsOf('in /a/b/c/ and src/dir/ and / here')), 0, 80).map((l) => [l.kind, l.path])).toEqual([['folder', '/a/b/c/']]);
  });

  test('percent-decoding keeps .. as written: main gets the raw path and checks where it really leads', () => {
    const [l] = linksAt(at(rowsOf('file:///tmp/claude-501/%2e%2e/x.png')), 0, 80);
    expect(l!.path).toBe('/tmp/claude-501/../x.png');
  });

  test('a file:// URL at the end of a sentence leaves its punctuation out', () => {
    const [l] = linksAt(at(rowsOf('see file:///tmp/claude-501/x/c.png.')), 0, 80);
    expect(l).toMatchObject({ path: '/tmp/claude-501/x/c.png', pieces: [{ y: 0, start: 4, end: 4 + 'file:///tmp/claude-501/x/c.png'.length }] });
    expect(linksAt(at(rowsOf('file:///tmp/claude-501/x/c.png, then')), 0, 80)[0]!.path).toBe('/tmp/claude-501/x/c.png');
  });

  test('a folder is never cut out of a longer name, whatever character follows', () => {
    for (const s of ['/a/b/%20x', '/a/b/(c)', '/a/b/=x', "/a/b/'x"]) {
      expect(linksAt(at(rowsOf(`in ${s} here`)), 0, 80).filter((l) => l.kind === 'folder')).toEqual([]);
    }
    // At the end of a sentence or in parentheses it still is one.
    expect(linksAt(at(rowsOf('in /a/b/. Then')), 0, 80).map((l) => l.path)).toEqual(['/a/b/']);
    expect(linksAt(at(rowsOf('(in /a/b/)')), 0, 80).map((l) => l.path)).toEqual(['/a/b/']);
  });

  test('foldersAbove: nearest first, at most 3, within 30 rows, dedup', () => {
    const lines = ['/f1/', '/f2/', 'x', '/f3/', '/f3/', '/f4/', 'name.png'];
    const rows = rowsOf(lines.join('\n'));
    expect(foldersAbove(at(rows), 6, 80)).toEqual(['/f4/', '/f3/', '/f2/']);
    const far = rowsOf(['/far/', ...Array.from({ length: 30 }, () => 'x'), 'name.png'].join('\n'));
    expect(foldersAbove(at(far), 31, 80)).toEqual([]);
  });
});

describe('joining rules', () => {
  const cols = 40;
  const full = 'see /a/very/long/folder/name/that/goes/o';
  test('a full row and an indented next row are joined', () => {
    expect(full.length).toBe(cols);
    const rows = rowsOf(`${full}\n  n/shot.png and more`);
    const [l] = linksAt(at(rows), 1, cols);
    expect(l).toMatchObject({ path: '/a/very/long/folder/name/that/goes/on/shot.png', joined: true });
    expect(l!.pieces).toEqual([{ y: 0, start: 4, end: 40 }, { y: 1, start: 2, end: 12 }]);
  });

  test('a row two columns short of full is not joined', () => {
    const rows = rowsOf(`${full.slice(0, cols - 2)}\n  n/shot.png`);
    expect(linksAt(at(rows), 0, cols).every((l) => !l.joined)).toBe(true);
    expect(linksAt(at(rows), 1, cols).map((l) => l.path)).toEqual(['n/shot.png']);
  });

  test('a next row without indent is not joined', () => {
    const rows = rowsOf(`${full}\nn/shot.png`);
    expect(linksAt(at(rows), 1, cols).map((l) => l.path)).toEqual(['n/shot.png']);
  });

  test('an xterm soft wrap is joined as it is, spaces at the cut kept', () => {
    const rows: Row[] = [{ text: 'open /tmp/x/a b', wrapped: false }, { text: 'c/shot.png', wrapped: true }];
    // The first row is 15 wide in a 16-column terminal: the space at column 15 was trimmed by translateToString.
    const links = linksAt(at(rows), 1, 16);
    expect(links.map((l) => l.path)).toEqual(['c/shot.png']);
    const glued: Row[] = [{ text: 'open /tmp/x/abcd', wrapped: false }, { text: 'e/shot.png ok', wrapped: true }];
    const [l] = linksAt(at(glued), 0, 16);
    expect(l).toMatchObject({ path: '/tmp/x/abcde/shot.png', joined: true });
    expect(l!.pieces).toEqual([{ y: 0, start: 5, end: 16 }, { y: 1, start: 0, end: 10 }]);
  });

  test('a logical line stops after 8 rows', () => {
    const rows = rowsOf(['/' + 'a'.repeat(cols - 1), ...Array.from({ length: 9 }, () => '  ' + 'b'.repeat(cols - 2)), '  c.png'].join('\n'));
    // From the last row the chain can't reach the start: no absolute path ending in c.png.
    expect(linksAt(at(rows), rows.length - 1, cols).some((l) => l.path.startsWith('/'))).toBe(false);
  });

  test('a path on one row is reported as findFileLinks gives it', () => {
    const rows = rowsOf('edit src/a.ts:12 now');
    expect(linksAt(at(rows), 0, 80)).toEqual([{ kind: 'file', path: 'src/a.ts', line: 12, col: null, joined: false, pieces: [{ y: 0, start: 5, end: 16 }] }]);
  });

  test('a joined link carries the hovered row\'s own candidates as a fallback', () => {
    const rows = rowsOf(`${'x'.repeat(cols - 9)} notes.md\n  and/then.txt`);
    const [l] = linksAt(at(rows), 0, cols);
    expect(l).toMatchObject({ path: 'notes.mdand/then.txt', joined: true });
    expect(l!.alone?.map((a) => a.path)).toEqual(['notes.md']);
    const [m] = linksAt(at(rows), 1, cols);
    expect(m!.alone?.map((a) => a.path)).toEqual(['and/then.txt']);
  });

  test('fullness is measured in cells: wide characters before the cut count twice', () => {
    // 38 code units but 39 cells: 日 and 本 take two cells each.
    const text = '日本 /a/very/long/folder/name/that/goes/';
    const rows: Row[] = [{ text, wrapped: false, width: 39 }, { text: '  on/shot.png', wrapped: false }];
    const [l] = linksAt(at(rows), 1, cols);
    expect(l).toMatchObject({ path: '/a/very/long/folder/name/that/goes/on/shot.png', joined: true });
  });

  test('rows past the buffer and empty rows are fine', () => {
    expect(linksAt(() => undefined, 0, 80)).toEqual([]);
    expect(linksAt(at(rowsOf('')), 0, 80)).toEqual([]);
  });
});
