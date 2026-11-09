import type { ShellCommandResult } from '@shared/api';
import { t } from './i18n/en';
import { useApp } from './store';

/** The toast after Install / Uninstall 'atelier' Command; null when the password was cancelled. */
export function shellCommandToast(r: ShellCommandResult): string | null {
  const s = t.shellCommand;
  if ('ok' in r) return s[r.ok];
  if (r.error === 'cancelled') return null;
  if (r.error === 'foreign') return s.foreign(r.detail ?? '/usr/local/bin/atelier');
  if (r.error === 'failed') return s.failed(r.detail);
  return s[r.error];
}

export async function runShellCommand(op: 'install' | 'uninstall'): Promise<void> {
  const api = window.atelier.shellCommand;
  const r = await (op === 'install' ? api.install() : api.uninstall()).catch((e: unknown): ShellCommandResult => ({ error: 'failed', detail: (e as Error).message }));
  const text = shellCommandToast(r);
  if (text) useApp.getState().showToast(text, undefined, 'error' in r ? undefined : 'info');
}
