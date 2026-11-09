// The daemon client's errors for a request it never wrote to atelierd (main/daemon-client.ts): no connection, or an
// incompatible atelierd. Any other failure may come after atelierd got the request.

export const NOT_CONNECTED = 'atelierd not connected';
export const INCOMPATIBLE = 'atelierd incompatible';

/** True when atelierd never got the request: safe to send again. Matches the message through IPC's wrapping too. */
export function neverSent(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(NOT_CONNECTED) || msg.includes(INCOMPATIBLE);
}
