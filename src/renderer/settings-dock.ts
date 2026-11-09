/**
 * Settings › Terminal and Editor keep their preview docked at the top of the pane while the rows scroll under it
 *, but only while it leaves at least half of the pane to the
 * controls: a 24 px preview with word wrap in a window at its minimum height scrolls away like any other row.
 */
export function previewDocks(band: number, pane: number): boolean {
  return pane > 0 && band <= pane / 2;
}

/**
 * Room kept between the docked band and a control the keyboard scrolls into view right below it: Chromium aligns a
 * half-hidden control to the nearest edge, and its focus ring (3.5 px, theme.css) would end up under the band.
 */
export const FOCUS_ROOM = 6;
