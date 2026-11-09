#!/usr/bin/env node
// Demo Claude in Node, for the Microsoft Store's screenshots taken on Windows (tests/e2e/store-shots-win.manual.ts):
// the twin of tests/e2e/fake-claude-demo.pl (same scenarios, hook events, files and drawing), which needs a POSIX
// Perl. Hooks go through Atelier's bridge: atelier-bridge.exe on Windows, the atelier-hook/statusline scripts elsewhere.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const home = process.env.ATELIER_HOME;
const win = process.platform === 'win32';
const [hookCmd, statusCmd] = win
  ? [[join(home, 'bin', 'atelier-bridge.exe'), 'hook'], [join(home, 'bin', 'atelier-bridge.exe'), 'status']]
  : [[join(home, 'bin', 'atelier-hook')], [join(home, 'bin', 'atelier-statusline')]];
const argv = process.argv.slice(2);
let name = '';
argv.forEach((a, i) => { if (a === '-n' && argv[i + 1] !== undefined) name = argv[i + 1]; const m = /^--name=(.*)$/s.exec(a); if (m) name = m[1]; });
const hex = (n) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
// A UUID, like Claude Code's: the Background inspector computes no path for any other session id.
const sid = `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const sc = JSON.parse(readFileSync(process.env.ATELIER_DEMO_SCENARIOS, 'utf8'))[name];
if (!sc) { process.stderr.write(`no demo scenario for '${name}'\n`); process.exit(1); }
// The bridges' replies are dropped: nothing but the drawing reaches the terminal.
const bridge = ([bin, ...a], data) => spawnSync(bin, a, { input: JSON.stringify(data), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
const hook = (ev) => bridge(hookCmd, { ...ev, session_id: sid });
const status = (data) => bridge(statusCmd, { session_id: sid, session_name: name, ...data });

const [DIM, RST, BOLD] = ['\x1b[2m', '\x1b[0m', '\x1b[1m'];
const state = sc.state;
// The bottom area, as Claude Code shows it for each state.
const bottom = state === 'permission' ? [` ${BOLD}Bash command${RST}`, `   ${sc.command}`, '', ' Do you want to proceed?', ` \x1b[36m❯ 1. Yes${RST}`, "   2. Yes, and don't ask again", '   3. No, tell Claude what to do']
  : state === 'question' ? sc.options.map((o, i) => (i === 0 ? ` \x1b[36m❯ 1. ${o}${RST}` : `   ${i + 1}. ${o}`))
  : state === 'working' ? [`\x1b[38;5;211m✻ ${sc.spinner}${RST} ${DIM}(esc to interrupt)${RST}`, '', '> ', '']
  : ['', '> ', ''];

function draw() {
  const [c, r] = process.stdout.getWindowSize?.() ?? [];
  const [cols, rows] = [c || 99, r || 36];
  let out = '\x1b[2J\x1b[H' + sc.transcript.map((l) => `${l}\r\n`).join('');
  const top = rows - bottom.length;
  out += `\x1b[${top};1H${DIM}${'─'.repeat(cols)}${RST}`;
  bottom.forEach((l, i) => { out += `\x1b[${top + 1 + i};1H${l}`; });
  // The cursor sits in the prompt; a permission request or a question hides it, as Claude Code does.
  const prompt = bottom.indexOf('> ');
  out += prompt >= 0 ? `\x1b[?25h\x1b[${top + 1 + prompt};3H` : '\x1b[?25l';
  process.stdout.write(out);
}

const cwd = process.cwd();
const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-');
// The transcript's path under the config dir Claude runs with, as Claude Code sends it (atelierd learns the session's
// account from it). Nothing is written there.
const cfg = process.env.CLAUDE_CONFIG_DIR || (process.env.ATELIER_TEST_CLAUDE_HOME ? join(process.env.ATELIER_TEST_CLAUDE_HOME, '.claude') : '');
const transcript = cfg ? { transcript_path: join(cfg, 'projects', encoded, `${sid}.jsonl`) } : {};
hook({ hook_event_name: 'SessionStart', source: 'startup', session_title: name, cwd, ...transcript });
hook({ hook_event_name: 'UserPromptSubmit', prompt: sc.prompt, session_title: name });
for (const e of sc.edits ?? []) {
  const path = join(cwd, e.file);
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path } });
  writeFileSync(path, e.content);
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path } });
}
const now = Math.floor(Date.now() / 1000);
const [l5, l7] = sc.limits ?? [34, 12];
status({ ...transcript, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  cost: { total_cost_usd: sc.cost, total_lines_added: sc.added, total_lines_removed: sc.removed },
  context_window: { used_percentage: sc.context },
  rate_limits: { five_hour: { used_percentage: l5, resets_at: now + 2 * 3600 }, seven_day: { used_percentage: l7, resets_at: now + 3 * 86400 } } });

// Background work, as the Perl twin plays it (see play_background there).
const started = new Set();
const bgDir = (variable, ...rest) => {
  const root = process.env[variable];
  if (!root) throw new Error(`${variable} is not set`);
  const d = join(root, encoded, sid, ...rest);
  mkdirSync(d, { recursive: true });
  return d;
};
const stamp = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const inProject = (input) => {
  const i = { ...input };
  for (const k of ['file_path', 'path']) if (i[k] !== undefined && !isAbsolute(i[k])) i[k] = join(cwd, i[k]);
  return i;
};
function playBackground(bg) {
  if (bg.crons?.length) {
    hook({ hook_event_name: 'Stop', session_crons: bg.crons });
    hook({ hook_event_name: 'UserPromptSubmit', prompt: sc.prompt, session_title: name });
  }
  for (const a of bg.agents ?? []) {
    const type = a.type || 'Explore';
    hook({ hook_event_name: 'SubagentStart', agent_id: a.id, agent_type: type });
    started.add(a.id);
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: a.description, prompt: a.task, subagent_type: type, run_in_background: true },
      tool_response: { status: 'async_launched', agentId: a.id } });
    const steps = a.steps ?? [];
    let t = now - 3 * steps.length - 2;
    const lines = [JSON.stringify({ type: 'user', timestamp: stamp(t), message: { role: 'user', content: a.task } })];
    steps.forEach((s, idx) => {
      const n = idx + 1;
      t += 3;
      const msg = { role: 'assistant', model: 'claude-haiku-5-5', id: `msg_${a.id}_${n}`, usage: { input_tokens: 1800 + 150 * n, output_tokens: 120, cache_creation_input_tokens: 0 } };
      if (s.text !== undefined) { lines.push(JSON.stringify({ type: 'assistant', timestamp: stamp(t), message: { ...msg, content: [{ type: 'text', text: s.text }] } })); return; }
      const use = `toolu_${a.id}_${n}`;
      lines.push(JSON.stringify({ type: 'assistant', timestamp: stamp(t), message: { ...msg, content: [{ type: 'tool_use', id: use, name: s.tool, input: inProject(s.input) }] } }));
      let result = s.result ?? '';
      if (/^\d+$/.test(String(result))) result = Array.from({ length: Number(result) }, (_, i) => `line ${i + 1}`).join('\n');
      lines.push(JSON.stringify({ type: 'user', timestamp: stamp(t + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use, content: result, ...(s.error ? { is_error: true } : {}) }] } }));
    });
    writeFileSync(join(bgDir('ATELIER_TEST_CLAUDE_PROJECTS', 'subagents'), `agent-${a.id}.jsonl`), lines.map((l) => `${l}\n`).join(''));
  }
  for (const b of bg.shells ?? []) {
    writeFileSync(join(bgDir('ATELIER_TEST_CLAUDE_TMP', 'tasks'), `${b.id}.output`), (b.output ?? []).map((l) => `${l}\n`).join('') + (b.exit !== undefined ? `\n[exited with code ${b.exit}]\n` : ''));
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: b.command, description: b.description, run_in_background: true },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: b.id } });
  }
}
if (sc.background) playBackground(sc.background);

if (state === 'permission') {
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: sc.command } });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: sc.command } });
} else if (state === 'question') {
  hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
} else if (state === 'working') {
  for (let i = 1; i <= (sc.agents ?? 0); i++) if (!started.has(`a${i}`)) hook({ hook_event_name: 'SubagentStart', agent_id: `a${i}`, agent_type: 'Explore' });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(cwd, 'README.md') } });
} else if (state === 'done') {
  hook({ hook_event_name: 'Stop' });
}
draw();
// Redrawn when the pane is resized. Windows reports a console's new size only to a reader in raw mode (Node's
// SIGWINCH): stdin is read, and dropped, as Claude Code's own prompt would read it.
if (win && process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', () => {}); }
let size = String(process.stdout.getWindowSize?.());
process.stdout.on('resize', draw);
setInterval(() => {
  const now = String(process.stdout.getWindowSize?.());
  if (now !== size) { size = now; draw(); }
}, 250);
for (const s of ['SIGHUP', 'SIGTERM']) process.on(s, () => process.exit(0));
