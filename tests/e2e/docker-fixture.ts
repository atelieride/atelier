// The fictional compose project for the Docker view's e2e and screenshots. The containers, logs
// and compose file live in the demo's world (src/demo/world/docker.ts); this writes the
// project's files and stages the containers on the fake engine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeDocker } from '../support/fake-docker';
import { COMPOSE, SESSION_TS_LINE_42, dockerContainers } from '../../src/demo/world/docker';

/** Writes the project's compose file and a source file the api's stack trace points at. */
export function writeProject(root: string): void {
  writeFileSync(join(root, 'compose.yml'), COMPOSE);
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  writeFileSync(join(root, 'src', 'auth', 'session.ts'), Array.from({ length: 60 }, (_, i) => (i === 41 ? SESSION_TS_LINE_42 : `// line ${i + 1}`)).join('\n'));
}

/**
 * Stages the whole scenario; returns the ids by name. `healthy`: the worker runs instead of crashing (the website's
 * hero shows the whale without a failure dot).
 */
export function stageDocker(fake: FakeDocker, root: string, now = Date.now(), opts: { healthy?: boolean } = {}): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const c of dockerContainers(root, now, opts)) ids[c.key] = fake.add(c.spec, c.logs);
  return ids;
}
