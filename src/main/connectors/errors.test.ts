import { expect, test } from 'vitest';
import {
  Aborted, AuthFailed, Forbidden, HostNotAllowed, InvalidArguments, NotAllowed, RateLimited, SchemaChanged, SecretUnavailable, SecretUnreadable,
  TooLarge, ToolError, Unauthorized, Unreachable, type AuthFailureReason
} from './errors';

// The core's errors are shared by every connector and only reach the logs: their messages never
// name one connector, so a Notion log line never says "ClickUp".
test('no core error message names a connector', () => {
  const reasons: AuthFailureReason[] = ['unsupported', 'denied', 'oauth-error', 'verify', 'port', 'network', 'signed-out'];
  // Neutral arguments: a tool name or a connector id passed in is the caller's to name.
  const errors: Error[] = [
    new NotAllowed(), new InvalidArguments('some_tool'), new HostNotAllowed('https://x.example'), new Unauthorized(), new Forbidden(),
    new RateLimited(0), new Unreachable('network'), new Unreachable('timeout'), new Unreachable('server', 502), new SchemaChanged('x'),
    new TooLarge(4), new ToolError('some_tool', 'gone'), new Aborted(), new SecretUnavailable(), new SecretUnreadable('x'),
    ...reasons.map((r) => new AuthFailed(r))
  ];
  for (const e of errors) {
    expect(e.message).not.toMatch(/clickup|notion/i);
    expect(e.message.length).toBeGreaterThan(0);
  }
});
