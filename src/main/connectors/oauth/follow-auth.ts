// Tests only (ATELIER_TEST_FOLLOW_AUTH=1, a devEnv variable: inert in the packaged app): instead of opening the user's
// browser, main GETs the authorize URL itself through the connector transport (the fake ClickUp auto-approves and
// answers 302 to the loopback callback) and hands that callback to the listener in-process, through the same checks as
// an HTTP request (loopback.ts `deliver`). No request leaves for anything but the allowed origin: the callback is never
// fetched over the network (the transport's allowlist would refuse the loopback port anyway).
import type { Transport } from '../http';
import type { AuthOpener } from './oauth';

const FOLLOW_TIMEOUT_MS = 20_000;

export function followAuthorize(transport: Transport, allow: (u: URL) => boolean): AuthOpener {
  return (url, deliver) => {
    void (async () => {
      const u = new URL(url);
      if (!allow(u)) return;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FOLLOW_TIMEOUT_MS);
      try {
        const res = await transport({ method: 'GET', url: u.href, headers: { accept: 'text/html' } }, ctl.signal);
        res.close();
        if (res.location) deliver(new URL(res.location, u).href);
      } finally {
        clearTimeout(timer);
      }
    })().catch(() => undefined);
  };
}
