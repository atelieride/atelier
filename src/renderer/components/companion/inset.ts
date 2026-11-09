import type { CSSProperties } from 'react';
import { ASK_WIDTH, TERM_MIN } from '../../companion/model';

/**
 * A pane whose Ask is docked: its cell (or the workspace body, with one pane) carries the
 * panel's width and the least pane width it docks in, and what sits in it gives the panel that room — the terminal's
 * slot (xterm refits, never remounted), the waiting glow, the dictation pill, a scheduled prompt's countdown, the paste
 * notice. layout.css turns them into --ask-room: the width when the cell is wide enough (dockMode's rule), else none.
 */
export const ASK_INSET = { '--ask-inset': `${ASK_WIDTH}px`, '--ask-min': `${ASK_WIDTH + TERM_MIN}px` } as CSSProperties;
