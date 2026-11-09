// Shell environment auto-reload: what the window opening an Atelier
// terminal says while main reloads the capture first, or when that reload failed.
import type { ShellEnvAuto } from '@shared/api';
import { t } from './i18n/en';

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function autoReloadToast(e: ShellEnvAuto): { text: string; tone: 'info' | undefined } {
  if (e.phase === 'failed') return { text: t.shellEnvAutoFailed(e.error), tone: undefined };
  // Never empty: main reloads only when it can name what changed.
  const what = e.files.length === 1 ? t.shellEnvAutoOne(base(e.files[0]!)) : t.shellEnvAutoMany(e.files.length);
  return { text: t.shellEnvAutoReloading(what), tone: 'info' };
}
