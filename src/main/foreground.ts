// Which shells run a command in the foreground, for a window closing: a shell whose
// terminal's foreground process group is not its own runs one (`npm run dev`, `ssh`, `vim`); its own background
// children (gitstatusd, a `&` job) never change that. macOS only: Windows has no process groups, its shells count idle.
import { currentPlatform } from '@shared/platform';
import { PS, parsePsGroups, pgrpArgs, readArgs, runProc, type ExecFileLike } from './procs/exec';

const MAX_TEXT = 80;

/** A command line as the question shows it: the program without its folder, at most 80 characters. */
export function commandText(args: string): string {
  const [first = '', ...rest] = args.trim().split(' ');
  const text = [first.split('/').at(-1) ?? first, ...rest].join(' ');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/**
 * Terminal id → the command its shell runs in the foreground ('' when its line could not be read). A table that can't
 * be read throws: nothing is known, so the close keeps everything (close-guard). No pid or Windows: none busy.
 */
export async function busyShells(terms: readonly { id: string; pid?: number }[], exec?: ExecFileLike): Promise<Map<string, string>> {
  const busy = new Map<string, string>();
  if (currentPlatform() === 'win32') return busy;
  const withPid = terms.filter((t): t is { id: string; pid: number } => Number.isInteger(t.pid) && t.pid! > 0);
  if (withPid.length === 0) return busy;
  const groups = parsePsGroups(await runProc(PS, pgrpArgs(withPid.map((t) => t.pid)), exec));
  const leaderOf = new Map<number, number>();
  for (const g of groups) if (g.tpgid > 0 && g.tpgid !== g.pgid) leaderOf.set(g.pid, g.tpgid);
  if (leaderOf.size === 0) return busy;
  // Only the text shown: a failure there leaves the command unnamed.
  const args = new Map((await readArgs([...new Set(leaderOf.values())], exec).catch(() => [])).map((a) => [a.pid, a.args]));
  for (const t of withPid) {
    const leader = leaderOf.get(t.pid);
    if (leader !== undefined) busy.set(t.id, commandText(args.get(leader) ?? ''));
  }
  return busy;
}
