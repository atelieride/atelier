// What a window does for paired phones while iPhone access is on: the sidebar's arrangement sent to main
// (layout-sync.ts), the phones' changes to the workspaces and activities (phone-places.ts) and to the rows
// (phone-rows.ts). One chunk, fetched once access is on (store.ts): nobody without iPhone access, the live demo
// included, pays for it in the first paint.
import type { RemoteRowsEvent } from '@shared/remote';
import { installLayoutSync } from './layout-sync';
import { installPhonePlaces } from './phone-places';
import { phoneRows } from './phone-rows';

/** Installs them all: `rows` takes each rows event main sends; `off` uninstalls. */
export function installAccessOn(): { rows(e: RemoteRowsEvent): void; off(): void } {
  const offLayout = installLayoutSync();
  const offPlaces = installPhonePlaces();
  const rows = phoneRows();
  return { rows: rows.handle, off: () => { offLayout(); offPlaces(); rows.off(); } };
}
