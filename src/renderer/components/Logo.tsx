import { memo, useMemo } from 'react';
import { markSvg } from '../brand';

/** Atelier mark (static, from the brand file). */
export const Logo = memo(function Logo({ size = 20, className = '' }: { size?: number; className?: string }) {
  const html = useMemo(() => markSvg(size), [size]);
  return <span className={`logo ${className}`.trim()} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
});
