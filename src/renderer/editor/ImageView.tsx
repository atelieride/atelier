import { useEffect, useState, type CSSProperties } from 'react';
import type { ImageContent } from '@shared/files';
import { FileIcon } from '../components/FileIcon';
import { t } from '../i18n/en';
import { useApp, type OpenFile } from '../store';
import { sizeLabel } from '../scm/detail';
import { radioNext } from '../radio';
import { crumbDirs, isExternal } from '../external';

/**
 * An image file's tab (screenshots, assets): the picture on a checkerboard, fitted to the tab or at its actual size.
 * Re-read when the file changes on disk, like a text file.
 */
export function ImageView({ file, visible, place }: { file: OpenFile; visible: boolean; place?: CSSProperties }) {
  const [content, setContent] = useState<ImageContent | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [actual, setActual] = useState(false);
  const diskNonce = useApp((s) => s.diskNonce[file.path] ?? 0);
  const realRoot = useApp((s) => s.project?.realRoot ?? null);
  const claudeTemp = useApp((s) => !!s.claudeTemp[file.path]);

  useEffect(() => {
    let alive = true;
    void window.atelier.files.readImage(file.path)
      .then((c) => {
        if (!alive) return;
        if (c.kind === 'missing') useApp.getState().forgetRecent(file.path);
        useApp.getState().setClaudeTemp(file.path, !!c.claudeTemp);
        setBroken(false);
        setContent(c);
      })
      .catch(() => { if (alive) setContent({ kind: 'unreadable', path: file.path, rel: file.rel }); });
    return () => { alive = false; };
  }, [file.path, file.rel, file.nonce, diskNonce]);

  const name = file.rel.split('/').at(-1) ?? file.rel;
  const external = isExternal(file.path, realRoot);
  const image = content?.kind === 'image' && !broken ? content : null;
  const state = !content ? null : broken ? t.image.broken : content.kind === 'image' ? null : t.image.state[content.kind];
  return (
    <section className="file-view image-view" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={file.rel}>
      <div className="file-bar">
        <FileIcon name={name} size={14} />
        <span className="mono crumb">{crumbDirs(file.rel).map((p) => `${p} › `).join('')}<b>{name}</b></span>
        {external && (claudeTemp
          ? <span className="file-note is-outside" data-tip={t.claudeTemp.tip(file.path)}>{t.claudeTemp.chip}</span>
          : <span className="file-note is-outside" data-tip={t.openAny.outsideTip}>{t.openAny.outside}</span>)}
        <span className="grow" />
        {image && (
          // A radio group: one Tab stop (the chosen option), arrows move and choose.
          <span className="seg" role="radiogroup" aria-label={t.image.zoom} onKeyDown={(e) => {
            const next = radioNext([false, true], actual, e.key);
            if (next === null) return;
            e.preventDefault();
            setActual(next);
            (e.currentTarget.children[next ? 1 : 0] as HTMLElement | undefined)?.focus();
          }}>
            {[false, true].map((on) => (
              <button key={String(on)} type="button" role="radio" aria-checked={actual === on} tabIndex={actual === on ? 0 : -1}
                className={actual === on ? 'is-on' : ''} onClick={() => setActual(on)}>{on ? t.image.actual : t.image.fit}</button>
            ))}
          </span>
        )}
      </div>
      {image && (
        <div className={`image-stage${actual ? ' is-actual' : ''}`}>
          <img src={`data:${image.mime};base64,${image.data}`} alt={name} draggable={false}
            data-tip={actual ? t.image.toFit : t.image.toActual} onClick={() => setActual(!actual)}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setBroken(true)} />
        </div>
      )}
      {state && <div className="file-empty">{state}</div>}
      <div className="file-foot">
        {image ? <span className="mono">{dims ? `${dims.w} × ${dims.h} px · ` : ''}{sizeLabel(image.size)}</span> : <span>{t.readOnly}</span>}
        <span className="grow" />
        {image && <span>{image.mime.replace('image/', '').replace('x-icon', 'ico').toUpperCase()}</span>}
      </div>
    </section>
  );
}
