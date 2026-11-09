import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The Background inspector only reads Claude Code's files: no write API, no process.
const files = ['src/main/background-hub.ts', 'src/main/background-fs.ts'];
const WRITES = /\b(writeFile|appendFile|mkdir|rmdir|rm|unlink|rename|copyFile|truncate|symlink|chmod|chown|createWriteStream)(?:Sync)?\s*\(|\bwritev?\s*\(|child_process|['"](?:w|a|r\+|w\+|a\+)['"]/;

test.each(files)('%s never writes nor starts a process', (f) => {
  expect(readFileSync(join(__dirname, '../..', f), 'utf8')).not.toMatch(WRITES);
});
