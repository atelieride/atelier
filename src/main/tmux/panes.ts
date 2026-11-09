import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { hostname } from 'node:os';
import type { ServicePane } from '@shared/services';
import { isShell } from '@shared/shells';
import { PANE_FORMAT, TmuxNotInstalled, TmuxUnavailable, runTmux } from './exec';
import { isInside } from '@shared/paths';

export { PANE_FORMAT };


type PaneMeta = Omit<ServicePane, 'errors' | 'port' | 'stale'>;

export function parsePanes(out: string, host: string): PaneMeta[] {
  return out.split('\n').filter(Boolean).map((line) => {
    const [id = '', session = '', win = '0', idx = '0', title = '', command = '', cwd = ''] = line.split('\t');
    // A pane's default title is the host name: in that case the name comes from the folder.
    const titled = title && title !== host && !title.startsWith(host + '.') ? title : '';
    return { id, session, window: Number(win), index: Number(idx), name: titled || basename(cwd), command, cwd, running: !isShell(command) };
  });
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export function panesInProject(panes: PaneMeta[], root: string): PaneMeta[] {
  const r = real(root);
  return panes.filter((p) => { const c = real(p.cwd); return isInside(r, c); });
}

// Test tmux server: only the e2e tests set ATELIER_TMUX_SERVER (the real app uses the default server).
const defaultServer = () => process.env.ATELIER_TMUX_SERVER || undefined;

export type ServicesStatus = 'ok' | 'no-server' | 'no-tmux';

/** The project's panes, with the reason when there are none (tmux missing or server off). */
export async function listPanes(root: string, opts: { server?: string } = {}): Promise<{ status: ServicesStatus; panes: PaneMeta[] }> {
  opts = { server: defaultServer(), ...opts };
  try {
    const out = await runTmux(['list-panes', '-a', '-F', PANE_FORMAT], opts);
    return { status: 'ok', panes: panesInProject(parsePanes(out, hostname().split('.')[0] ?? ''), root) };
  } catch (err) {
    if (err instanceof TmuxNotInstalled) return { status: 'no-tmux', panes: [] };
    if (err instanceof TmuxUnavailable) return { status: 'no-server', panes: [] };
    throw err;
  }
}

const MAX_LINE = 8192;

/** Trailing empty lines removed; very long lines (JSON logs with whole bodies) truncated. */
export function trimLines(lines: string[], max = MAX_LINE): string[] {
  const out = lines.map((l) => (l.length > max ? l.slice(0, max) + '…' : l));
  while (out.length && out.at(-1)!.replace(/\x1b\[[0-9;]*m/g, '').trim() === '') out.pop();
  return out;
}

export async function capturePane(id: string, opts: { server?: string } = {}): Promise<string[]> {
  opts = { server: defaultServer(), ...opts };
  try {
    return trimLines((await runTmux(['capture-pane', '-p', '-e', '-J', '-S', '-2000', '-t', id], opts)).split('\n'));
  } catch (err) {
    // Output beyond the limit (huge lines): retry with a smaller window instead of giving up.
    if (!/maxBuffer/i.test((err as Error).message)) throw err;
    return trimLines((await runTmux(['capture-pane', '-p', '-e', '-J', '-S', '-200', '-t', id], opts)).split('\n'));
  }
}
