#!/usr/bin/env node
// Fake `claude -p` for ✦ commit messages, passed as ATELIER_TEST_MESSAGE_CLAUDE: never the real
// claude. It reads the input main builds on stdin, then prints a short conventional message about the first staged
// file in three chunks ~100 ms apart (so the text streams). With ATELIER_TEST_MESSAGE_LOG set, it appends its stdin
// there first, followed by a separator line, so a test can read what ✦ was given.
// ATELIER_TEST_MESSAGE_DELAY: the pause between chunks in ms (a test that stops ✦ midway slows it down).
// ATELIER_TEST_MESSAGE_SLOW_TAKES: the takes (with ATELIER_TEST_MESSAGE_TAKES, "1,7") that pause that long; the others
// keep the default 100 ms. Unset: every take does.
// ATELIER_TEST_MESSAGE_TAKES=1: each run's subject ends with "(take N)", N counted in the log, so a rewrite differs.
// A <tweak kind="subject"> input prints the subject alone.
// ATELIER_TEST_MESSAGE_TEXT: prints exactly this message instead (the website's shots, tests/e2e/site-shots.manual.ts).
import { appendFileSync, readFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEPARATOR = '----- end of input -----';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  const log = process.env.ATELIER_TEST_MESSAGE_LOG;
  let take = 1;
  if (log) {
    try { take = readFileSync(log, 'utf8').split(SEPARATOR).length; } catch { /* first run */ }
    appendFileSync(log, `${input}\n${SEPARATOR}\n`);
  }
  const slowTakes = process.env.ATELIER_TEST_MESSAGE_SLOW_TAKES?.split(',').map(Number);
  const delay = (!slowTakes || slowTakes.includes(take)) && Number(process.env.ATELIER_TEST_MESSAGE_DELAY) || 100;
  // The <files> block lists "+1 -1 src/cart.ts" per staged file; one left out (a secret) is not what the message is about.
  const listed = /<files>\n([\s\S]*?)\n<\/files>/.exec(input)?.[1].split('\n').filter((l) => !l.includes('(left out')) ?? [];
  const file = /^(?:binary |\+\d+ -\d+ )?(\S+)/.exec(listed[0] ?? '')?.[1] ?? 'code';
  const scope = file.split('/').pop().replace(/\.[^.]*$/, '') || 'code';
  const subject = process.env.ATELIER_TEST_MESSAGE_TAKES === '1' ? `update ${scope} (take ${take})` : `update ${scope}`;
  const chunks = [`feat(${scope}): `, subject];
  if (!/<tweak kind="subject">/.test(input)) chunks.push(`\n\nKeep ${file} in step with the session's work.`);
  const fixed = process.env.ATELIER_TEST_MESSAGE_TEXT;
  if (fixed) chunks.splice(0, chunks.length, ...fixed.match(/[\s\S]{1,24}/g));
  for (const chunk of chunks) {
    process.stdout.write(chunk);
    await sleep(delay);
  }
});
