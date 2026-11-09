// Errors of this page go to the main process's app log (ATELIER_HOME/logs/app.log): uncaught errors (rAF callbacks,
// listeners), unhandled rejections and what the error boundaries catch. Messages and stacks only.
import { RENDERER_ERROR_MAX, type RendererError } from '@shared/api';

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: err.stack };
  if (typeof err === 'string') return { message: err };
  if (err === undefined) return { message: 'undefined' };
  try { return { message: JSON.stringify(err) ?? String(err) }; } catch { return { message: String(err) }; }
}

/** What is sent to main: clipped to what its schema accepts. */
export function rendererError(kind: RendererError['kind'], err: unknown, panel?: string, componentStack?: string): RendererError {
  const d = describe(err);
  const stack = [d.stack, componentStack ? `Component stack:${componentStack}` : ''].filter(Boolean).join('\n');
  return {
    kind,
    message: d.message.slice(0, RENDERER_ERROR_MAX.message),
    ...(stack ? { stack: stack.slice(0, RENDERER_ERROR_MAX.stack) } : {}),
    ...(panel ? { panel: panel.slice(0, RENDERER_ERROR_MAX.panel) } : {})
  };
}

/** The text "Copy details" puts on the clipboard. */
export function crashDetails(e: RendererError, version: string | null): string {
  const head = `Atelier ${version ?? '?'}${e.panel ? ` · ${e.panel}` : ''}`;
  return `${head}\n${e.message}${e.stack ? `\n\n${e.stack}` : ''}`;
}

export function reportError(e: RendererError): void {
  try { window.atelier.logError(e); } catch { /* no bridge (a broken preload): nothing to do */ }
}

/** Uncaught errors and unhandled rejections of the page, from now on. */
export function installErrorReporting(): void {
  window.addEventListener('error', (ev) => reportError(rendererError('error', ev.error ?? ev.message)));
  window.addEventListener('unhandledrejection', (ev) => reportError(rendererError('rejection', ev.reason)));
}
