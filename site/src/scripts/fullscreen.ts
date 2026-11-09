// Full screen for a video, shared by the page's first script (a phone's film: film.ts) and the hero's player
// (a tablet's button: film-inline.ts). Tiny, and imports nothing.

export type WebKitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Whether the page may put this video full screen with the standard API (not on an iPhone: iPads and others can). */
export const standardFullscreen = (video: HTMLVideoElement): boolean => document.fullscreenEnabled && !!video.requestFullscreen;

/** The video full screen: the standard API where the page may use it, else iOS's own player. Call it inside the
 *  visitor's tap: iOS allows it nowhere else; and iOS refuses a video that has no metadata yet (it throws). */
export function enterFullscreen(video: WebKitVideo): Promise<boolean> {
  if (standardFullscreen(video)) return video.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false);
  try {
    if (video.webkitEnterFullscreen && video.readyState >= 1) { video.webkitEnterFullscreen(); return Promise.resolve(true); }
  } catch { /* iOS refused it */ }
  return Promise.resolve(false);
}

/** Calls `left` when this video leaves full screen, by either API. */
export function onLeaveFullscreen(video: HTMLVideoElement, left: () => void): void {
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement !== video) left(); });
  video.addEventListener('webkitendfullscreen', left);
}
