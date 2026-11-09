import { Component, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import type { RendererError } from '@shared/api';
import { crashDetails, rendererError, reportError } from '../error-report';
import { t } from '../i18n/en';
import { Icon } from './Icon';

// A render error used to unmount the whole React tree (a blank window, 2026-10-11): each major panel now has its own
// boundary, the app one around them all. The error goes to the app log; the card offers a reload and the details.

/** Test only (ATELIER_TEST_RENDER_ERROR, inert in the packaged app): the panel made to throw once the app has rendered. */
let fault: string | null = null;
const faultSubs = new Set<() => void>();
export function loadTestFault(): void {
  void window.atelier.testFault().then((p) => { fault = p; for (const f of faultSubs) f(); }).catch(() => {});
}
const subscribeFault = (f: () => void) => { faultSubs.add(f); return () => { faultSubs.delete(f); }; };

function FaultProbe({ id }: { id: string }): null {
  const f = useSyncExternalStore(subscribeFault, () => fault);
  if (f === id) throw new Error(`Test render error in ${id}`);
  return null;
}

interface Props {
  /** Test hook id ('app', 'sidebar', 'terminal', 'editor', 'changes', 'review', 'services', 'json-tree'…). */
  id: string;
  /** How the card names the panel: "Something went wrong in <panel>". */
  panel: string;
  /** The card shows only while its panel would (a hidden tab's boundary renders nothing). */
  visible?: boolean;
  /** The whole window: the card fills it. */
  root?: boolean;
  /** The panel's own frame class ('sidebar', 'changes'): the card keeps its place and width in the layout. */
  frame?: string;
  /** The card's text in place of the window-wide one (a pane inside the editor: what still works around it). */
  body?: string;
  /** Nothing in its place (a crumb in a bar): the error is still logged. */
  quiet?: boolean;
  /** Told once its children are gone (their owner drops the handles they gave it). */
  onCatch?: () => void;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: RendererError | null }> {
  state: { error: RendererError | null } = { error: null };

  static getDerivedStateFromError(err: unknown): { error: RendererError } {
    return { error: rendererError('boundary', err) };
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    const e = rendererError('boundary', err, this.props.panel, info.componentStack ?? undefined);
    this.setState({ error: e });
    reportError(e);
    this.props.onCatch?.();
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return <><FaultProbe id={this.props.id} />{this.props.children}</>;
    if (this.props.visible === false || this.props.quiet) return null;
    const card = <CrashCard error={error} panel={this.props.panel} root={!!this.props.root} body={this.props.body} />;
    return this.props.frame ? <aside className={this.props.frame}>{card}</aside> : card;
  }
}

function CrashCard({ error, panel, root, body }: { error: RendererError; panel: string; root: boolean; body?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const version = await window.atelier.appInfo().then((i) => i?.version ?? null, () => null);
    const ok = await window.atelier.clipboard.write(crashDetails(error, version)).catch(() => false);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className={`crash ${root ? 'is-root' : ''}`} role="alert" aria-label={t.crash.title(panel)}>
      <div className="crash-card pop">
        <span className="crash-icon"><Icon name="info" size={18} /></span>
        <h2>{t.crash.title(panel)}</h2>
        <p>{body ?? t.crash.body}</p>
        <code className="crash-msg">{error.message}</code>
        <div className="crash-actions">
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>{t.crash.reload}</button>
          <button type="button" className="btn-ghost" onClick={() => void copy()}>
            {copied ? <><Icon name="check" size={13} />{t.crash.copied}</> : t.crash.copy}
          </button>
        </div>
      </div>
    </div>
  );
}
