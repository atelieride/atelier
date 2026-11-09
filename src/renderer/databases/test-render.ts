// For markup tests only (renderToStaticMarkup, no DOM): renders with the stores' live state. A server render reads
// useSyncExternalStore's server snapshot, which zustand takes from each store's initial state; for this one render it
// reads the live snapshot instead, and every store's initial state is left as it was.
import React, { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/** An element, or a component rendered without props. */
export function renderLive(el: ReactElement | (() => ReactElement | null)): string {
  const spy = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
  try {
    return renderToStaticMarkup(typeof el === 'function' ? createElement(el) : el);
  } finally {
    spy.mockRestore();
  }
}
