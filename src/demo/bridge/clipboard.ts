// clipboard.* in the demo: an in-memory clipboard the app reads back without a permission
// prompt; writes also go to the browser's clipboard when the page may write it (a copy works outside the demo too),
// with their HTML flavour when they have one (Ask's formatted copies) and the browser takes it.
import type { AtelierApi } from '@shared/api';
import { resolved, type DemoContext } from './context';

const MAX_CHARS = 16 * 1024 * 1024;

function browserWrite(text: string, html: string | undefined): void {
  const clip = navigator.clipboard;
  if (!clip) return;
  const plain = () => { void clip.writeText?.(text).catch(() => {}); };
  if (html === undefined || typeof ClipboardItem !== 'function' || typeof clip.write !== 'function') { plain(); return; }
  // Refused (a browser or a frame that takes no HTML item): the text still goes, as a plain copy always did.
  try {
    const blob = (s: string, type: string) => new Blob([s], { type });
    void clip.write([new ClipboardItem({ 'text/plain': blob(text, 'text/plain'), 'text/html': blob(html, 'text/html') })]).catch(plain);
  } catch {
    plain();
  }
}

export function createClipboard(ctx: DemoContext): AtelierApi['clipboard'] {
  return {
    write(text, html) {
      if (text.length > MAX_CHARS || (html !== undefined && html.length > MAX_CHARS)) return resolved(false);
      ctx.state.clipboard = text;
      try { browserWrite(text, html); } catch { /* not allowed here: the demo's own still has it */ }
      return resolved(true);
    },
    read: () => resolved(ctx.state.clipboard),
    saveImage: () => resolved(null)
  };
}
