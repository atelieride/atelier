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

/** The footer pill: "iPhone" for one phone, "2 iPhones" for more, and its tooltip naming them as they name themselves. */
export function pillView(devices: RemoteDeviceInfo[]): { label: string; tip: string } | null {
  if (devices.length === 0) return null;
  return { label: t.iphone.pill(devices.length), tip: t.iphone.pillTip(devices.map((d) => d.name.trim() || 'iPhone')) };
}
