import { wsColorVar } from '../workspace-view';

/** A workspace's glyph: two stacked panes in its color, the brand mark's shape. */
export function WorkspaceGlyph({ color, size = 16 }: { color: number; size?: number }) {
  const c = wsColorVar(color);
  return (
    <svg className="ws-glyph" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" style={{ color: c }}>
      <rect x="6" y="2.5" width="11" height="9.5" rx="2.4" fill="color-mix(in srgb, currentColor 14%, transparent)" stroke="currentColor" strokeWidth="1.3" />
      <rect x="3" y="7" width="11" height="9.5" rx="2.4" fill="color-mix(in srgb, currentColor 34%, transparent)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
