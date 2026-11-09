// The public tree (tests/integration/public-tree.test.ts): finds what the repository should not say once its code is
// published — references to the private working notes, notes about who decided what, personal data, comparisons with
// other products — and holds every file to a baseline that can only shrink.
//
//   node scripts/public-tree.mjs            what is left, per rule and per area
//   node scripts/public-tree.mjs --files    … and every file with its counts
//   node scripts/public-tree.mjs --lines    … and every line that holds a reference
//   node scripts/public-tree.mjs --tighten  lower the baseline to what is left (never raises it, never adds a file)
//   node scripts/public-tree.mjs --seed     write the first baseline (refused once one exists)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWords } from './local-words.mjs';

export const BASELINE_FILE = 'tests/integration/public-tree-baseline.json';

/** A developer's own working notes (agent instructions, a handoff, specs and plans): never tracked here. */
const PRIVATE = [/^CLAUDE\.local\.md$/, /^HANDOFF\.md$/, /^docs\/superpowers\//];
/** The guard itself (its rules and samples name what they look for) and lockfiles (package names only). */
const SKIPPED = [/^scripts\/public-tree\.mjs$/, /^tests\/integration\/public-tree\.test\.ts$/, /^tests\/integration\/public-tree-baseline\.json$/,
  /(?:^|\/)package-lock\.json$/];

export function isScanned(path) {
  return !SKIPPED.some((r) => r.test(path));
}

export function isPrivate(path) {
  return PRIVATE.some((r) => r.test(path));
}

/** Products' functional names (environment variables, shims on PATH) are facts the code acts on, and so are the facts
 * that name an editor without comparing (where the file icons come from, what Claude Code's setup configures). */
const FACTS = /CMUX_\w*|cmux-cli-shims|\/cmux\.app\/Contents\/Resources\/bin|VSCode's default|(?:for|in) VS Code and Zed/g;
/** A comment line, or a test's name: where prose lives in code. */
const PROSE = String.raw`^\s*(?:\/\/|\*|\/\*|\{\/\*|#|<!--|(?:test|it|describe)(?:\.\w+)*\(\s*['"\x60])`;

export const RULES = [
  { id: 'spec', re: /\b[Ss]pecs? (?:docs\/|20\d\d-\d\d-\d\d|[a-z0-9][\w.]*(?:-[\w.]+)+|v\d[\w.]*|(?:[A-Za-z0-9.'"-]+ ){0,3}§)|\([Ss]pecs? [a-z][\w.-]*[),;]|\([Ss]pecs?$|\bthe spec's\b|\bsee the spec\b|[(;,]\s?[Ss]pecs?\s*$|\bbefore spec\s*$/g },
  // The experiments before a feature ("the spike's request", "(spike)"), in prose only: `spike` is a fine sample name.
  { id: 'spike', re: new RegExp(PROSE + String.raw`.*?\bspike(?:'s)?\b`, 'g') },
  { id: 'section', re: /§/g },
  { id: 'doc-slug', re: /\b20\d\d-\d\d-\d\d-[a-z][a-z0-9-]*/g },
  { id: 'plan', re: /\b[Pp]lans? (?:phase|20\d\d-|[A-Z]\d+\b|[a-z0-9-]+ (?:§|task|phase))|\([Pp]lan [a-z0-9]|\bamendment T\d+|\(amendment\)/g },
  // A ruling's number where prose cites it — "(R2)", "rulings R33, R38", "// R6: …", ": R106", "R48's", "R8/R7" — not
  // git's rename scores (R100).
  { id: 'ruling', re: /\b[Rr]ulings?\b|(?:[([]|\b(?:and|see|spec|launch-flags|Changes)\s|^\s*(?:\/\/|\/\*\*?|\*|#)\s*|[,;:]\s?)R\d{1,3}\b|\bR\d{1,3}(?:'s|\/R?\d{1,3})\b/g },
  // A plan's phases: "(Windows port Phase 5)", "phase 9 review", "(Phase 2)".
  { id: 'phase', re: /\b[Pp]hases? \d+\b/g },
  { id: 'ledger', re: /\b[Ll]edger [A-Z]\d+|\b[Ll]edgered\b/g },
  // Review findings and rounds: "review M9", "(review 2 I1)", "(M4)", "final review", "round 2", "(minors)", "Minor 3".
  { id: 'review', re: /\b(?:[Rr]e-)?[Rr]eview [A-Z]\d+\b|\b[Rr]eview \d+ [A-Z]\d+|\bround \d+(?:,? items? \d+)?(?=[),.:;\s]|$)|\b(?:[Ff]inal|[Ss]econd) [Rr]eview\b|\b[Rr]eview (?:round|minors)\b|\b[Rr]eview 20\d\d-\d\d-\d\d|\(Important\)|\([MI]\d{1,2}(?=[,)]| and)|\(minors(?: round)?\)|\bminors round\b|\bMinor \d+\b|\bround (?:one|two|three|four)\b/g, strip: /round \d+(?: \d+)* \d+px|inset\([^)]*\)/g },
  { id: 'notes', re: /docs\/superpowers|superpowers|\bHANDOFF\b/g },
  // The mockups and their variants: "board 3", "(variant A)", "the mockup's", "the canvas", "the brief's".
  { id: 'mockup', re: /\bboards? \d+(?:(?:,| and) \d+)*|\bvariant [A-Z]\b|\b(?:the|its) mockups?\b|\bmockups?'s?(?=\s|$|[),.:;])|\bthe canvas(?:'s)?\b|\bthe brief(?:'s)?\b/g },
  // The plans' task codes ("(T20)", "T31's e2e", "carry T19", "task 21 round 1"), in prose only: T0 is code.
  { id: 'task', re: new RegExp(PROSE + String.raw`.*?(?:[(,:;]\s?|\b(?:plan|ledger|task|carry)\s)[TD]\d{1,2}\b(?!:\d)|\btask \d+ round \d+|\((?:review round \d+, )?items? \d+(?:(?:,| and) \d+)*\)`, 'g') },
  // Notes on who decided or checked what, and when: "(Mario, 2026-01-02)", "his call", "he asked", "joint check".
  { id: 'author-notes', re: /\b[A-Z][a-z]+, 20\d\d-\d\d-\d\d\b|\b(?:his|her) (?:call|go|ok|ask|pick|choice|decision|ruling|check|app|Mac|machine)\b|\bhe (?:asked|wants|said|chose|decided|picked)\b|\bjoint check\b/g },
  // Who the work was for: colleagues, beta testers (the site's "Tell a colleague" share link is copy, not a note).
  { id: 'people', re: /\bcolleagues?\b|\bbeta testers?\b/g, strip: /Tell a colleague/g },
  // The user is "the user" or "they" in prose, never "he".
  { id: 'pronoun', re: new RegExp(PROSE + String.raw`.*?\b(?:[Hh]e|[Hh]im|[Hh]is|[Hh]imself)\b`, 'g') },
  { id: 'personal', re: /[\w.+-]+@gmail\.com/g },
  { id: 'other-products', re: /\b(?:[Cc]mux|VS ?Code|IntelliJ|Ghostty|iTerm2?|WezTerm|Warp|Zed|DBeaver|DataGrip|TablePlus|Postico|pgAdmin|Navicat)\b/g, strip: FACTS }
];

/** RULES plus the words of a developer's own copy (scripts/local-words.mjs) as the `local` rule. */
export function rulesWith(words) {
  return words.length ? [...RULES, { id: 'local', re: new RegExp(words.join('|'), 'gi') }] : RULES;
}

function lineCounts(line, rules = RULES) {
  const out = {};
  for (const r of rules) {
    const text = r.strip ? line.replace(r.strip, '') : line;
    const n = (text.match(r.re) ?? []).length;
    if (n) out[r.id] = n;
  }
  return out;
}

/** References per rule in `text` (only the rules that found one, in RULES order). */
export function scanText(text, rules = RULES) {
  const total = {};
  for (const line of text.split('\n')) for (const [id, n] of Object.entries(lineCounts(line, rules))) total[id] = (total[id] ?? 0) + n;
  return Object.fromEntries(rules.filter((r) => total[r.id]).map((r) => [r.id, total[r.id]]));
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
}

function readText(root, path) {
  let buf;
  try { buf = readFileSync(join(root, path)); } catch { return null; } // deleted in the working tree, or a nested worktree
  return buf.includes(0) ? null : buf.toString('utf8');
}

/** Every scanned file with references: its counts, and the lines that hold them (`<line>: <text>`). */
export function scanTree(root, rules = rulesWith(localWords(root))) {
  const files = {};
  const lines = {};
  for (const path of trackedFiles(root).filter(isScanned).sort()) {
    const text = readText(root, path);
    if (text === null) continue;
    const counts = scanText(text, rules);
    if (!Object.keys(counts).length) continue;
    files[path] = counts;
    lines[path] = text.split('\n').flatMap((l, i) => (Object.keys(lineCounts(l, rules)).length ? [`${i + 1}: ${l.trim().slice(0, 160)}`] : []));
  }
  return { files, lines };
}

const order = (rule) => { const i = RULES.findIndex((r) => r.id === rule); return i < 0 ? RULES.length : i; };

/** Where `current` holds more than `baseline` allows (a file the baseline doesn't name allows nothing). */
export function compare(current, baseline) {
  const out = [];
  for (const file of Object.keys(current).sort()) {
    for (const rule of Object.keys(current[file]).sort((a, b) => order(a) - order(b))) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (current[file][rule] > allowed) out.push({ file, rule, count: current[file][rule], allowed });
    }
  }
  return out;
}

/** The baseline lowered to what is left: never raised, never a file added; clean files and rules drop out. */
export function tighten(current, baseline) {
  const out = {};
  for (const [file, counts] of Object.entries(baseline)) {
    const kept = {};
    for (const [rule, n] of Object.entries(counts)) {
      const left = Math.min(n, current[file]?.[rule] ?? 0);
      if (left > 0) kept[rule] = left;
    }
    if (Object.keys(kept).length) out[file] = kept;
  }
  return out;
}

/** One file per line, files and rules sorted: cleanups in parallel branches touch different lines. */
export function serializeBaseline(files) {
  const rows = Object.keys(files).sort().map((file) => {
    const counts = Object.fromEntries(Object.keys(files[file]).sort().map((rule) => [rule, files[file][rule]]));
    return `    ${JSON.stringify(file)}: ${JSON.stringify(counts)}`;
  });
  const about = 'References each file may still hold, per rule (scripts/public-tree.mjs). Only ever lowered, with --tighten.';
  const body = rows.length ? `{\n${rows.join(',\n')}\n  }` : '{}';
  return `{\n  "about": ${JSON.stringify(about)},\n  "files": ${body}\n}\n`;
}

function areaOf(path) {
  const parts = path.split('/');
  return ['src', 'tests', 'site'].includes(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : '(root)';
}

function report(root, args) {
  const { files } = scanTree(root);
  const scanned = trackedFiles(root).filter(isScanned).length;
  const perRule = Object.fromEntries(RULES.map((r) => [r.id, { files: 0, hits: 0 }]));
  const perArea = {};
  for (const [file, counts] of Object.entries(files)) {
    const area = (perArea[areaOf(file)] ??= { files: 0, hits: 0 });
    area.files++;
    for (const [rule, n] of Object.entries(counts)) { perRule[rule].files++; perRule[rule].hits += n; area.hits += n; }
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${Object.keys(files).length} of ${scanned} scanned files still hold references.\n\nPer rule:`);
  for (const r of RULES) console.log(`  ${pad(r.id, 14)} ${pad(perRule[r.id].hits, 6)} in ${perRule[r.id].files} files`);
  console.log('\nPer area:');
  for (const [area, v] of Object.entries(perArea).sort((a, b) => b[1].files - a[1].files)) console.log(`  ${pad(area, 22)} ${pad(v.files, 5)} files, ${v.hits} references`);
  if (args.includes('--files')) {
    console.log('\nFiles:');
    const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
    for (const [file, c] of Object.entries(files).sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))) {
      console.log(`  ${pad(total(c), 4)} ${file}  ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
  }
  if (args.includes('--lines')) {
    console.log('\nLines:');
    const { lines } = scanTree(root);
    for (const [file, ls] of Object.entries(lines)) for (const l of ls) console.log(`  ${file}:${l}`);
  }
}

function main(args) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const file = join(root, BASELINE_FILE);
  if (args.includes('--seed')) {
    if (existsSync(file)) throw new Error(`${BASELINE_FILE} exists: the baseline is only ever lowered (--tighten).`);
    writeFileSync(file, serializeBaseline(scanTree(root).files));
    console.log(`Wrote ${BASELINE_FILE}.`);
    return;
  }
  if (args.includes('--tighten')) {
    const before = JSON.parse(readFileSync(file, 'utf8')).files;
    const after = tighten(scanTree(root).files, before);
    writeFileSync(file, serializeBaseline(after));
    const sum = (b) => Object.values(b).flatMap((c) => Object.values(c)).reduce((a, n) => a + n, 0);
    console.log(`${BASELINE_FILE}: ${Object.keys(before).length} → ${Object.keys(after).length} files, ${sum(before)} → ${sum(after)} references.`);
    return;
  }
  report(root, args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
