import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { GrantStore } from './grants';

let out: string;
beforeEach(() => {
  out = realpathSync(mkdtempSync(join(tmpdir(), 'atl-grant-')));
  writeFileSync(join(out, 'a.txt'), 'a');
  writeFileSync(join(out, 'b.txt'), 'b');
  mkdirSync(join(out, 'dir'));
  symlinkSync(join(out, 'a.txt'), join(out, 'link.txt'));
});

describe('GrantStore', () => {
  test('a regular file is granted by its real path, for that project only', () => {
    const g = new GrantStore();
    expect(g.grant('/p', join(out, 'a.txt'))).toBe(join(out, 'a.txt'));
    expect(g.has('/p', join(out, 'a.txt'))).toBe(true);
    expect(g.has('/q', join(out, 'a.txt'))).toBe(false);
    expect(g.has('/p', join(out, 'b.txt'))).toBe(false);
  });

  test('a symlink grants its target, never the link itself', () => {
    const g = new GrantStore();
    expect(g.grant('/p', join(out, 'link.txt'))).toBe(join(out, 'a.txt'));
    expect(g.has('/p', join(out, 'a.txt'))).toBe(true);
    expect(g.has('/p', join(out, 'link.txt'))).toBe(false);
  });

  test('folders, missing paths, relative and over-long paths are refused', () => {
    const g = new GrantStore();
    expect(g.grant('/p', join(out, 'dir'))).toBeNull();
    expect(g.grant('/p', join(out, 'nope.txt'))).toBeNull();
    expect(g.grant('/p', 'a.txt')).toBeNull();
    expect(g.grant('/p', '/' + 'x'.repeat(5000))).toBeNull();
    expect(g.list('/p')).toEqual([]);
  });

  test('over the cap the oldest grant that is not open goes', () => {
    const files = Array.from({ length: 4 }, (_, i) => { const f = join(out, `f${i}.txt`); writeFileSync(f, ''); return f; });
    const open = new Set([files[0]!]);
    const g = new GrantStore(3, () => open);
    for (const f of files) g.grant('/p', f);
    expect(g.list('/p')).toEqual([files[0], files[2], files[3]]);
  });

  test('granting again refreshes the age', () => {
    const files = Array.from({ length: 3 }, (_, i) => { const f = join(out, `g${i}.txt`); writeFileSync(f, ''); return f; });
    const g = new GrantStore(2);
    g.grant('/p', files[0]!);
    g.grant('/p', files[1]!);
    g.grant('/p', files[0]!);
    g.grant('/p', files[2]!);
    expect(g.list('/p')).toEqual([files[0], files[2]]);
  });

  test('a granted path is checked again at use: swapped for a symlink elsewhere, it is no longer the grant', () => {
    const g = new GrantStore();
    const real = g.grant('/p', join(out, 'a.txt'))!;
    expect(g.check('/p', real)).toBe(real);
    expect(g.check('/p', join(out, 'link.txt'))).toBe(real);
    expect(g.check('/p', join(out, 'b.txt'))).toBeNull();
  });

  describe('modes', () => {
    test('a grant is for editing unless asked read-only', () => {
      const g = new GrantStore();
      const a = g.grant('/p', join(out, 'a.txt'))!;
      const b = g.grant('/p', join(out, 'b.txt'), 'read')!;
      expect(g.mode('/p', a)).toBe('edit');
      expect(g.mode('/p', b)).toBe('read');
      expect(g.mode('/p', join(out, 'link.txt'))).toBeNull();
      expect(g.mode('/q', b)).toBeNull();
    });

    test('a read grant takes only the real path asked: a link swapped in after the check grants nothing', () => {
      const g = new GrantStore();
      expect(g.grant('/p', join(out, 'link.txt'), 'read')).toBeNull();
      expect(g.list('/p')).toEqual([]);
      expect(g.grant('/p', join(out, 'a.txt'), 'read')).toBe(join(out, 'a.txt'));
      // A gesture's path may be a link (a Finder drop of an alias): it grants the target for editing, as before.
      expect(g.grant('/p', join(out, 'link.txt'))).toBe(join(out, 'a.txt'));
    });

    test('a user gesture upgrades a read grant; a read grant never downgrades an edit one', () => {
      const g = new GrantStore();
      const a = g.grant('/p', join(out, 'a.txt'), 'read')!;
      g.grant('/p', a);
      expect(g.mode('/p', a)).toBe('edit');
      g.grant('/p', a, 'read');
      expect(g.mode('/p', a)).toBe('edit');
    });

    test('both modes count toward the cap, and an evicted grant has no mode', () => {
      const files = Array.from({ length: 3 }, (_, i) => { const f = join(out, `m${i}.txt`); writeFileSync(f, ''); return f; });
      const g = new GrantStore(2);
      g.grant('/p', files[0]!, 'read');
      g.grant('/p', files[1]!);
      g.grant('/p', files[2]!, 'read');
      expect(g.list('/p')).toEqual([files[1], files[2]]);
      expect(g.mode('/p', files[0]!)).toBeNull();
    });

    test('over the cap read grants go first: links clicked at will never push out files the user chose', () => {
      const files = Array.from({ length: 4 }, (_, i) => { const f = join(out, `r${i}.txt`); writeFileSync(f, ''); return f; });
      const g = new GrantStore(2);
      g.grant('/p', files[0]!);
      g.grant('/p', files[1]!, 'read');
      g.grant('/p', files[2]!, 'read');
      g.grant('/p', files[3]!, 'read');
      expect(g.list('/p')).toEqual([files[0], files[3]]);
    });
  });
});

// A grant made for a move the target refused (or never answered) goes again.
test('a read grant made editable by a gesture is told; nothing else is', () => {
  const told: string[] = [];
  const g = new GrantStore(200, () => new Set(), (root, real) => { told.push(`${root} ${real}`); });
  const a = join(out, 'a.txt');
  g.grant('/p', a, 'read');
  g.grant('/p', a, 'read');
  expect(told).toEqual([]);
  g.grant('/p', a);
  expect(told).toEqual([`/p ${a}`]);
  // Already editable, or editable from the start: nothing to tell.
  g.grant('/p', a);
  g.grant('/p', join(out, 'b.txt'));
  g.grant('/q', a, 'read');
  expect(told).toEqual([`/p ${a}`]);
});

test('revoke: the file is no longer granted to that project (read or edit), the others keep theirs', () => {
  const g = new GrantStore();
  const a = join(out, 'a.txt');
  g.grant('/p', a, 'read');
  g.grant('/q', a);
  g.revoke('/p', a);
  expect(g.mode('/p', a)).toBeNull();
  expect(g.mode('/q', a)).toBe('edit');
  g.grant('/p', a);
  expect(g.mode('/p', a)).toBe('edit');
  g.revoke('/p', join(out, 'link.txt'));
  expect(g.has('/p', a)).toBe(false);
  g.revoke('/nope', a);
});
