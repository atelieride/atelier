#!/usr/bin/env node
// Fake GitHub CLI for e2e: never the real gh. It answers only `gh pr view <branch> --json <fields>`
// from the JSON file in ATELIER_FAKE_GH_DATA ({ "<branch>": <gh pr view JSON> | "none" | "auth" }), which the test
// rewrites between steps, and appends every call ({ argv, cwd, env flags }) as one JSON line to ATELIER_FAKE_GH_LOG.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const log = process.env.ATELIER_FAKE_GH_LOG;
if (log) {
  appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd(), prompt: process.env.GH_PROMPT_DISABLED ?? null, color: process.env.NO_COLOR ?? null }) + '\n');
}
if (argv.length !== 5 || argv[0] !== 'pr' || argv[1] !== 'view' || argv[3] !== '--json') {
  process.stderr.write(`fake gh: unexpected arguments: ${argv.join(' ')}\n`);
  process.exit(2);
}
let data = {};
try { data = JSON.parse(readFileSync(process.env.ATELIER_FAKE_GH_DATA ?? '', 'utf8')); } catch { /* no data: no PRs */ }
const answer = data[argv[2]];
if (answer === undefined || answer === 'none') {
  process.stderr.write(`no pull requests found for branch "${argv[2]}"\n`);
  process.exit(1);
}
if (answer === 'auth') {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\n');
  process.exit(4);
}
process.stdout.write(JSON.stringify(answer) + '\n');
