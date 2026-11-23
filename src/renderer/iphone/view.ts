// iPhone access as the first paint shows it: the phones connected now, the terminals they have open, the footer pill's
// words. Settings › iPhone and the pairing sheet add theirs, the phones' models among them (sheet-view.ts). Pure.
import type { RemoteDeviceInfo, RemoteStatus } from '@shared/remote';
import { t } from '../i18n/en';

/** The phones connected now. */
export function connectedDevices(s: RemoteStatus | null): RemoteDeviceInfo[] {
  return s?.enabled ? s.devices.filter((d) => d.connected) : [];
}

/** The terminals a connected phone has open. */
export function phoneTerminals(s: RemoteStatus | null): string[] {
  return [...new Set(connectedDevices(s).flatMap((d) => d.attached))];
}

/**
 * The footer pill: "iPhone" for one phone, "2 iPhones" for more; its tooltip naming them as Settings › iPhone does
 * (`title`), and the name a screen reader hears, starting with what the pill shows.
 */
export function pillView(devices: RemoteDeviceInfo[], title: (d: RemoteDeviceInfo) => string): { label: string; tip: string; name: string } | null {
  if (devices.length === 0) return null;
  const label = t.iphone.pill(devices.length);
  const names = devices.map(title);
  return { label, tip: t.iphone.pillTip(names), name: t.iphone.pillName(label, names) };
}
