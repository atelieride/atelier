// tabs.* in the demo: the window opens on the overview shot's tabs, the waiting session
// in front; saving is a no-op (each visit starts fresh).
import type { AtelierApi } from '@shared/api';
import { noop, resolved, type DemoContext } from './context';

export function createTabs(ctx: DemoContext): AtelierApi['tabs'] {
  let restored = false;
  return {
    save: () => noop(),
    // Once, as main hands a window its saved tabs once.
    restore() {
      if (restored) return resolved(null);
      restored = true;
      return resolved({ files: [], order: ctx.world.tabs.order, active: ctx.world.tabs.active });
    }
  };
}
