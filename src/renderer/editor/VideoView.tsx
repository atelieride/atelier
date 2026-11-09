import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { VideoContent } from '@shared/files';
import { FileIcon } from '../components/FileIcon';
import { t } from '../i18n/en';
import { useApp, type OpenFile } from '../store';
import { sizeLabel } from '../scm/detail';
import { crumbDirs, isExternal } from '../external';

/** A duration as a player shows it: 0:42, 12:05, 1:02:03; null when the file doesn't say (a live WebM). */
function clock(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/**
 * A video file's tab: the player on a dark stage, fitted, no autoplay; streamed by
 * main through an atelier-media: token, so seeking reads only what it needs. Paused when its tab is hidden;
 * a change on disk opens it again (a new token) from the start. A format Chromium can't play says so, with Reveal.
 */
export function VideoView({ file, visible, place }: { file: OpenFile; visible: boolean; place?: CSSProperties }) {
  const [content, setContent] = useState<VideoContent | null>(null);
  const [meta, setMeta] = useState<{ w: number; h: number; duration: string | null } | null>(null);
  const [broken, setBroken] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const diskNonce = useApp((s) => s.diskNonce[file.path] ?? 0);
  const realRoot = useApp((s) => s.project?.realRoot ?? null);
  // A failed load asks for a new token once before saying the format can't be played: a token main dropped (64 per
  // window, the oldest goes) fails like a bad file. Once per file version.
  const [again, setAgain] = useState(0);
  const retried = useRef(false);
  useEffect(() => { retried.current = false; }, [file.path, file.nonce, diskNonce]);

  useEffect(() => {
    let alive = true;
    void window.atelier.files.openVideo(file.path)
      .then((c) => {
        if (!alive) return;
        if (c.kind === 'missing') useApp.getState().forgetRecent(file.path);
        setBroken(false);
        setMeta(null);
        setContent(c);
      })
      .catch(() => { if (alive) setContent({ kind: 'unreadable', path: file.path, rel: file.rel }); });
    return () => { alive = false; };
  }, [file.path, file.rel, file.nonce, diskNonce, again]);

  // Another tab in front, a pane closed: it stops (nothing plays where no one sees it).
  useEffect(() => { if (!visible) video.current?.pause(); }, [visible]);

  const name = file.rel.split('/').at(-1) ?? file.rel;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '';
  const external = isExternal(file.path, realRoot);
  const playable = content?.kind === 'video' && !broken ? content : null;
  const state = !content || playable ? null : content.kind === 'video' ? t.video.cantPlay : t.image.state[content.kind];
  return (
    <section className="file-view video-view" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={file.rel}>
      <div className="file-bar">
        <FileIcon name={name} size={14} />
        <span className="mono crumb">{crumbDirs(file.rel).map((p) => `${p} › `).join('')}<b>{name}</b></span>
        {external && <span className="file-note is-outside" data-tip={t.openAny.outsideTip}>{t.openAny.outside}</span>}
        <span className="grow" />
      </div>
      {playable && (
        <div className="video-stage">
          <video key={playable.url} ref={video} src={playable.url} controls preload="metadata" aria-label={name}
            onLoadedMetadata={(e) => setMeta({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight, duration: clock(e.currentTarget.duration) })}
            onError={() => { if (retried.current) setBroken(true); else { retried.current = true; setAgain((n) => n + 1); } }} />
        </div>
      )}
      {state && (
        <div className="file-empty file-large">
          <span>{state}</span>
          {broken && <button type="button" className="btn-ghost sm" onClick={() => void window.atelier.reveal(file.path)}>{t.menu.revealInFinder}</button>}
        </div>
      )}
      <div className="file-foot">
        {content?.kind === 'video'
          ? <span className="mono">{meta && !broken ? `${meta.w} × ${meta.h} · ${meta.duration ? `${meta.duration} · ` : ''}` : ''}{sizeLabel(content.size)}</span>
          : <span>{t.readOnly}</span>}
        <span className="grow" />
        {content?.kind === 'video' && <span>{ext}</span>}
      </div>
    </section>
  );
}
