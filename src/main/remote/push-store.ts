// The phones that asked to be woken with notifications: each paired device's push token, its environment and the key
// its notifications are sealed with. Kept encrypted through the secret store (safeStorage, Keychain-backed), like this
// computer's own identity, never plaintext on disk; forgotten when a phone unregisters or is removed, when the relay
// says its token is dead, and at a reset.
import { z } from 'zod';
import type { SecretStore } from '../connectors/secret-store';

/** The secret store's entry (ATELIER_HOME/connectors/remote-push.bin). */
export const PUSH_SECRET_ID = 'remote-push';

export type PushEnv = 'sandbox' | 'production';
export interface PushRegistration { token: string; env: PushEnv; key: Buffer }
export interface DevicePush extends PushRegistration { device: string }

const fileSchema = z.object({
  v: z.literal(1),
  devices: z.array(z.object({ device: z.string().min(1).max(64), token: z.string().regex(/^[0-9a-fA-F]{64,200}$/), env: z.enum(['sandbox', 'production']), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()).max(64)
}).strict();

export class PushStore {
  private cache: DevicePush[] | null = null;

  constructor(private readonly secrets: Pick<SecretStore, 'read' | 'write' | 'remove'>) {}

  list(): DevicePush[] {
    if (!this.cache) {
      let text: string | null = null;
      try { text = this.secrets.read(PUSH_SECRET_ID); } catch { /* unreadable: none until the phones register again */ }
      let parsed: DevicePush[] = [];
      try {
        const r = text ? fileSchema.safeParse(JSON.parse(text)) : null;
        if (r?.success) parsed = r.data.devices.map((d) => ({ device: d.device, token: d.token, env: d.env, key: Buffer.from(d.key, 'base64url') }));
      } catch { /* not JSON: likewise */ }
      this.cache = parsed;
    }
    return this.cache.map((d) => ({ ...d }));
  }

  /** A device's registration, replacing its earlier one; null unregisters it. */
  set(device: string, reg: PushRegistration | null): void {
    const others = this.list().filter((d) => d.device !== device);
    this.save(reg ? [...others, { device, ...reg }] : others);
  }

  forgetDevice(device: string): void {
    if (this.list().some((d) => d.device === device)) this.set(device, null);
  }

  /** The relay said this token is dead: whoever registered it is forgotten. */
  forgetToken(token: string): boolean {
    const list = this.list();
    const kept = list.filter((d) => d.token !== token);
    if (kept.length === list.length) return false;
    this.save(kept);
    return true;
  }

  clear(): void {
    this.cache = [];
    this.secrets.remove(PUSH_SECRET_ID);
  }

  private save(list: DevicePush[]): void {
    this.cache = list.map((d) => ({ ...d }));
    if (list.length === 0) { this.secrets.remove(PUSH_SECRET_ID); return; }
    this.secrets.write(PUSH_SECRET_ID, JSON.stringify({ v: 1, devices: list.map((d) => ({ device: d.device, token: d.token, env: d.env, key: d.key.toString('base64url') })) }));
  }
}
