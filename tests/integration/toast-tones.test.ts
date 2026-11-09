import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

// Toasts read as errors (rose) unless they pass the `info` tone: notices, confirmations and hints must, so they never
// look like something went wrong. (A typed prompt's toast, tasks' and Docker's alike, passes through typeWhenReadyAs.)
const INFO = [
  't.tasks.typedInto(', 't.tasks.copied(', 't.tasks.copiedMarkdown(', 't.comments.sent(', 't.remotePressEnter', 't.shellEnvReloading', 't.shellEnvReloaded', 't.nothingNeedsYou',
  't.blocks.copied', 't.blocks.noOutput', 't.panel.copied', 'fetching', 't.split.max', 't.notInTree', 't.comments.selectLines',
  't.untitledMention', 't.dictationNotPolished', 'showToast(typed,', 't.docker.copied('
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

test('notice, confirmation and hint toasts use the info tone, never the error color', () => {
  const calls = files(resolve('src/renderer')).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('showToast(') && !l.includes('showToast(null)')).map((l) => ({ f, l }))
  );
  for (const key of INFO) {
    const sites = calls.filter(({ l }) => l.includes(key));
    expect(sites.length, key).toBeGreaterThan(0);
    for (const { f, l } of sites) expect(l, `${f}: ${key}`).toMatch(/'info'\)/);
  }
});
