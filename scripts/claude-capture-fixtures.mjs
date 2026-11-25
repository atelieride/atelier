// Turns a recording of a real Claude Code session (screens and a transcript) into committable fixtures: every path,
// home folder, account folder and e-mail address is rewritten at the same length, so each screen row keeps its width
// and a path Claude Code wrapped across two rows is still wrapped at the same column.
//
//   node scripts/claude-capture-fixtures.mjs <recording out dir> <fixture dir>
//
// The recording folder holds one folder per scenario (`02-bash/01-dialog.lines.txt`, `….snapshot.ans`) and
// `session/transcript.jsonl`. A scenario recorded in a folder of its own, where nothing was sent (so no transcript
// names it), names that folder in its `project.txt`. Nothing here names a person, account or folder of the machine
// that made the recording: the rewrites are generic patterns, and `check` refuses what is left.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWords } from './local-words.mjs';

/** Fixture name <- `<scenario>/<capture>` of the recording. */
export const SCREENS = {
  trust: '01-trust/01-dialog',
  bash: '02-bash/01-dialog',
  'bash-second': '02-bash/03-dialog-second',
  'bash-on-no': '02-bash/04-down-x3-on-no',
  'bash-amend': '02-bash/05-tab-on-no',
  'bash-amend-typed': '02-bash/06-feedback-typed',
  'bash-after': '02-bash/07-feedback-sent',
  edit: '03-edit/01-dialog',
  plan: '04-plan/02-approval-dialog',
  'plan-field': '04-plan/03-after-digit-3',
  'plan-field-typed': '04-plan/04-feedback-typed',
  'plan-after': '04-plan/07-edit-accepted',
  question: '05-question/01-dialog',
  'question-fruit': '05-question/03-dialog-free-text',
  'question-field': '05-question/04-after-digit-3-type-something',
  'question-field-typed': '05-question/05-free-text-typed',
  'questions-first': '06-two-questions/01-first-question',
  'questions-second': '06-two-questions/02-after-digit-2',
  'questions-review': '06-two-questions/03-after-digit-1-review',
  several: '07-multiselect/01-dialog',
  'several-submit': '07-multiselect/04-down-x4-on-submit',
  'several-review': '07-multiselect/05-after-enter-on-submit',
  'model-typed': '08-model/01-typed',
  model: '08-model/02-menu',
  'working-typed': '09-queued/02-typed-not-sent',
  queued: '09-queued/03-queued',
  idle: '09-queued/04-done',
  working: '10-interrupt/01-working',
  'paste-three-lines': '11-paste/01-three-lines',
  'paste-three-lines-typed': '11-paste/02-three-lines-typed',
  'paste-forty-lines': '11-paste/03-forty-lines',
  'paste-forty-lines-typed': '11-paste/04-forty-lines-typed',
  'paste-line-500': '11-paste/05-line-500',
  'paste-line-800': '11-paste/06-line-800',
  'paste-line-801': '11-paste/07-line-801',
  'paste-line-1000': '11-paste/08-line-1000',
  'paste-line-2000': '11-paste/09-line-2000',
  'paste-four-lines': '11-paste/10-four-lines',
  'paste-three-long-lines': '11-paste/11-three-long-lines',
  'paste-two-long-lines': '11-paste/12-two-long-lines',
};

const MIN_FRAGMENT = 12;

/**
 * A made-up path as long as `path`: `/work/hello`, then `/nested` folders, the rest padded with `-`, ending in
 * `/project`. A path too short for that keeps only the tail of the template.
 */
export function fictional(path) {
  const head = '/work/hello';
  const tail = '/project';
  const n = path.length;
  if (n < head.length + tail.length) return (head + tail).slice(-n);
  let middle = head;
  while (middle.length + 7 + tail.length <= n) middle += '/nested';
  return middle + '-'.repeat(n - middle.length - tail.length) + tail;
}

/** Every distinct fragment of `real` of MIN_FRAGMENT characters or more, with its stand-in at the same offsets. */
function fragmentsOf(real, fake) {
  const pairs = new Map();
  for (let i = 0; i + MIN_FRAGMENT <= real.length; i++) {
    for (let j = i + MIN_FRAGMENT; j <= real.length; j++) pairs.set(real.slice(i, j), fake.slice(i, j));
  }
  // Longest first, so a whole path goes before the pieces of it.
  return [...pairs].sort((a, b) => b[0].length - a[0].length);
}

/** The project folder as Claude Code names its per-folder directories: every `/` and `.` becomes `-`. */
const dashed = (p) => p.replace(/[/.]/g, '-');

/** Rewrites what identifies the recording machine, keeping every line's length. `project` is the session's folder. */
export function sanitize(text, { project }) {
  let out = text;
  if (project.length >= MIN_FRAGMENT) {
    const fake = fictional(project);
    // Both spellings of the folder: as a path, and dash-encoded as in `~/.claude/projects/<folder>`.
    const forms = [[project, fake], [dashed(project), dashed(fake)]];
    for (const [real, stand] of forms) {
      for (const [from, to] of fragmentsOf(real, stand)) out = out.split(from).join(to);
    }
  }
  return out
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, (m) => '/home/' + 'u'.repeat(m.length - '/Users/'.length + 1))
    .replace(/\.claude-([A-Za-z0-9_-]+)/g, (_, s) => '.claude-' + 'x'.repeat(s.length))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => 'x'.repeat(m.length))
    // Claude Code's own plan-mode instructions number their steps "Phase N", which the public-tree guard
    // reads as a reference to a project plan, so it becomes a word of the same length.
    .replace(/\b([Pp])hase(s?) (?=\d)/g, (_, p, s) => (p === 'P' ? 'Stage' : 'stage') + s + ' ');
}

const FORBIDDEN = [
  [/\/Users\//, 'a home folder'],
  [/-Users-/, 'a dash-encoded home folder'],
  [/\/private\/tmp\//, 'a temporary folder of the recording machine'],
  [/claude-\d+\//, 'a per-user Claude temporary folder'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, 'an e-mail address'],
];

/** Throws on anything that must not stay in a fixture. `root` is the repository, for the developer's own words. */
export function check(text, root) {
  for (const [re, what] of FORBIDDEN) {
    const m = re.exec(text);
    if (m) throw new Error(`fixture holds ${what}: ${JSON.stringify(m[0])}`);
  }
  for (const w of localWords(root)) {
    const m = new RegExp(w, 'i').exec(text);
    if (m) throw new Error('fixture holds a word only this developer knows (see info/public-tree-words)');
  }
}

/**
 * `rewind.jsonl`, from the sanitised transcript: the session up to its fourth prompt's interrupt (lines 0…22), then
 * what Claude Code writes when the person rewinds to the second prompt and types another one: a prompt whose parent is
 * the line the second prompt followed (line 8, the first turn's end), then Claude's reply to it. Both are shaped as
 * the recorded lines they stand for (line 9, the prompt they replace; line 7, a reply), with ids of their own.
 */
export function rewindOf(transcript) {
  const lines = transcript.split('\n').filter(Boolean);
  const kept = lines.slice(0, 23);
  const [back, replaced, answer, next] = [8, 9, 7, 23].map((i) => JSON.parse(lines[i]));
  const id = (n) => `5e7e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = Date.parse(next.timestamp);
  const prompt = {
    ...replaced, parentUuid: back.uuid, promptId: id(1), turnPromptId: id(1), uuid: id(2),
    message: { role: 'user', content: 'Only list the files.' }, timestamp: new Date(at).toISOString(),
  };
  const reply = {
    ...answer, parentUuid: prompt.uuid, requestId: 'req_rewind', requestRef: id(3), uuid: id(4),
    message: { ...answer.message, id: 'msg_rewind', content: [{ type: 'text', text: 'hello.txt' }] },
    timestamp: new Date(at + 2000).toISOString(),
  };
  return [...kept, JSON.stringify(prompt), JSON.stringify(reply)].map((l) => `${l}\n`).join('');
}

/** The folder the session ran in: the first `cwd` of the transcript. */
function projectOf(transcript) {
  for (const line of transcript.split('\n')) {
    if (!line) continue;
    const cwd = JSON.parse(line).cwd;
    if (typeof cwd === 'string') return cwd;
  }
  throw new Error('no cwd in the transcript');
}

function generate(recording, target, root) {
  const transcript = readFileSync(join(recording, 'session', 'transcript.jsonl'), 'utf8');
  const project = projectOf(transcript);
  const write = (name, text) => {
    check(text, root);
    const file = join(target, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const sanitised = sanitize(transcript, { project });
  write('transcript.jsonl', sanitised);
  write('rewind.jsonl', rewindOf(sanitised));
  /** The folder a scenario's captures were made in: its own when it names one, else the session's. */
  const projectFor = (source) => {
    const own = join(recording, source.split('/')[0], 'project.txt');
    return existsSync(own) ? readFileSync(own, 'utf8').trim() : project;
  };
  for (const [name, source] of Object.entries(SCREENS)) {
    const at = { project: projectFor(source) };
    write(`screens/${name}.txt`, sanitize(readFileSync(join(recording, `${source}.lines.txt`), 'utf8'), at));
    write(`screens/${name}.ans`, sanitize(readFileSync(join(recording, `${source}.snapshot.ans`), 'utf8'), at));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [recording, target] = process.argv.slice(2);
  if (!recording || !target) {
    console.error('usage: node scripts/claude-capture-fixtures.mjs <recording out dir> <fixture dir>');
    process.exit(2);
  }
  generate(resolve(recording), resolve(target), resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
