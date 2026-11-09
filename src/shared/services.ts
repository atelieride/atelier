export type ServicesStatus = 'ok' | 'no-server' | 'no-tmux';

export interface ServicePane {
  /** tmux pane id (%N). */
  id: string;
  session: string;
  window: number;
  index: number;
  /** Pane title if set, otherwise the folder name. */
  name: string;
  /** Foreground process in the pane. */
  command: string;
  cwd: string;
  /** false if the shell is back in the pane (service stopped or crashed). */
  running: boolean;
  errors: number;
  port: number | null;
  /** The capture fails (lines too long, tmux error): the log does not update. */
  stale: boolean;
}
