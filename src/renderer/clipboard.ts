// Copy through the main process (the renderer has no clipboard access of its own): a refusal (over 16 MB) is said.
// With html, the copy carries that HTML flavour too (Ask's formatted copies: ClickUp and Word paste it formatted).
import { useApp } from './store';
import { t } from './i18n/en';

export async function copyText(text: string, html?: string): Promise<boolean> {
  const ok = await (html === undefined ? window.atelier.clipboard.write(text) : window.atelier.clipboard.write(text, html)).catch(() => false);
  if (!ok) useApp.getState().showToast(t.clipboardTooLarge);
  return !!ok;
}
