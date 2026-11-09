// Docker tabs: one per target — the engine overview, a compose project's stack or a
// container — keyed `dk:overview`, `dk:s:<project>` (URI-encoded) or `dk:c:<id>`.
import { isDockerTabKey } from '@shared/view-keys';
import type { DockerTarget } from '../store';
import type { TabKey } from '../tabs-model';

export function dockerKey(target: DockerTarget): TabKey {
  if (target.kind === 'overview') return 'dk:overview';
  return target.kind === 'stack' ? `dk:s:${encodeURIComponent(target.project)}` : `dk:c:${target.id}`;
}

/** The target a key names; null for anything that isn't a well-formed Docker tab key. */
export function parseDockerKey(k: string): DockerTarget | null {
  if (!isDockerTabKey(k)) return null;
  if (k === 'dk:overview') return { kind: 'overview' };
  if (k.startsWith('dk:c:')) return { kind: 'container', id: k.slice(5) };
  try {
    return { kind: 'stack', project: decodeURIComponent(k.slice(5)) };
  } catch {
    return null;
  }
}
