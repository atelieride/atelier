import { useState } from 'react';

type At = { screenX: number; screenY: number };

/**
 * Hover that follows the pointer, not the list (palette and pickers): the arrow keys scroll a list under a resting
 * pointer, and Chromium then sends mouse events at the same spot, which must not select the item now there. Only a
 * pointer that really moved selects; the first event (the list opened under the pointer) only says where it rests.
 */
export function pointerGate(): (e: At) => boolean {
  let last: { x: number; y: number } | null = null;
  return (e) => {
    const was = last;
    last = { x: e.screenX, y: e.screenY };
    return was !== null && (was.x !== e.screenX || was.y !== e.screenY);
  };
}

/** One gate per mounted list: `onMouseMove={(e) => { if (moved(e)) setActive(i); }}`. */
export function usePointerGate(): (e: At) => boolean {
  return useState(pointerGate)[0];
}
