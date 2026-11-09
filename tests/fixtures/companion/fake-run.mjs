#!/usr/bin/env node
// A fake `claude -p` for the Ask runner tests. Behaviour comes from env: FAKE_RUN_FIXTURE (jsonl file to print, line by
// line), FAKE_RUN_DELAY_MS (between lines), FAKE_RUN_HANG (never exit), FAKE_RUN_FLOOD (print that many MiB in 64 KiB lines), FAKE_RUN_EXIT
// (exit code), FAKE_RUN_KID (spawn a grandchild, pid in the log), FAKE_RUN_BIGLINE (one line of that many bytes), FAKE_RUN_NO_FINAL_NL (last fixture line without \n), FAKE_RUN_STDERR (a stderr line), FAKE_RUN_LOG (JSON file: argv, env bits, pid, stdin).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const e = process.env;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const kid = e.FAKE_RUN_KID ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : null;
  if (e.FAKE_RUN_LOG) {
    writeFileSync(e.FAKE_RUN_LOG, JSON.stringify({
      argv: process.argv.slice(2), pid: process.pid, kid: kid ? kid.pid : null, input,
      entry: e.CLAUDE_CODE_ENTRYPOINT ?? null, configDir: e.CLAUDE_CONFIG_DIR ?? null
    }));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (e.FAKE_RUN_FIXTURE) {
    const lines = readFileSync(e.FAKE_RUN_FIXTURE, 'utf8').split('\n').filter(Boolean);
    for (const [i, line] of lines.entries()) {
      process.stdout.write(e.FAKE_RUN_NO_FINAL_NL && i === lines.length - 1 ? line : `${line}\n`);
      if (e.FAKE_RUN_DELAY_MS) await sleep(Number(e.FAKE_RUN_DELAY_MS));
    }
  }
  if (e.FAKE_RUN_FLOOD) {
    const chunk = `${'x'.repeat(65535)}\n`;
    for (let i = 0; i < Number(e.FAKE_RUN_FLOOD) * 16; i++) { process.stdout.write(chunk); await sleep(0); }
  }
  if (e.FAKE_RUN_BIGLINE) process.stdout.write('y'.repeat(Number(e.FAKE_RUN_BIGLINE)));
  if (e.FAKE_RUN_STDERR) process.stderr.write(`${e.FAKE_RUN_STDERR}\n`);
  if (e.FAKE_RUN_HANG) setInterval(() => {}, 1000);
  else process.exit(Number(e.FAKE_RUN_EXIT ?? 0));
});
