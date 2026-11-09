import { expect, test } from 'vitest';
import { gitSnapshotKey } from './snapshot-key';

const repo = (checkedAt: number, path = 'a.ts') => ({ root: '/r', branch: 'main', ahead: 0, behind: 0, changes: [{ path, status: 'M' }], oid: 'x', checkedAt, truncated: 0 });

test('a status read again with nothing new is the same snapshot (checkedAt left out)', () => {
  expect(gitSnapshotKey([repo(1)])).toBe(gitSnapshotKey([repo(2)]));
  expect(gitSnapshotKey([repo(1)])).not.toBe(gitSnapshotKey([repo(1, 'b.ts')]));
});
