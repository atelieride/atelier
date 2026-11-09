// What every namespace of the demo bridge shares: the world (on the visitor's clock), the live state the engine
// changes, the event emitter and the clock.
import type { Attribution } from '@shared/attribution';
import type { TerminalInfo } from '@shared/protocol';
import type { Settings } from '@shared/settings';
import type { Clock } from '../engine/clock';
import type { Worktree } from '../engine/worktree';
import type { DemoWorld } from '../types';
import type { Emitter } from './events';

export interface DemoState {
  terminals: TerminalInfo[];
  /** The working tree (rel → text). Changed only through `worktree.write`. */
  files: Record<string, string>;
  /**
   * The fictional index: what the visitor staged, rel → the text staged (null: a deletion). Only
   * the Changes panel's stage and unstage change it; a commit never empties it (the demo never commits).
   */
  index: Record<string, string | null>;
  /** Who edited which path (one entry per path), as atelierd reports it. */
  attributions: Attribution[];
  settings: Settings;
  /** The demo's own clipboard: reads never ask the browser (no permission prompt). */
  clipboard: string | null;
  /** Each terminal's last size, as the renderer resized it: the Claude screen is drawn for it. */
  sizes: Map<string, { cols: number; rows: number }>;
  /** Terminals some window attached: their redraws go out as data. */
  attached: Set<string>;
  /**
   * Folders the tree shows beyond those holding files (rel): created empty, or left empty by a rename or a trash. The
   * tree is otherwise derived from `files`.
   */
  dirs: Set<string>;
  /**
   * The prompts the visitor sent each terminal's Claude (terminal id → in order, as its title would read them), each
   * with how its turn ended once it has: Ask reads "your requests" from them. The
   * scripted sessions' own prompts are the world's.
   */
  prompts: Map<string, VisitorPrompt[]>;
  /**
   * How each session's scripted turn ended (terminal id → finished, or interrupted with Esc) and what its terminal had
   * printed by then, styles dropped: Ask's phases read how far it really got.
   */
  scripted: Map<string, { interrupted: boolean; output: string }>;
  /** Terminals whose conversation `/clear` started over: Ask has nothing from before it. */
  cleared: Set<string>;
}

export interface VisitorPrompt { text: string; at: number; outcome?: 'finished' | 'interrupted' }

export interface DemoContext {
  world: DemoWorld;
  state: DemoState;
  events: Emitter;
  now(): number;
  /** The engine's scheduler: paused with the page (engine/clock.ts). */
  clock: Clock;
  /** Every change to the working tree goes through it (engine/worktree.ts). */
  worktree: Worktree;
  /** The app version the demo shows (package.json at build time). */
  version: string;
}

/** A path of the project relative to its root, or null outside it. */
export function relOf(root: string, path: string): string | null {
  if (path === root) return '';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** Resolves only, never fails: an inert answer the way an IPC reply comes (after the caller's await). */
export const resolved = <T>(v: T): Promise<T> => Promise.resolve(v);
export const noop = (): Promise<void> => Promise.resolve();
