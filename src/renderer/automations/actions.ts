// The renderer's automation actions: each asks main and takes the state it answers with (also
// broadcast to every window). A refusal is a toast, never a silent no.
import type { AutomationsState } from '@shared/api';
import type { Automation } from '@shared/automations';
import type { ConnectorId } from '@shared/tasks';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { newDraft } from './view';

const api = () => window.atelier.automations;

async function run(p: Promise<AutomationsState>): Promise<boolean> {
  try {
    useApp.getState().setAutomations(await p);
    return true;
  } catch (e) {
    useApp.getState().showToast(`Automations: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}`);
    return false;
  }
}

export function loadAutomations(): void {
  void run(api().list());
}

/** New Automation: the editor with a draft for this window's project, on the first connected source. */
export function newAutomation(): void {
  const st = useApp.getState();
  if (!st.project) return;
  const connector: ConnectorId = st.connectors.find((c) => c.status === 'connected')?.id ?? 'clickup';
  st.editAutomation(newDraft(st.project.root, connector, () => crypto.randomUUID(), Date.now()), null);
}

export function editAutomation(a: Automation): void {
  useApp.getState().editAutomation(structuredClone(a), a);
}

/** Saves an automation; a new one opens in its tab, as a new file does. */
export async function saveAutomation(a: Automation): Promise<boolean> {
  const isNew = !useApp.getState().automations.automations.some((v) => v.automation.id === a.id);
  const ok = await run(api().save(a));
  if (ok && isNew) useApp.getState().openAutomations(a.id);
  return ok;
}

/** From Off: the Turn On sheet first. */
export function askTurnOn(a: Automation, reconfirm = false): void {
  useApp.getState().askTurnOn(a, reconfirm);
}

export async function turnOn(id: string, startMatching: boolean): Promise<boolean> {
  return run(api().turnOn(id, startMatching));
}

export const turnOff = (id: string) => void run(api().turnOff(id));
export const removeAutomation = (id: string) => void run(api().remove(id));
export const checkNow = (id: string) => void run(api().checkNow(id));
export const startRun = (runId: string) => void run(api().startRun(runId));
export const skipRun = (runId: string) => void run(api().skipRun(runId));
export const stopRun = (runId: string) => void run(api().stopRun(runId));
/** Close Run: the answer says whether the worktree went; a kept one says why (a toast either way). */
export async function closeRun(runId: string, removeWorktree: boolean): Promise<void> {
  const st = useApp.getState();
  try {
    const r = await api().closeRun(runId, removeWorktree);
    st.setAutomations(r.state);
    const removed = r.state.automations.some((v) => v.runs.some((x) => x.id === runId && x.worktreeRemoved));
    st.showToast(r.outcome === 'ok' ? (removed ? t.auto.close.doneRemoved : t.auto.close.done) : t.auto.close.kept(r.message ?? r.outcome));
  } catch (e) {
    st.showToast(`Automations: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}`);
  }
}

export const catchUp = (id: string, action: 'start' | 'skip') => void run(api().catchUp(id, action));
export const setPaused = (paused: boolean) => void run(api().setPaused(paused));

/** A run's session: its tab in this window when it is this project's. */
export function openRunSession(terminalId: string): void {
  const st = useApp.getState();
  if (!st.terminals.some((x) => x.id === terminalId)) { st.showToast('That session is in another project: open its project to see it.'); return; }
  st.setActivity('sessions', { keepHidden: true });
  st.select(terminalId);
}
