import { execFile } from 'node:child_process';

// Windows before 11 24H2 (closeWaitsForPrograms): ClosePseudoConsole returns only once every program in the console
// exited, on atelierd's own thread, and Claude's SessionEnd hook waits for atelierd meanwhile (3-4 s on Windows 10,
// every terminal frozen). So `taskkill /PID <shell> /FI "IMAGENAME eq <shell>.exe" /T /F` starts right before the
// console closes: the close then waits only for taskkill ending the shell and what it started. Started, not awaited: a
// console whose shell exited before it closed is never closed by node-pty (a conhost.exe left behind, measured on 25H2).
// The image filter keeps a pid freed a moment ago (the shell exited by itself) from naming another process's tree.
// One fixed program, argv only (tests/integration/no-child-process.test.ts).

/** taskkill's own bound. */
const TIMEOUT_MS = 3000;

type Run = (file: string, args: string[]) => void;

const runTaskkill: Run = (file, args) => {
  execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true }, () => { /* ended, gone already, or not ours */ });
};

/** An executable's file name only: no folder, quote, wildcard or control character. */
const IMAGE = /^[^\\/:*?"<>|\x00-\x1f]+\.exe$/i;

/** Starts ending a shell's process tree (the shell itself only while `image` is its image); never throws. */
export function endTreeWith(run: Run = runTaskkill, systemRoot = process.env.SystemRoot ?? 'C:\\Windows'): (pid: number, image: string) => void {
  return (pid, image) => {
    if (!Number.isInteger(pid) || pid <= 0 || !IMAGE.test(image)) return;
    try { run(`${systemRoot}\\System32\\taskkill.exe`, ['/PID', String(pid), '/FI', `IMAGENAME eq ${image}`, '/T', '/F']); } catch { /* the console closes all the same */ }
  };
}
