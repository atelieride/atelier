/**
 * Whether a Bash command provably writes no file. Claude Code runs it under the user's zsh,
 * so the lexer follows zsh: anything zsh could read differently from this lexer is refused. Conservative: anything not
 * fully understood — a program off the list, an option that writes, an expansion, an input redirection, a redirection
 * to a file — is a writer. A read-only call is never a candidate for a changed file.
 */

type Tok = { k: 'word'; v: string; g: boolean } | { k: 'sep' } | { k: 'redir'; op: string };

const MAX_CHARS = 2048;
const PLAIN = new Set([
  'cat', 'head', 'tail', 'wc', 'nl', 'cut', 'tr', 'grep', 'egrep', 'fgrep', 'ls', 'stat', 'du', 'df', 'pwd', 'echo',
  'true', 'false', 'which', 'type', 'basename', 'dirname', 'realpath', 'date', 'sleep', 'diff',
  'cmp', 'column', 'cd'
]);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'blame', 'branch', 'rev-parse', 'ls-files', 'grep', 'shortlog', 'describe']);
const FIND_WRITES = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
/** Line addresses and `p` only: `1,40p`, `5p;10p`, `$p`, `3,+2p`. */
const SED_SCRIPT = /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$|\+\d+))?\s*p\s*;?\s*)+$/;
/**
 * Unquoted characters refused anywhere: expansions (`$X`, `${..}`, `$(..)`, `$'..'`, backticks), groups and brace
 * expansion (`{ }`), subshells, process substitution and glob qualifiers (`( )`), and every input redirection (`<`,
 * `N<`, `<>`, `<&`, `<(`, `<<`, `<<<`) — zsh also reads `<->` and `<N-M>` as numeric-range globs.
 */
const REFUSED = new Set(['$', '`', '{', '}', '(', ')', '<']);
/** Inside double quotes a backslash escapes only these; before anything else it stays (`"\1"` is `\1`). */
const DQ_ESCAPES = new Set(['$', '`', '"', '\\']);

/** Splits into words, separators and redirections; null for anything we refuse to reason about. */
function lex(cmd: string): Tok[] | null {
  const out: Tok[] = [];
  let word: string | null = null; // null between words; '' after a quoted empty string
  let globbed = false; // the word holds an unquoted glob character
  let quoted = false; // part of the word was quoted or escaped
  const flush = () => {
    if (word !== null) { out.push({ k: 'word', v: word, g: globbed }); word = null; }
    globbed = false;
    quoted = false;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;
    const next = cmd[i + 1];

    // Quoting.
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return null;
      word = (word ?? '') + cmd.slice(i + 1, j);
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let v = '';
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        // Any expansion, and a backslash-newline (which can split `$(`), is beyond what we model.
        if (cmd[j] === '`' || cmd[j] === '$') return null;
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          if (cmd[j + 1] === '\n') return null;
          if (DQ_ESCAPES.has(cmd[j + 1]!)) { v += cmd[++j]; continue; }
        }
        v += cmd[j];
      }
      if (j >= cmd.length) return null;
      word = (word ?? '') + v;
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') return null; // line continuation
      word = (word ?? '') + (next ?? '');
      quoted = true;
      i += 2;
      continue;
    }

    // `#` starts a comment at the start of a word; anywhere else it is zsh EXTENDED_GLOB "zero or more of the
    // previous character" (`x#-o*` can match `-ofoo`).
    if (c === '#') {
      if (word !== null) return null;
      const j = cmd.indexOf('\n', i);
      if (j < 0) break;
      i = j;
      continue;
    }

    if (REFUSED.has(c)) return null;
    // zsh `=cmd` expands to the program's path, also after a quoted empty string (`''=ls`).
    if (c === '=' && (word === null || word === '')) return null;
    if (c === '~' && next === '[') return null; // zsh dynamic named directory `~[..]` calls a shell function

    // A glob may expand to files named like options or to several words. Glob characters: `*`, `?`, `[`, `^`, and
    // (zsh EXTENDED_GLOB) a `~` that is not the word's first character. Allowed only after a non-empty, non-`-` start
    // of the word's value (`src/*.ts`, `HEAD~1`; not `*.ts`, `''*`, `-*`, `^x`).
    if (c === '*' || c === '?' || c === '[' || c === '^' || (c === '~' && word !== null)) {
      if (word === null || word === '' || word.startsWith('-')) return null;
      globbed = true;
    }

    // Separators. A lone `&` (background, and zsh `&|`, `&!`, `|&`, `;&`) is refused.
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '\n' || c === ';') { flush(); out.push({ k: 'sep' }); i++; continue; }
    if (c === '|') { flush(); out.push({ k: 'sep' }); i += next === '|' ? 2 : 1; continue; }
    if (c === '&') {
      if (next === '&') { flush(); out.push({ k: 'sep' }); i += 2; continue; }
      if (next !== '>') return null;
      flush();
      const op = cmd[i + 2] === '>' ? '&>>' : '&>';
      out.push({ k: 'redir', op });
      i += op.length;
      continue;
    }

    // Output redirection: `>`, `>>`, `>|`, `>&`, with an optional single-digit file descriptor (`2>`): zsh takes the
    // digit as a descriptor only when the word is exactly that unquoted, unescaped digit (`''1>`, `\1>`, `"2">` keep
    // it as an argument). The zsh clobber form `>!` leaves `!` at the start of the target, never an accepted target.
    if (c === '>') {
      let fd = '';
      if (word !== null && !quoted && /^\d$/.test(word)) { fd = word; word = null; globbed = false; } else flush();
      if (next === '(') return null; // process substitution
      let op = '>';
      let j = i + 1;
      if (cmd[j] === '>') { op = '>>'; j++; } else if (cmd[j] === '|') { op = '>|'; j++; } else if (cmd[j] === '&') { op = '>&'; j++; }
      out.push({ k: 'redir', op: fd + op });
      i = j;
      continue;
    }

    word = (word ?? '') + c;
    i++;
  }
  flush();
  return out;
}

/** Duplicating onto stdout/stderr, or writing to /dev/null. */
function redirOk(op: string, target: string): boolean {
  if (/^\d?>&$/.test(op)) return target === '1' || target === '2';
  if (/^(?:\d?>>?|\d?>\||&>>?)$/.test(op)) return target === '/dev/null';
  return false;
}

const shortHas = (args: string[], letter: string) => args.some((a) => /^-[^-]/.test(a) && a.slice(1).includes(letter));
const longHas = (args: string[], name: string) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

const hasLong = (args: string[]) => args.some((a) => a.startsWith('--'));

/** Operands of uniq (input, output): after the first one every argument is an operand (macOS), as is a lone `-`. */
function uniqOperands(args: string[]): number {
  let n = 0;
  let ended = false;
  for (const a of args) {
    if (n > 0 || ended || a === '-' || !a.startsWith('-')) n++;
    else if (a === '--') ended = true;
  }
  return n;
}

function sedReadOnly(args: string[]): boolean {
  let quiet = false;
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--quiet' || a === '--silent') { quiet = true; continue; }
    if (a === '--regexp-extended') continue;
    if (a.startsWith('--expression=')) { scripts.push(a.slice('--expression='.length)); continue; }
    if (a === '--expression') { const s = args[++i]; if (s === undefined) return false; scripts.push(s); continue; }
    if (a.startsWith('--')) return false;
    if (/^-./.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j]!;
        if (f === 'n') quiet = true;
        else if (f === 'E' || f === 'r') continue;
        else if (f === 'e') {
          const s = a.slice(j + 1) || args[++i];
          if (s === undefined) return false;
          scripts.push(s);
          break;
        } else return false; // -i, -I, -f, -s, -u and anything else
      }
      continue;
    }
    operands.push(a);
  }
  if (scripts.length === 0) {
    const s = operands.shift();
    if (s === undefined) return false;
    scripts.push(s);
  }
  return quiet && scripts.every((s) => SED_SCRIPT.test(s));
}

function gitReadOnly(args: string[], globbed: boolean[]): boolean {
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--no-pager') { i++; continue; }
    if (args[i] === '-C') { if (globbed[i + 1]) return false; i += 2; continue; }
    break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub || !GIT_READ.has(sub)) return false;
  // -o/-O (output, pager), --output*, --open*, --ext-diff; any abbreviation starting `--o`/`--ext` too.
  if (rest.some((a) => a !== '--oneline' && (a.startsWith('-O') || /^-[^-]/.test(a) && a.includes('O') || a.startsWith('-o') || a.startsWith('--o') || a.startsWith('--ext')))) return false;
  return sub !== 'branch' || rest.length === 0;
}

function programReadOnly(prog: string, args: string[], globbed: boolean[]): boolean {
  if (PLAIN.has(prog)) return true;
  switch (prog) {
    // Long options may be abbreviated (getopt_long), so every `--` option is refused.
    case 'sort': return !hasLong(args) && !shortHas(args, 'o') && !shortHas(args, 'T');
    // A glob expands to one argument per match, so two matches would become `input output`.
    case 'uniq': return !globbed.some(Boolean) && uniqOperands(args) <= 1;
    case 'rg': return !args.some((a) => a.startsWith('--pre') || a.startsWith('--hostname'));
    case 'tree': return !hasLong(args) && !shortHas(args, 'o') && !shortHas(args, 'R');
    case 'file': return !hasLong(args) && !shortHas(args, 'C');
    case 'jq': return !shortHas(args, 'i') && !longHas(args, 'in-place');
    case 'sed': return sedReadOnly(args);
    case 'find': return !args.some((a) => FIND_WRITES.has(a));
    case 'git': return gitReadOnly(args, globbed);
    default: return false;
  }
}

export function readOnlyCommand(command: string): boolean {
  if (command.length > MAX_CHARS) return false;
  const toks = lex(command);
  if (!toks) return false;
  let words: { v: string; g: boolean }[] = [];
  let redirected = false;
  let segments = 0;
  for (let i = 0; i <= toks.length; i++) {
    const t = toks[i];
    if (!t || t.k === 'sep') {
      if (words.length > 0) {
        const [first, ...rest] = words;
        const prog = first?.v;
        const args = rest.map((w) => w.v);
        // No assignments (FOO=1 cmd) and no program given by a path.
        if (!prog || prog.includes('=') || prog.includes('/') || !programReadOnly(prog, args, rest.map((w) => w.g))) return false;
        segments++;
      } else if (redirected) {
        return false; // zsh runs $NULLCMD for a redirection without a command
      }
      words = [];
      redirected = false;
      continue;
    }
    if (t.k === 'redir') {
      const target = toks[i + 1];
      if (!target || target.k !== 'word' || !redirOk(t.op, target.v)) return false;
      redirected = true;
      i++;
      continue;
    }
    words.push({ v: t.v, g: t.g });
  }
  return segments > 0;
}
