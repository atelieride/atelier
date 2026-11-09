/** A tiny line of the last samples (CPU, memory, network): no axes, scaled to its own peak (with a floor). */
export function Sparkline({ values, width, height, floor = 1, tone = 'violet', label }: { values: readonly number[]; width: number; height: number; floor?: number; tone?: 'violet' | 'pink' | 'sky' | 'done' | 'error' | 'dim'; label?: string }) {
  const pad = 1.5;
  // Headroom above the peak: a steady value sits at three quarters, not glued to the top.
  const max = Math.max(floor, ...values) * 1.3;
  const pts = values.length < 2 ? '' : values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - 2 * pad);
    const y = height - pad - (Math.max(0, v) / max) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className={`dk-spark tone-${tone}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {pts ? <polyline points={pts} /> : <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} className="is-flat" />}
    </svg>
  );
}
