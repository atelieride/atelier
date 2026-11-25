// Turns a recording of a real Claude Code session (screens and a transcript) into committable fixtures: every path,
// home folder, account folder and e-mail address is rewritten at the same length, so each screen row keeps its width
// and a path Claude Code wrapped across two rows is still wrapped at the same column.
//
//   node scripts/claude-capture-fixtures.mjs <recording out dir> <fixture dir>
//
// The recording folder holds one folder per scenario (`02-bash/01-dialog.lines.txt`, `….snapshot.ans`) and
// `session/transcript.jsonl`. Nothing here names a person, account or folder of the machine that made the recording:
// the rewrites are generic patterns, and `check` refuses what is left.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  write('transcript.jsonl', sanitize(transcript, { project }));
  for (const [name, source] of Object.entries(SCREENS)) {
    write(`screens/${name}.txt`, sanitize(readFileSync(join(recording, `${source}.lines.txt`), 'utf8'), { project }));
    write(`screens/${name}.ans`, sanitize(readFileSync(join(recording, `${source}.snapshot.ans`), 'utf8'), { project }));
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
