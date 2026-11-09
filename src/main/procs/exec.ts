import { execFile } from 'node:child_process';
import type { ProcArgs } from '@shared/background';
import { currentPlatform } from '@shared/platform';

/**
 * Listening ports of terminals and the work scan: the process table, the arguments
 * of given pids and the TCP sockets in LISTEN of given pids, read-only. Three fixed forms only, by absolute path and
 * through execFile (no shell), argv checked before running, 2 s timeout, output capped at 1 MB. Windows:
 * Atelier's own atelier-procs.exe (native/atelier-procs.c) in their place, at the path main gives at start, with
 * three forms: `tree`, `args <pids>`, `tcp`.
 */
export const PS = '/bin/ps';
export const PS_ARGS: readonly string[] = ['-A', '-o', 'pid=,ppid='];
// -ww: unlimited width, so a long argument list (a background shell's whole command) is never cut.
const PS_ARGS_HEAD = ['-ww', '-o', 'pid=,args=', '-p'];
// A window closing: each shell's group and its terminal's foreground group.
const PS_PGRP_HEAD = ['-o', 'pid=,pgid=,tpgid=', '-p'];
export const LSOF = '/usr/sbin/lsof';
// -b: never block on kernel calls (stat, readlink) that can hang on a stuck network mount; -w: without the warnings -b prints.
const LSOF_HEAD = ['-b', '-w', '-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p'];
const LSOF_FIELDS = ['-F', 'pcn'];
/** At most this many pids in one lsof call (the ports hub caps its list to it). */
export const MAX_PIDS = 512;
const PID = /^[1-9]\d{0,7}$/;
// Open in Finder: the current folder of one terminal's shell (it follows `cd`).
const LSOF_CWD_HEAD = ['-b', '-w', '-a', '-d', 'cwd', '-p'];
const LSOF_CWD_FIELDS = ['-F', 'n'];

// Redis clients: which terminal process holds a connection to a host Redis on this port.
const LSOF_EST_HEAD = ['-b', '-w', '-nP', '-a'];
const LSOF_EST_STATE = '-sTCP:ESTABLISHED';

/** lsof's arguments for these pids' connections established to a local TCP port (validated like any other argv). */
export function establishedArgs(port: number, pids: readonly number[]): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('procs: bad port');
  const args = [...LSOF_EST_HEAD, `-iTCP:${port}`, LSOF_EST_STATE, '-p', pids.join(','), ...LSOF_FIELDS];
  validateProcCommand(LSOF, args);
  return args;
}

/** lsof's arguments for one shell's current folder (validated like any other argv). */
export function cwdArgs(pid: number): string[] {
  const args = [...LSOF_CWD_HEAD, String(pid), ...LSOF_CWD_FIELDS];
  validateProcCommand(LSOF, args);
  return args;
}

/** lsof's arguments for these pids (validated like any other argv). */
export function lsofArgs(pids: readonly number[]): string[] {
  const args = [...LSOF_HEAD, pids.join(','), ...LSOF_FIELDS];
  validateProcCommand(LSOF, args);
  return args;
}

/** ps's arguments form for these pids: `ps -ww -o pid=,args= -p <pids>` (validated like any other argv). */
export function psArgsArgs(pids: readonly number[]): string[] {
  const args = [...PS_ARGS_HEAD, pids.join(',')];
  validateProcCommand(PS, args);
  return args;
}

/** ps's process groups form for these pids: `ps -o pid=,pgid=,tpgid= -p <pids>` (validated like any other argv). */
export function pgrpArgs(pids: readonly number[]): string[] {
  const args = [...PS_PGRP_HEAD, pids.join(',')];
  validateProcCommand(PS, args);
  return args;
}

const pidList = (list: string) => { const pids = list.split(','); return pids.length <= MAX_PIDS && pids.every((p) => PID.test(p)); };

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Throws unless (file, args) is exactly `ps -A -o pid=,ppid=`, `ps -ww -o pid=,args= -p <pids>`, `ps -o pid=,pgid=,tpgid= -p <pids>`,
 * `lsof -b -w -nP -a -iTCP -sTCP:LISTEN -p <pids> -F pcn`, `lsof -b -w -nP -a -iTCP:<port> -sTCP:ESTABLISHED -p <pids> -F pcn`
 * or `lsof -b -w -a -d cwd -p <pid> -F n`.
 */
export function validateProcCommand(file: string, args: readonly string[]): void {
  const bad = (why: string): never => { throw new Error(`procs: ${why}: ${file} ${args.join(' ')}`); };
  if (winProcs !== null && file === winProcs) {
    if (same(args, ['tree']) || same(args, ['tcp'])) return;
    if (args.length === 2 && args[0] === 'args' && pidList(args[1]!)) return;
    bad('form not allowed');
  }
  if (file === PS) {
    if (same(args, PS_ARGS)) return;
    if (args.length === PS_PGRP_HEAD.length + 1 && same(args.slice(0, PS_PGRP_HEAD.length), PS_PGRP_HEAD)) {
      if (!pidList(args[PS_PGRP_HEAD.length]!)) bad('pid list not allowed');
      return;
    }
    if (args.length !== PS_ARGS_HEAD.length + 1 || !same(args.slice(0, PS_ARGS_HEAD.length), PS_ARGS_HEAD)) bad('form not allowed');
    if (!pidList(args[PS_ARGS_HEAD.length]!)) bad('pid list not allowed');
    return;
  }
  if (file === LSOF && args[3] === '-d') {
    if (args.length !== LSOF_CWD_HEAD.length + 1 + LSOF_CWD_FIELDS.length) bad('form not allowed');
    if (!same(args.slice(0, LSOF_CWD_HEAD.length), LSOF_CWD_HEAD) || !same(args.slice(LSOF_CWD_HEAD.length + 1), LSOF_CWD_FIELDS)) bad('form not allowed');
    if (!PID.test(args[LSOF_CWD_HEAD.length]!)) bad('pid not allowed');
    return;
  }
  if (file === LSOF && args[5] === LSOF_EST_STATE) {
    if (args.length !== LSOF_EST_HEAD.length + 4 + LSOF_FIELDS.length) bad('form not allowed');
    if (!same(args.slice(0, LSOF_EST_HEAD.length), LSOF_EST_HEAD) || args[6] !== '-p' || !same(args.slice(8), LSOF_FIELDS)) bad('form not allowed');
    const m = /^-iTCP:(\d{1,5})$/.exec(args[4]!);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535) bad('port not allowed');
    if (!pidList(args[7]!)) bad('pid list not allowed');
    return;
  }
  if (file === LSOF) {
    if (args.length !== LSOF_HEAD.length + 1 + LSOF_FIELDS.length) bad('form not allowed');
    if (!same(args.slice(0, LSOF_HEAD.length), LSOF_HEAD) || !same(args.slice(LSOF_HEAD.length + 1), LSOF_FIELDS)) bad('form not allowed');
    if (!pidList(args[LSOF_HEAD.length]!)) bad('pid list not allowed');
    return;
  }
  bad('command not allowed');
}

/** `ps -o pid=,pgid=,tpgid=` output: one process per line (lines that aren't three numbers are skipped). */
export function parsePsGroups(out: string): { pid: number; pgid: number; tpgid: number }[] {
  const list: { pid: number; pgid: number; tpgid: number }[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s*$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]) });
  }
  return list;
}

/** Children of each pid, from `ps -A -o pid=,ppid=` (lines that aren't two numbers are skipped). */
export function parsePsTree(out: string): Map<number, number[]> {
  const tree = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const kids = tree.get(ppid);
    if (kids) kids.push(pid); else tree.set(ppid, [pid]);
  }
  return tree;
}

/** The root and every process below it, root first (each pid once, even if the table read had a cycle). */
export function descendants(tree: Map<number, number[]>, root: number): number[] {
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    for (const k of tree.get(queue[i]!) ?? []) if (!seen.has(k)) { seen.add(k); queue.push(k); }
  }
  return queue;
}

/**
 * `ps -o pid=,args=` output: one process per line, its pid then its arguments (inner spaces kept, the line's ends
 * trimmed). Lines without a pid and arguments are skipped. The form has no parent pid: `ppid` is 0 (the work hub fills
 * it from the process tree). An argument holding a newline splits its process (it then matches nothing).
 */
export function parsePsArgs(out: string): ProcArgs[] {
  const list: ProcArgs[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d{1,8})\s+(\S.*?)\s*$/.exec(line);
    if (!m || Number(m[1]) < 1) continue;
    list.push({ pid: Number(m[1]), ppid: 0, args: m[2]! });
  }
  return list;
}

export interface ListeningProc { name?: string; ports: number[] }

/**
 * `lsof -F pcn` output: `p<pid>` starts a process, `c<command>` names it, `n<address>:<port>` is one of its listening
 * sockets (`*:3000`, `127.0.0.1:5173`, `[::1]:3000`). Other lines (`f<fd>`, garbage) are ignored. Ports sorted, once.
 */
export function parseLsof(out: string): Map<number, ListeningProc> {
  const found = new Map<number, { name?: string; ports: Set<number> }>();
  let current: { name?: string; ports: Set<number> } | null = null;
  for (const line of out.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      current = null;
      if (!/^\d{1,8}$/.test(value) || Number(value) < 1) continue;
      const pid = Number(value);
      current = found.get(pid) ?? { ports: new Set() };
      found.set(pid, current);
    } else if (tag === 'c' && current) {
      if (value) current.name = value.slice(0, 64);
    } else if (tag === 'n' && current && !value.includes('->')) {
      const m = /^(?:\*|\[[0-9A-Fa-f:.%a-z0-9]+\]|[0-9.]+|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
      const port = m ? Number(m[1]) : 0;
      if (port >= 1 && port <= 65535) current.ports.add(port);
    }
  }
  const result = new Map<number, ListeningProc>();
  for (const [pid, p] of found) {
    if (p.ports.size === 0) continue;
    result.set(pid, { ...(p.name ? { name: p.name } : {}), ports: [...p.ports].sort((a, b) => a - b) });
  }
  return result;
}

/** `lsof -F pcn` of established connections: the client side of each connection to `port` → its pid, by local port. */
export function parseEstablished(out: string, port: number): Map<number, number> {
  const found = new Map<number, number>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') { pid = /^\d{1,8}$/.test(line.slice(1)) ? Number(line.slice(1)) : 0; continue; }
    if (line[0] !== 'n' || !pid) continue;
    const m = /^(?:\[[0-9A-Fa-f:.%a-z]+\]|[0-9.]+):(\d{1,5})->(?:\[[0-9A-Fa-f:.%a-z]+\]|[0-9.]+):(\d{1,5})$/.exec(line.slice(1));
    if (m && Number(m[2]) === port) found.set(Number(m[1]), pid);
  }
  return found;
}

export type ExecFileLike = (
  file: string, args: string[], opts: { timeout: number; maxBuffer: number; encoding: 'utf8'; env?: NodeJS.ProcessEnv },
  cb: (err: (Error & { code?: number | string | null }) | null, stdout: string, stderr: string) => void
) => void;

const realExec: ExecFileLike = (file, args, opts, cb) => {
  execFile(file, args, { ...opts, windowsHide: true }, (err, stdout, stderr) => cb(err as (Error & { code?: number | string | null }) | null, String(stdout), String(stderr)));
};

/**
 * Runs one of the allowed commands. lsof exits 1 when nothing matched or a pid is gone: that is its output. ps of given
 * pids exits 1, silently, when none of them is left: no process.
 */
export function runProc(file: string, args: readonly string[], exec: ExecFileLike = realExec): Promise<string> {
  try { validateProcCommand(file, args); } catch (err) { return Promise.reject(err); }
  return new Promise((resolve, reject) => {
    // A folder name in a UTF-8 locale: an app opened from the Dock has no LANG, and lsof then escapes "città" as \xc3\xa0.
    const env = file === LSOF && args[3] === '-d' ? { env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } } : {};
    exec(file, [...args], { timeout: 2000, maxBuffer: 1024 * 1024, encoding: 'utf8', ...env }, (err, stdout, stderr) => {
      if (!err || (file === LSOF && err.code === 1)) { resolve(stdout); return; }
      if (file === PS && (args[0] === PS_ARGS_HEAD[0] || args[1] === PS_PGRP_HEAD[1]) && err.code === 1 && !stdout.trim() && !stderr.trim()) { resolve(''); return; }
      reject(new Error(`${file}: ${(stderr || err.message).trim()}`));
    });
  });
}

/** Windows: atelier-procs.exe's path (packaged: resources/bin; dev: vendor/bin), or null when there is none. */
let winProcs: string | null = null;
export function useWindowsProcs(path: string | null): void { winProcs = path; }
const onWindows = () => currentPlatform() === 'win32';
const procsBin = (): string => { if (!winProcs) throw new Error('procs: atelier-procs.exe not found'); return winProcs; };

export interface TcpTable { listening: Map<number, ListeningProc>; established: { pid: number; local: number; remote: number }[] }

/**
 * `atelier-procs tcp`: `L <pid> <port> <image>` for a listening socket, `E <pid> <local> <remote>` for a connection to a
 * loopback address. Ports sorted, once; malformed lines skipped.
 */
export function parseTcp(out: string): TcpTable {
  const found = new Map<number, { name?: string; ports: Set<number> }>();
  const established: TcpTable['established'] = [];
  const port = (s: string) => { const n = Number(s); return /^\d{1,5}$/.test(s) && n >= 1 && n <= 65535 ? n : 0; };
  for (const line of out.split('\n')) {
    const f = line.trim().split(' ');
    const pid = /^\d{1,8}$/.test(f[1] ?? '') ? Number(f[1]) : 0;
    if (!pid) continue;
    if (f[0] === 'L' && port(f[2] ?? '')) {
      const p = found.get(pid) ?? { ports: new Set<number>() };
      p.ports.add(port(f[2]!));
      if (f[3]) p.name = f[3].slice(0, 64);
      found.set(pid, p);
    } else if (f[0] === 'E' && port(f[2] ?? '') && port(f[3] ?? '')) {
      established.push({ pid, local: port(f[2]!), remote: port(f[3]!) });
    }
  }
  const listening = new Map<number, ListeningProc>();
  for (const [pid, p] of found) listening.set(pid, { ...(p.name ? { name: p.name } : {}), ports: [...p.ports].sort((a, b) => a - b) });
  return { listening, established };
}

/** The process table: children of each pid. */
export async function readProcessTree(exec?: ExecFileLike): Promise<Map<number, number[]>> {
  if (onWindows()) return parsePsTree(await runProc(procsBin(), ['tree'], exec));
  return parsePsTree(await runProc(PS, PS_ARGS, exec));
}

/** The arguments of these pids (at most MAX_PIDS; none for an empty list). */
export async function readArgs(pids: readonly number[], exec?: ExecFileLike): Promise<ProcArgs[]> {
  if (pids.length === 0) return [];
  if (onWindows()) return parsePsArgs(await runProc(procsBin(), ['args', pids.slice(0, MAX_PIDS).join(',')], exec));
  return parsePsArgs(await runProc(PS, psArgsArgs(pids), exec));
}

/** `lsof -d cwd -F n` output: the `n` line is the folder (an absolute path); null without one. */
export function parseCwd(out: string): string | null {
  const line = out.split('\n').find((l) => l.startsWith('n/'));
  return line ? line.slice(1) : null;
}

/** The current folder of this process (a terminal's shell); null when it is gone. */
export async function readCwd(pid: number, exec?: ExecFileLike): Promise<string | null> {
  return parseCwd(await runProc(LSOF, cwdArgs(pid), exec));
}

/** Connections these pids hold to a local TCP port: client local port → pid. */
export async function readEstablished(port: number, pids: readonly number[], exec?: ExecFileLike): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  if (onWindows()) {
    const mine = new Set(pids);
    return new Map(parseTcp(await runProc(procsBin(), ['tcp'], exec)).established.filter((c) => c.remote === port && mine.has(c.pid)).map((c) => [c.local, c.pid]));
  }
  return parseEstablished(await runProc(LSOF, establishedArgs(port, pids.slice(0, MAX_PIDS)), exec), port);
}

/** The listening TCP ports of these pids (at most MAX_PIDS, at least one). */
export async function readListening(pids: readonly number[], exec?: ExecFileLike): Promise<Map<number, ListeningProc>> {
  if (pids.length === 0) return new Map();
  if (onWindows()) {
    const all = parseTcp(await runProc(procsBin(), ['tcp'], exec)).listening;
    return new Map(pids.flatMap((p) => (all.has(p) ? [[p, all.get(p)!] as [number, ListeningProc]] : [])));
  }
  return parseLsof(await runProc(LSOF, lsofArgs(pids), exec));
}
