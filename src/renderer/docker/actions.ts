// What the Docker view does: open a container, send its lines to Claude, ask about a
// crash, copy commands, open its compose file. Nothing here changes a container: commands are only copied.
import { serviceBlock, serviceLine, type DockerContainer } from '@shared/docker';
import { isRedisImage } from '@shared/redis';
import { useRedis } from '../redis/store';
import { portUrl } from '@shared/ports';
import type { MenuItem } from '../menu-model';
import { t } from '../i18n/en';
import { useApp, type DockerView } from '../store';
import { copyText } from '../clipboard';
import { newSessionIn } from '../launch';
import { pasteReason, typeWhenReadyAs } from '../task-session';
import { pasteSequence } from '../terminal/paste';
import { isBracketed } from '../terminal/focus';
import { sendInput } from '../terminal/drafts';
import { isShell } from '@shared/shells';
import { crashPrompt, hasProblem, logsPrompt } from './view';
import { useDocker } from './store';

export const containerOf = (id: string): DockerContainer | undefined => useDocker.getState().containers.find((c) => c.id === id);

/**
 * Shows a container in its Docker tab, in the Docker space (openDocker brings it forward); no
 * view: an open tab keeps its own, a new one the logs.
 */
export function openContainer(id: string, view?: DockerView): void {
  const st = useApp.getState();
  st.openDocker({ kind: 'container', id }, view);
  st.dockerSeen(id);
}

export function openStack(project: string): void {
  useApp.getState().openDocker({ kind: 'stack', project });
}

export function openOverview(): void {
  useApp.getState().openDocker({ kind: 'overview' });
}

/** The session lines go to: the selected session, else the first one. */
export function sendTarget(): { id: string; title: string; color: string } | null {
  const st = useApp.getState();
  const term = st.terminals.find((x) => x.id === st.selectedId && x.session) ?? st.terminals.find((x) => x.session);
  return term ? { id: term.id, title: term.title, color: term.color } : null;
}

/**
 * How long after a session's last report a shell in front is atelierd's foreground read (every 1 s) not having seen
 * Claude yet, rather than Claude gone: Send waits that long for Claude in front.
 */
export const FOREGROUND_LAG_MS = 2500;

/** Whether the terminal's shell in front may be a foreground read that lags a session that just started. */
function foregroundLags(id: string): boolean {
  const term = useApp.getState().terminals.find((x) => x.id === id);
  return !!term?.session && isShell(term.foreground) && Date.now() - term.session.updatedAt < FOREGROUND_LAG_MS;
}

/** Why the session can't take a paste, once it can or FOREGROUND_LAG_MS is over (null: it can). */
function sendableWithin(id: string, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (why: string | null) => { clearTimeout(timer); stop(); resolve(why); };
    const timer = setTimeout(() => done(pasteReason(id)), ms);
    const stop = useApp.subscribe(() => { if (!pasteReason(id)) done(null); });
  });
}

/** Typed into the session's prompt as one paste, without Enter, only while Claude waits for input (Send Review's rule). */
export async function sendToSession(text: string): Promise<void> {
  const st = useApp.getState();
  const target = sendTarget();
  if (!target) { st.showToast(t.docker.noSession, { label: t.docker.copy, run: () => void copyText(text) }); return; }
  let why = pasteReason(target.id);
  if (why && foregroundLags(target.id)) why = await sendableWithin(target.id, FOREGROUND_LAG_MS);
  if (why) { st.showToast(why, { label: t.docker.copy, run: () => void copyText(text) }); return; }
  for (const part of pasteSequence(text, isBracketed(target.id), 256 * 1024)) sendInput(target.id, part);
  st.setActivity('sessions', { keepHidden: true });
  st.select(target.id);
  st.setPastedAt(Date.now());
}

/**
 * A new session named `name`, the prompt typed in once Claude is ready (not sent), then `typed` in a toast — the
 * Docker, Redis and Databases views' Ask in a New Session.
 */
export async function askInSession(name: string, prompt: string, typed: string): Promise<void> {
  const info = await newSessionIn(name);
  if (info) typeWhenReadyAs(info.id, prompt, false, typed);
}

/** A new session named after the container, the prompt typed in once Claude is ready (not sent). */
export function askInNewSession(c: DockerContainer, prompt: string): Promise<void> {
  return askInSession(t.docker.sessionName(c.name), prompt, t.docker.typed(c.name));
}

export function sendLines(c: DockerContainer, lines: readonly string[]): void {
  void sendToSession(logsPrompt(c, lines));
}

export function askAboutLines(c: DockerContainer, lines: readonly string[]): void {
  void askInNewSession(c, logsPrompt(c, lines, true));
}

/** The compose file inside the project that defines this service, read through the files API (never outside). */
async function composeOf(c: DockerContainer): Promise<{ path: string; rel: string; text: string } | null> {
  if (!c.service) return null;
  for (const path of c.configFiles) {
    const f = await window.atelier.files.read(path).catch(() => null);
    if (f && f.kind === 'text' && serviceLine(f.text, c.service) !== null) return { path: f.path, rel: f.rel, text: f.text };
  }
  return null;
}

export async function askWhyCrashed(c: DockerContainer): Promise<void> {
  const [inspected, tail, compose] = await Promise.all([
    window.atelier.docker.inspect(c.id).catch(() => null),
    window.atelier.docker.tail(c.id, 50).catch(() => []),
    composeOf(c)
  ]);
  const container = inspected?.container ?? c;
  const detail = inspected?.detail ?? { env: [], restartPolicy: { name: c.restartPolicy, max: 0 }, error: '' };
  const block = compose && c.service ? serviceBlock(compose.text, c.service) : null;
  await askInNewSession(container, crashPrompt(container, detail, tail.map((l) => l.text), block));
}

export async function openCompose(c: DockerContainer): Promise<void> {
  const f = await composeOf(c);
  if (!f) { useApp.getState().showToast(t.docker.composeOutside); return; }
  useApp.getState().openFile(f.path, f.rel, serviceLine(f.text, c.service!), undefined, { preview: true });
}

/** The Redis view on this container's instance (picked when Atelier found it). */
function openInRedis(containerId: string): void {
  const i = useRedis.getState().snap?.instances.find((x) => x.container?.id === containerId);
  if (i) void window.atelier.redis.pick(i.key);
  useApp.getState().openRedis('keys');
}

/** The command that would restart it, for the terminal: Atelier never runs it. */
export function startCommand(c: DockerContainer): string {
  return c.service ? `docker compose up -d ${c.service}` : `docker start ${c.containerName}`;
}

export function logsCommand(c: DockerContainer): string {
  return c.service ? `docker compose logs -f ${c.service}` : `docker logs -f ${c.containerName}`;
}

const copy = (text: string, what: string) => () => void copyText(text).then((ok) => { if (ok) useApp.getState().showToast(t.docker.copied(what), undefined, 'info'); });

/** A container's context menu (sidebar rows, the tab header). */
export function containerMenu(c: DockerContainer): MenuItem[] {
  const ports = c.ports.filter((p) => p.proto === 'tcp');
  return [
    { id: 'logs', label: t.docker.menu.logs, icon: 'terminal', run: () => openContainer(c.id, 'logs') },
    { id: 'inspect', label: t.docker.menu.inspect, icon: 'info', run: () => openContainer(c.id, 'inspect') },
    ...(hasProblem(c) ? [{ id: 'ask', label: t.docker.menu.askCrash, icon: 'sparkle' as const, run: () => void askWhyCrashed(c) }] : []),
    ...(ports.length ? ['sep' as const, ...ports.map((p) => ({ id: `port-${p.host}`, label: t.docker.menu.openPort(p.host), icon: 'externalLink' as const, run: () => void window.atelier.openUrl(portUrl(p.host)) }))] : []),
    'sep',
    { id: 'copy-name', label: t.docker.menu.copyName, icon: 'copy', run: copy(c.containerName, c.containerName) },
    { id: 'copy-id', label: t.docker.menu.copyId, icon: 'copy', run: copy(c.id.slice(0, 12), c.id.slice(0, 12)) },
    { id: 'copy-logs', label: t.docker.menu.copyLogsCmd, icon: 'terminal', hint: logsCommand(c), run: copy(logsCommand(c), logsCommand(c)) },
    ...(c.service ? [{ id: 'compose', label: t.docker.menu.revealCompose, icon: 'files' as const, run: () => void openCompose(c) }] : []),
    // A Redis-like container: its keys and queues in the Redis view.
    ...(isRedisImage(c.image) && c.state === 'running' ? ['sep' as const, { id: 'open-redis', label: t.redis.menu.openInRedis, icon: 'redis' as const, run: () => openInRedis(c.id) }] : [])
  ];
}
