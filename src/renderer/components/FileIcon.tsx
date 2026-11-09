import { memo } from 'react';
import { iconFor } from '../icons/seti';

/**
 * File icon (Seti): a <use> pointing to the sprite inserted at startup. Its color is a theme token, set as
 * a style (presentation attributes like fill take no var()).
 */
export const FileIcon = memo(function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const { id, color } = iconFor(name);
  return (
    <svg className="file-icon" width={size} height={size} style={{ fill: color }} aria-hidden="true">
      <use href={`#seti-${id}`} />
    </svg>
  );
});
