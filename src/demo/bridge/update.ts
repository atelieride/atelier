// update.* in the demo: no updater in a browser; About shows the version only.
import type { AtelierApi } from '@shared/api';
import type { UpdateStatus } from '@shared/update-feed';
import { notInDemo } from './not-in-demo';
import { noop, resolved, type DemoContext } from './context';

export function createUpdate(ctx: DemoContext): AtelierApi['update'] {
  const status = (): UpdateStatus => ({ available: false, buildChannel: null, channel: null, version: ctx.version, lastCheck: null, phase: { kind: 'idle' }, currentNotes: null });
  return {
    state: () => resolved(false),
    apply: () => resolved(false),
    status: () => resolved(status()),
    check: () => resolved(status()),
    whatsNew: () => resolved(null),
    openRelease: () => { notInDemo('Updates'); return noop(); },
    openApplications: () => { notInDemo('Updates'); return noop(); },
    openStore: () => { notInDemo('Updates'); return noop(); }
  };
}
