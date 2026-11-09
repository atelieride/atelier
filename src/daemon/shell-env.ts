import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { shellQuote } from '@shared/shell';
import { inherited } from './env';

// Atelier-profile terminals don't run the user's .zshrc: atelierd runs
// the user's login+interactive zsh once, captures the environment it ends up with (PATH, nvm, pyenv, brew…) and
// gives it to those terminals. Kept in memory only: it holds secrets (tokens in variables) and per-boot values
// (SSH_AUTH_SOCK, SECURITYSESSIONID), so every atelierd start captures it afresh.

/**
 * claude: what `claude` was in the user's shell, as zsh words for Atelier's claude function (their alias's text, or
 * the quoted path found on PATH); the Atelier profile doesn't load their rc, so it would lose an alias otherwise.
 * aliases: the user's regular (r), global (g) and suffix (s) aliases, for Atelier-profile terminals.
 */
export interface Alias { kind: 'r' | 'g' | 's'; name: string; value: string }
export interface Captured { env: Record<string, string>; claude: string | null; aliases: Alias[] }
/** aliasCode: the aliases as zsh code for the Atelier profile (aliasSnippet; null = too large, left out). */
export interface ShellEnv extends Captured { capturedAt: number; aliasCode: { code: string; count: number } | null }

// Variables that belong to one shell or one terminal, not to the user's environment.
const PER_SHELL = new Set([
  'PWD', 'OLDPWD', 'SHLVL', '_', 'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT', 'RPROMPT', 'RPS1', 'RPS2', 'ZDOTDIR',
  // Set from `tty`, which has no terminal during the capture ("not a tty"): the Atelier rc sets it per terminal.
  'GPG_TTY'
]);
// Atelier's own variables, the macOS Terminal session and powerlevel10k's per-tty state.
const PER_SHELL_PREFIXES = ['ATELIER_', 'TERM_SESSION', 'P9K_', '_P9K_'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables from `env -0` output (entries separated by NUL; names that are not variables are skipped). */
function parseEnvEntries(block: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of block.split('\0')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const k = entry.slice(0, i);
    if (NAME.test(k)) env[k] = entry.slice(i + 1);
  }
  return env;
}

/** The `env -0` output between `${marker}S` and `${marker}E`; null when the block is missing or incomplete. */
export function parseEnvBlock(out: string, marker: string): Record<string, string> | null {
  const block = new EnvBlockScanner(marker).push(out);
  return block === null ? null : parseEnvEntries(block);
}

/**
 * Finds the block between `${marker}S` and `${marker}E` in output that arrives in chunks. Each chunk is scanned once
 * (plus a marker's length of overlap): atelierd has a single thread and the output may reach 16 MB.
 */
export class EnvBlockScanner {
  /** Before the start marker: only the last characters, which may hold the beginning of a split marker. */
  private before = '';
  /** After the start marker: the block's pieces so far, and their length. */
  private parts: string[] | null = null;
  private length = 0;
  /** The block's last characters, which may hold the beginning of a split end marker. */
  private tail = '';
  constructor(private readonly marker: string) {}

  /** Adds a chunk; returns the block's content once it is complete. */
  push(chunk: string): string | null {
    const start = `${this.marker}S`;
    const end = `${this.marker}E`;
    if (this.parts === null) {
      const s = this.before + chunk;
      const i = s.indexOf(start);
      if (i === -1) { this.before = s.slice(-(start.length - 1)); return null; }
      this.parts = [];
      chunk = s.slice(i + start.length);
    }
    // The end marker may begin in earlier pieces: search from the overlap.
    const w = this.tail + chunk;
    const j = w.indexOf(end);
    if (j === -1) { this.parts.push(chunk); this.length += chunk.length; this.tail = w.slice(-(end.length - 1)); return null; }
    return (this.parts.join('') + chunk).slice(0, this.length - this.tail.length + j);
  }
}

/**
 * The capture's block: `env -0` output, then `${marker}C` and what claude resolves to ("a:alias text" or "p:path"),
 * then `${marker}A` and the aliases as NUL-terminated kind, name, value triples.
 */
export function parseCaptured(block: string, marker: string): Captured {
  const c = block.lastIndexOf(`${marker}C`);
  const env = filterCapturedEnv(parseEnvEntries(c === -1 ? block : block.slice(0, c)));
  const a = c === -1 ? -1 : block.indexOf(`${marker}A`, c);
  const what = c === -1 ? '' : block.slice(c + marker.length + 1, a === -1 ? undefined : a);
  const claude = what.startsWith('a:') && what.length > 2 ? what.slice(2) : what.startsWith('p:/') ? shellQuote(what.slice(2)) : null;
  return { env, claude, aliases: a === -1 ? [] : parseAliases(block.slice(a + marker.length + 1)) };
}

function parseAliases(part: string): Alias[] {
  const f = part.split('\0');
  const out: Alias[] = [];
  // Only complete triples: the last field after the final NUL is empty (or a cut-off triple).
  for (let i = 0; i + 3 < f.length; i += 3) {
    const [kind, name, value] = [f[i]!, f[i + 1]!, f[i + 2]!];
    if ((kind === 'r' || kind === 'g' || kind === 's') && name) out.push({ kind, name, value });
  }
  return out;
}

const ALIAS_FLAG = { r: '', g: '-g ', s: '-s ' } as const;
/** Above this the aliases are left out: environment and arguments must stay well under macOS's ARG_MAX (1 MB). */
const MAX_ALIAS_CODE = 256 * 1024;

/**
 * The zsh code defining the user's aliases in an Atelier-profile terminal: one `alias` per line, name=value quoted
 * by atelierd as a single word, so the code always parses whatever the user wrote. claude stays with Atelier's
 * function (ATELIER_USER_CLAUDE); a name with `=` can't be defined by `alias`. Null when too large.
 */
export function aliasSnippet(aliases: readonly Alias[]): { code: string; count: number } | null {
  const lines = aliases
    // claude of any kind: a global one would rewrite the initial `claude …` command too.
    .filter((x) => !x.name.includes('=') && x.name !== 'claude')
    .map((x) => `alias ${ALIAS_FLAG[x.kind]}-- ${shellQuote(`${x.name}=${x.value}`)}`);
  const code = lines.join('\n');
  return Buffer.byteLength(code) > MAX_ALIAS_CODE ? null : { code, count: lines.length };
}

export function filterCapturedEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (PER_SHELL.has(k) || PER_SHELL_PREFIXES.some((p) => k.startsWith(p)) || !inherited(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface CaptureOptions {
  /** Environment the user's shell starts with (ZDOTDIR already the user's, or absent). */
  env: Record<string, string>;
  cwd: string;
  shell?: string;
  timeoutMs?: number;
}

/**
 * Runs the user's login+interactive zsh once (stdin /dev/null, so a question at startup can't wait for an answer)
 * and returns its filtered environment. The block is delimited by random markers: whatever the user's startup files
 * print around it is ignored.
 */
export function captureShellEnv(o: CaptureOptions): { result: Promise<Captured>; cancel(): void } {
  const marker = `__ATELIER_ENV_${randomBytes(8).toString('hex')}_`;
  // zsh only (eval keeps other shells from parsing it): the user's claude alias, otherwise the claude on PATH.
  const claude = `if (( \${+aliases[claude]} )); then print -rn -- "a:\${aliases[claude]}"; elif (( \${+commands[claude]} )); then print -rn -- "p:\${commands[claude]}"; fi`;
  // Then the aliases of all three kinds, as NUL-terminated kind, name, value triples.
  const aliases = `print -rn -- "${marker}""A"; local k v; for k v in "\${(@kv)aliases}"; do print -rN -- r "$k" "$v"; done; for k v in "\${(@kv)galiases}"; do print -rN -- g "$k" "$v"; done; for k v in "\${(@kv)saliases}"; do print -rN -- s "$k" "$v"; done`;
  // The script is in the environment of everything the user's config runs (a tool may print it): its text never holds
  // a whole marker, each is printed in two pieces. It leaves the environment before env -0.
  const script = `unset ATELIER_CAPTURE_SCRIPT; printf '%s%s' '${marker}' 'S'; /usr/bin/env -0; printf '%s%s' '${marker}' 'C'; [ -n "$ZSH_VERSION" ] && eval '${claude}; ${aliases}'; printf '%s%s' '${marker}' 'E'`;
  // zsh parses the whole -c string before running it, with the user's aliases (from their .zshrc) defined: an alias
  // named print, for or in would rewrite the script. Quoted words are never aliases: the -c string turns aliases off
  // and evals the script, which is parsed only then (a variable dropped from the capture with the other ATELIER_*).
  // emulate also puts back zsh's default options for it (ksh_arrays made "${(@kv)aliases}" its first value only).
  const wrapper = `\\builtin 'emulate' 'zsh' '-o' 'no_aliases' 2>/dev/null; \\eval "$ATELIER_CAPTURE_SCRIPT"`;
  // Its own process group: on timeout or cancel, the background jobs of the user's config go with it.
  const child = spawn(o.shell ?? '/bin/zsh', ['-l', '-i', '-c', wrapper], { cwd: o.cwd, env: { ...o.env, ATELIER_CAPTURE_SCRIPT: script }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  let cancel = () => {};
  const result = new Promise<Captured>((resolve, reject) => {
    const scanner = new EnvBlockScanner(marker);
    let received = 0;
    let done = false;
    const finish = (err: Error | null, captured?: Captured) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.destroy();
      // A failed capture takes its whole process group along (a hung startup file and whatever it started). After a
      // success only the shell goes, if still around: background jobs of the user's config finish their work.
      if (err) killGroup();
      else if (child.exitCode === null) child.kill('SIGKILL');
      if (err) reject(err); else resolve(captured!);
    };
    const timer = setTimeout(() => finish(new Error(`shell environment not captured in ${o.timeoutMs ?? 10000} ms`)), o.timeoutMs ?? 10000);
    cancel = () => finish(new Error('shell environment capture cancelled'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      received += chunk.length;
      if (received > 16 * 1024 * 1024) { finish(new Error('shell environment too large')); return; }
      const block = scanner.push(chunk);
      if (block !== null) finish(null, parseCaptured(block, marker));
    });
    child.on('error', (err) => finish(err));
    const exited = (code: number | null) => finish(new Error(`shell exited (${code}) without printing its environment`));
    child.on('close', exited);
    // A background job of the user's config may hold the pipe open after the shell exits: don't wait for it.
    child.on('exit', (code) => { setTimeout(() => exited(code), 500); });
  });
  return { result, cancel: () => cancel() };
}
