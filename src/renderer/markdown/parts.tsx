// The Markdown preview's own elements: links that say where they go, local images through
// main, code blocks colored by the editor's highlighter, GitHub alerts, task boxes, headings with anchors.
import { createContext, useContext, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import type { Element } from 'hast';
import { Icon, type IconName } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { copyText } from '../clipboard';
import { cancelHighlight, highlight } from '../editor/highlighter';
import { imageCache } from './image-cache';
import type { TokenSpans } from '../editor/tokens';
import { classifyHref, imagePath, linkCandidate } from './links';
import { fenceLanguage } from './text';
import { textOf } from './render';

export interface PreviewCtx {
  path: string;
  root: string;
  /** Bumped when the file is reopened or changes on disk: images load again. */
  nonce: number;
  scrollToAnchor: (id: string) => void;
}
export const Ctx = createContext<PreviewCtx>({ path: '', root: '/', nonce: 0, scrollToAnchor: () => {} });

type WithNode<T> = T & { node?: Element };

// Resolved file links, briefly cached (the preview re-renders while typing): candidate → project file or null.
const resolved = new Map<string, { at: number; value: Promise<{ path: string; rel: string } | null> }>();
function resolveLink(candidate: string, cwd: string): Promise<{ path: string; rel: string } | null> {
  const key = `${cwd}\n${candidate}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.value;
  const value = window.atelier.files.resolve(candidate, cwd).catch(() => null);
  resolved.set(key, { at: Date.now(), value });
  if (resolved.size > 500) resolved.delete(resolved.keys().next().value!);
  return value;
}

export function MdLink({ href, children, node: _node, ...rest }: WithNode<ComponentProps<'a'>>) {
  const ctx = useContext(Ctx);
  const kind = classifyHref(href ?? '');
  const file = kind.kind === 'file' ? linkCandidate(kind.path, ctx.path, ctx.root) : null;
  const [target, setTarget] = useState<{ path: string; rel: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!file) return;
    let alive = true;
    void resolveLink(file.candidate, file.cwd).then((r) => { if (alive) setTarget(r); });
    return () => { alive = false; };
  }, [file?.candidate, file?.cwd]);
  const tip = kind.kind === 'url' ? `${kind.url} · ${t.md.opensInBrowser}`
    : kind.kind === 'file' ? (target ? `${target.rel}${kind.line ? `:${kind.line}` : ''} · ${t.md.opensInTab}` : target === null ? `${kind.path} · ${t.md.notFound}` : kind.path)
      : kind.kind === 'inert' && href ? `${href} · ${t.md.inert}` : undefined;
  const broken = kind.kind === 'file' && target === null;
  const open = () => {
    if (kind.kind === 'anchor') ctx.scrollToAnchor(kind.id);
    else if (kind.kind === 'url') void window.atelier.openUrl(kind.url);
    else if (kind.kind === 'file' && target) useApp.getState().openFile(target.path, target.rel, kind.line, undefined, { preview: true });
  };
  return (
    <a {...rest} href={href} className={`md-link${broken ? ' is-broken' : ''}${kind.kind === 'inert' ? ' is-inert' : ''}`} data-tip={tip}
      onClick={(e) => { e.preventDefault(); open(); }}>
      {children}{kind.kind === 'url' && <span className="md-ext" aria-hidden="true" data-nofind="">↗</span>}
    </a>
  );
}

type Img = { kind: 'loading' } | { kind: 'ok'; src: string } | { kind: 'missing' | 'unreadable' };

export function MdImage({ src, alt, title, node: _node }: WithNode<ComponentProps<'img'>>) {
  const ctx = useContext(Ctx);
  const s = typeof src === 'string' ? src : '';
  const remote = /^https?:\/\//i.test(s);
  const local = remote ? null : imagePath(s, ctx.path, ctx.root);
  // A cached image shows at once and is read again quietly (it may have changed on disk): no flicker, no jump.
  const [img, setImg] = useState<Img>(() => { const hit = local ? imageCache.get(local) : undefined; return hit ? { kind: 'ok', src: hit } : { kind: 'loading' }; });
  useEffect(() => {
    if (!local) return;
    let alive = true;
    const hit = imageCache.get(local);
    setImg(hit ? { kind: 'ok', src: hit } : { kind: 'loading' });
    const load = async (): Promise<Img> => {
      // SVG is text for the file API; as an <img> data URL it can't run scripts.
      if (/\.svg$/i.test(local)) {
        const c = await window.atelier.files.read(local);
        return c.kind === 'text' ? { kind: 'ok', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.text)}` } : { kind: c.kind === 'missing' ? 'missing' : 'unreadable' };
      }
      const c = await window.atelier.files.readImage(local);
      return c.kind === 'image' ? { kind: 'ok', src: `data:${c.mime};base64,${c.data}` } : { kind: c.kind === 'missing' ? 'missing' : 'unreadable' };
    };
    void load().catch((): Img => ({ kind: 'unreadable' })).then((r) => {
      if (r.kind === 'ok') imageCache.set(local, r.src);
      if (alive) setImg((cur) => (cur.kind === 'ok' && r.kind === 'ok' && cur.src === r.src ? cur : r));
    });
    return () => { alive = false; };
  }, [local, ctx.nonce]);
  if (remote) {
    return (
      <span className="md-img-off is-remote" data-tip={s}>
        <Icon name="imageOff" size={15} />
        <span className="md-img-off-text"><span>{alt || t.md.remoteImage}</span><span className="mono md-img-off-url">{s}</span></span>
        <button type="button" className="md-img-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void window.atelier.openUrl(s); }}>{t.md.openInBrowser}</button>
      </span>
    );
  }
  if (!local || img.kind === 'missing' || img.kind === 'unreadable') {
    return (
      <span className="md-img-off" data-tip={s || undefined}>
        <Icon name="imageOff" size={15} />
        <span className="md-img-off-text"><span>{img.kind === 'unreadable' ? t.md.imageUnreadable : t.md.imageMissing}</span><span className="mono md-img-off-url">{s}</span></span>
      </span>
    );
  }
  if (img.kind !== 'ok') return <span className="md-img-loading" aria-label={alt ?? ''} />;
  return <img className="md-img" src={img.src} alt={alt ?? ''} title={title ?? alt ?? undefined} draggable={false} />;
}

// Highlighted code by language and text: typing elsewhere in the document doesn't color the blocks again.
const colored = new Map<string, TokenSpans>();
const COLORED_MAX = 400;
/** Past this many code blocks a document's blocks stay plain (the worker is shared with every editor). */
const MAX_COLORED_BLOCKS = 200;

function paint(text: string, spans: TokenSpans): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (let i = 0; i + 2 < spans.spans.length; i += 3) {
    const from = spans.spans[i]!; const to = spans.spans[i + 1]!; const color = spans.colors[spans.spans[i + 2]!];
    if (from > at) out.push(text.slice(at, from));
    out.push(<span key={i} style={{ color }}>{text.slice(from, to)}</span>);
    at = to;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function MdCode({ node, ...rest }: WithNode<ComponentProps<'pre'>>) {
  const ctx = useContext(Ctx);
  const index = Number((rest as Record<string, unknown>)['data-block'] ?? MAX_COLORED_BLOCKS);
  const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
  const cls = code?.properties.className;
  const info = Array.isArray(cls) ? String(cls.find((c) => String(c).startsWith('language-')) ?? '').slice(9) : '';
  const text = (code ? textOf(code) : '').replace(/\n$/, '');
  const lang = index < MAX_COLORED_BLOCKS ? fenceLanguage(info) : null;
  const key = lang ? `${lang}\u0000${text}` : '';
  // One request per block: a newer text replaces the older request, and a block that goes away cancels its own.
  const job = `md:${ctx.path}:${index}`;
  const [spans, setSpans] = useState<TokenSpans | null>(() => (key ? colored.get(key) ?? null : null));
  useEffect(() => {
    if (!lang) { setSpans(null); return; }
    const hit = colored.get(key);
    if (hit) { setSpans(hit); return; }
    setSpans(null);
    let alive = true;
    void highlight(text, lang, job).then((r) => {
      if (!alive || !r || r === 'dropped') return;
      colored.set(key, r);
      if (colored.size > COLORED_MAX) colored.delete(colored.keys().next().value!);
      setSpans(r);
    });
    return () => { alive = false; };
  }, [key]);
  useEffect(() => () => cancelHighlight(job), [job]);
  return (
    <div className="md-code" data-src={(rest as Record<string, unknown>)['data-src'] as string | undefined}>
      <div className="md-code-head" data-nofind="">
        <span className="mono md-code-lang">{info || 'text'}</span>
        <button type="button" className="md-copy" aria-label={t.md.copyCodeTip} data-tip={t.md.copyCodeTip}
          onClick={() => void copyText(text).then((ok) => { if (ok) useApp.getState().showToast(t.md.codeCopied, undefined, 'info'); })}>
          <Icon name="copy" size={13} />{t.md.copyCode}
        </button>
      </div>
      <pre className="mono"><code>{spans ? paint(text, spans) : text}</code></pre>
    </div>
  );
}

const ALERT_ICONS: Record<string, IconName> = { note: 'info', tip: 'sparkle', important: 'comment', warning: 'warning', caution: 'caution' };

export function MdDiv({ node: _node, children, ...rest }: WithNode<ComponentProps<'div'>>) {
  const kind = (rest as Record<string, unknown>)['data-alert'];
  if (typeof kind !== 'string' || !Object.hasOwn(ALERT_ICONS, kind)) return <div {...rest}>{children}</div>;
  return (
    <div {...rest} className={`md-alert is-${kind}`}>
      <div className="md-alert-title"><Icon name={ALERT_ICONS[kind]!} size={14} stroke={1.8} />{t.md.alerts[kind]}</div>
      {children}
    </div>
  );
}

export function MdInput({ node: _node, type, checked }: WithNode<ComponentProps<'input'>>) {
  if (type !== 'checkbox') return null;
  return (
    <span className={`md-check${checked ? ' is-on' : ''}`} role="img" aria-label={checked ? 'Done' : 'Open'}>
      {checked && <Icon name="check" size={11} stroke={2.6} />}
    </span>
  );
}

export function MdTable({ node: _node, ...rest }: WithNode<ComponentProps<'table'>>) {
  return <div className="md-table" data-src={(rest as Record<string, unknown>)['data-src'] as string | undefined}><table {...rest} /></div>;
}

export function heading(tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function MdHeading({ node: _node, children, ...rest }: WithNode<ComponentProps<'h1'>>) {
    const ctx = useContext(Ctx);
    const slug = (rest as Record<string, unknown>)['data-slug'];
    const Tag = tag;
    return (
      <Tag {...rest} className="md-h">
        {children}
        {typeof slug === 'string' && slug && (
          <a className="md-anchor" href={`#${slug}`} aria-hidden="true" tabIndex={-1} data-nofind=""
            onClick={(e) => { e.preventDefault(); ctx.scrollToAnchor(slug); }}>#</a>
        )}
      </Tag>
    );
  };
}
