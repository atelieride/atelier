#!/usr/bin/env node
// Fake `claude -p` for Ask (Tests), passed as ATELIER_TEST_COMPANION_CLAUDE: never the real
// claude. It reads its argv and the question on stdin, appends one JSON line { argv, cwd, entrypoint, input } to
// ATELIER_TEST_COMPANION_LOG (when set), then answers in stream-json as Claude Code 2.1 does,
//scripted by what it was given:
// - `--json-schema`: a Catch me up for the fixture session; "the session has ended" in the
//   prompt (a final one) adds what it left open.
// - a question containing LIMIT: a refused run (rate limit status "rejected" on the 5-hour window, a result with
//   is_error and 429), resetting in 2 hours (LIMIT SOON: in 8 seconds) — only for the default account: run as another
//   one (CLAUDE_CONFIG_DIR set, Ask with <account>) it answers.
// - HANG: no output at all until it is killed (Stop, a timeout, quitting).
// - FAIL: Claude starts, then exits with an error on stderr (an `exit` error item with its first line).
// - anything else: an answer streamed in chunks after reading the chat (its cwd, by its real path as Claude Code reports
//   it), searching the code and reading src/app.ts: a Verdict line, a numbered list, a Detail block and `src/app.ts:2`.
//   SLOW in the question streams it slowly (a test stops it midway).
// ATELIER_TEST_COMPANION_DELAY: the pause between chunks in ms, and before the first one (default 40; SLOW: 700).
// ATELIER_TEST_COMPANION_CATCHUP_MS: a Catch me up's pause after reading the chat, before its result (default none).
// ATELIER_TEST_COMPANION_SCRIPT (the website's shots, tests/e2e/site-shots.manual.ts): a JSON file with the demo world's
// Catch me up for the shot's session (src/demo/world/ask.ts), { catchUp: { data, read } }, played instead of the
// fixture's: it reads the chat and `read`, then returns `data`. A question fails: a shot never shows a stray answer.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null; };
const sessionId = arg('--session-id') ?? arg('--resume') ?? '00000000-0000-4000-8000-000000000000';
const project = arg('--add-dir') ?? process.cwd();
const model = arg('--model') ?? 'sonnet';
const emit = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: sessionId })}\n`);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => void main());

async function main() {
  const log = process.env.ATELIER_TEST_COMPANION_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ argv, cwd: process.cwd(), entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, input })}\n`);
  if (/\bHANG\b/.test(input)) { setInterval(() => {}, 60_000); return; }
  const slow = /\bSLOW\b/.test(input);
  const delay = slow ? 700 : Number(process.env.ATELIER_TEST_COMPANION_DELAY) || 40;
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Glob', 'Grep', 'Read'], permissionMode: 'dontAsk', mcp_servers: [], model: `claude-${model}-5-5`, additional_directories: [project] });

  if (/\bLIMIT\b/.test(input) && !process.env.CLAUDE_CONFIG_DIR) {
    const soon = /\bLIMIT SOON\b/.test(input) ? Math.floor(Date.now() / 1000) + 8 : resetsAt;
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: soon, rateLimitType: 'five_hour' } });
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached', total_cost_usd: 0, api_error_status: 429, permission_denials: [] });
    return;
  }
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt, rateLimitType: 'five_hour' } });
  if (/\bFAIL\b/.test(input)) {
    // Ends on its own once the writes are out (process.exit could drop them on a pipe).
    process.stderr.write('Error: the fake broke on purpose\nat somewhere\n');
    process.exitCode = 1;
    return;
  }

  const scripted = process.env.ATELIER_TEST_COMPANION_SCRIPT;
  if (scripted) return play(JSON.parse(readFileSync(scripted, 'utf8')));

  if (argv.includes('--json-schema')) {
    await read('t-chat', join(process.cwd(), 'chat.md'));
    await sleep(Number(process.env.ATELIER_TEST_COMPANION_CATCHUP_MS) || 0);
    const catchUp = {
      points: [
        { n: 1, text: 'Refresh tokens in the token store', status: 'done', at: '12:22', note: null },
        { n: 2, text: 'Refresh on expiry, with clock skew', status: 'done', at: '12:33', note: null },
        { n: 3, text: 'Update the auth tests', status: 'in_progress', at: null, note: 'Re-running them · 1 of 3 failures left' },
        { n: 4, text: 'Remove the old cookie path', status: 'not_started', at: null, note: null },
        { n: 5, text: 'Log out every device on password change', status: 'not_started', at: '12:38', note: null }
      ],
      where: 'Refresh tokens now live in `TokenStore` and expiry allows 30 s of clock skew. One boundary test failed; it changed the check to `<=` and is re-running the suite.',
      choices: ['Skew window fixed at 30 s, not configurable', 'Plans to keep reading the old cookie for one release'],
      leftOpen: /the session has ended/.test(input) ? 'The old cookie path is still there and the boundary test is still red.' : null
    };
    emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: 't-so', name: 'StructuredOutput', input: catchUp }] } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-so', content: 'Structured output provided successfully' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(catchUp), structured_output: catchUp, total_cost_usd: 0.0031, api_error_status: null, permission_denials: [] });
    return;
  }

  await read('t-chat', join(process.cwd(), 'chat.md'));
  await tool('t-grep', 'Grep', { pattern: 'expired', path: project });
  await read('t-app', join(project, 'src', 'app.ts'));
  const answer = [
    'Verdict: in-progress — Not yet · 2/3 tests fixed\n\n',
    'Two of the three failing auth tests pass now; ',
    'the boundary one is still red.\n\n',
    '1. `TokenStore` keeps the refresh token.\n',
    '2. `refresh()` allows 30 s of clock skew.\n',
    '3. The boundary test compares expiry with `<=`.\n\n',
    ':::detail Why the boundary test failed\n',
    'The expiry check used `<` instead of `<=`, see `src/app.ts:2`.\n',
    ':::\n'
  ];
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null });
  for (const text of answer) {
    await sleep(delay);
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }, parent_tool_use_id: null });
  }
  const full = answer.join('');
  emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: full }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: full, total_cost_usd: 0.0021, api_error_status: null, permission_denials: [] });
}

/** The demo world's Catch me up (ATELIER_TEST_COMPANION_SCRIPT); a question fails. */
async function play(script) {
  if (!argv.includes('--json-schema')) {
    process.stderr.write('Error: this script has no answers, only a Catch me up\n');
    process.exitCode = 1;
    return;
  }
  const { data, read: files } = script.catchUp;
  await read('t-chat', join(process.cwd(), 'chat.md'));
  for (const [i, rel] of files.entries()) await read(`t-r${i}`, join(project, rel));
  emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: 't-so', name: 'StructuredOutput', input: data }] } });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-so', content: 'Structured output provided successfully' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(data), structured_output: data, total_cost_usd: 0.0031, api_error_status: null, permission_denials: [] });
}

/** One tool call, as the stream shows it: its block starts, the full input arrives, then its result. */
async function tool(id, name, input) {
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }, parent_tool_use_id: null });
  emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id, name, input }] } });
  await sleep(20);
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '1\t…', is_error: false }] } });
}

const read = (id, file) => tool(id, 'Read', { file_path: file });
