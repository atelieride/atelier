#!/usr/bin/env node
// Fake `claude -p` for Context usage (Tests), passed as ATELIER_TEST_CONTEXT_CLAUDE:
// never the real claude. It appends one JSON line { argv, cwd, entrypoint, configDir } to CTX_FAKE_LOG
// (when set), then answers Claude Code 2.1's control protocol on stdin/stdout as the real one does (shapes captured
// 2026-11-08): `initialize`; `mcp_status` (its first answer has a server still pending); `get_context_usage` with
// tests/fixtures/context/usage.json, its first memory file moved to the session folder's CLAUDE.md (so the sheet can
// open it). CTX_FAKE_MODE_FILE names a file read at each start: `unsupported` refuses get_context_usage as an
// older Claude Code would, `exit` ends at once with "No conversation found" on stderr; anything else answers.
// CTX_FAKE_DELAY: ms before each answer (default 60), so the sheet's steps show. Not ATELIER_* names: the copy runs with
// the user's shell environment, which drops Atelier's own variables.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const log = process.env.CTX_FAKE_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null })}\n`);
let mode = 'ok';
try { mode = readFileSync(process.env.CTX_FAKE_MODE_FILE ?? '', 'utf8').trim() || 'ok'; } catch { /* default */ }
if (mode === 'exit') {
  process.stderr.write('Warning: this sign-in ends soon.\nError: No conversation found with session ID: e2e\n');
  process.exit(1);
}
const delay = Number(process.env.CTX_FAKE_DELAY ?? 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (id, response) => process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })}\n`);
const refuse = (id, error) => process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error } })}\n`);

const SERVERS = [
  ['shop-docs', 'project'], ['claude.ai Tasks', 'claudeai'], ['workflows', 'user'], ['postgres-readonly', 'local'], ['analytics', 'user']
];
let polls = 0;
function status() {
  polls++;
  return {
    mcpServers: [
      // A config with a URL, as the real answer has: Atelier must never pass it on.
      ...SERVERS.map(([name, scope], i) => ({ name, status: polls === 1 && i === 0 ? 'pending' : 'connected', scope, config: { type: 'http', url: `https://e2e-secret-${i}.example/mcp` } })),
      { name: 'claude.ai Mail', status: 'needs-auth', scope: 'claudeai' }
    ]
  };
}
function usage() {
  const u = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'context', 'usage.json'), 'utf8'));
  u.memoryFiles[1].path = join(process.cwd(), 'CLAUDE.md');
  return u;
}

let buf = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'control_request') continue;
    const id = m.request_id;
    const subtype = m.request?.subtype;
    queue = queue.then(async () => {
      await sleep(delay);
      if (subtype === 'initialize') reply(id, { commands: [], models: [], claude_code_version: '2.1.319' });
      else if (subtype === 'mcp_status') reply(id, status());
      else if (subtype === 'get_context_usage') { if (mode === 'unsupported') refuse(id, `Unsupported control request subtype: ${subtype}`); else reply(id, usage()); }
      else refuse(id, `Unsupported control request subtype: ${subtype}`);
    });
  }
});
process.stdin.on('end', () => { void queue.then(() => process.exit(0)); });
