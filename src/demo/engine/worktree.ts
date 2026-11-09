// The one way the demo changes its working tree: the editor's saves and Claude's
// edits both come through here, so the renderer hears about every change the way main tells it — the paths that
// changed (fsChanged), then the repository's new status (git), then who edited what (attributions).
import type { Attribution } from '@shared/attribution';
import type { DemoContext } from '../bridge/context';
import { statusOf } from '../bridge/git';

export interface Worktree {
  /** Writes `text` at `rel` (null deletes it). An attribution records the session that made the edit. */
  write(rel: string, text: string | null, by?: Attribution): void;
}

export function createWorktree(ctx: Omit<DemoContext, 'worktree'>): Worktree {
  const { root } = ctx.world.project;
  return {
    write(rel, text, by) {
      const files = ctx.state.files;
      if (text === null) delete files[rel]; else files[rel] = text;
      ctx.events.emit('fsChanged', [`${root}/${rel}`]);
      ctx.events.emit('git', [statusOf(ctx as DemoContext)]);
      if (by) {
        // atelierd keeps the last session that edited a path: one entry per path.
        ctx.state.attributions = [...ctx.state.attributions.filter((a) => a.path !== by.path), by];
        ctx.events.emit('attributions', ctx.state.attributions);
      }
    }
  };
}
