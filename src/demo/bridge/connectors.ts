// connectors.* and tasks.* in the demo: ClickUp is connected as
// the visitor, with the world's sprint (world/clickup.ts), so the palette lists their tasks and the automation editor
// can play its suggestions; Notion and Jira are there, disconnected. Connecting, disconnecting and refreshing need the
// Mac (an OAuth sign-in and the Keychain).
import type { AtelierApi } from '@shared/api';
import { DEFAULT_CONNECTOR_OPTIONS, type ConnectorId, type ConnectorInfo, type TaskGetResult } from '@shared/tasks';
import { CLICKUP_PEOPLE, CLICKUP_WORKSPACE, SPRINT_TASKS, myTasks } from '../world/clickup';
import { notInDemo } from './not-in-demo';
import { resolved, type DemoContext } from './context';

const CLICKUP: ConnectorInfo = {
  id: 'clickup', name: 'ClickUp', status: 'connected', account: CLICKUP_PEOPLE[0].name, workspace: CLICKUP_WORKSPACE,
  loading: false, tasksVersion: 1, options: { ...DEFAULT_CONNECTOR_OPTIONS }
};
const NOTION: ConnectorInfo = { id: 'notion', name: 'Notion', status: 'disconnected', loading: false, tasksVersion: 0, options: { ...DEFAULT_CONNECTOR_OPTIONS } };
const JIRA: ConnectorInfo = { id: 'jira', name: 'Jira', status: 'disconnected', loading: false, tasksVersion: 0, options: { ...DEFAULT_CONNECTOR_OPTIONS } };
const cardOf = (id: ConnectorId) => (id === 'notion' ? NOTION : id === 'jira' ? JIRA : CLICKUP);

export function createConnectors(): AtelierApi['connectors'] {
  const card = (id: ConnectorId) => resolved(cardOf(id));
  const onMac = (id: ConnectorId) => { notInDemo(cardOf(id).name); return card(id); };
  return {
    list: () => resolved({ connectors: [CLICKUP, NOTION, JIRA], notices: [] }),
    connect: onMac,
    cancel: card,
    reopenAuth: card,
    disconnect: onMac,
    refresh: card,
    setOptions: card,
    openTask: () => resolved(false),
    // No sources in the demo: inert answers.
    searchSources: () => resolved([]),
    addSource: () => resolved({ ok: false, reason: 'unsupported' }),
    removeSource: card,
    setSourceFields: card,
    loadSourceColumns: card,
    setSourceScope: card,
    listFilters: () => resolved([]),
    setFilter: card,
    connectToken: onMac
  };
}

export function createTasks(ctx: Pick<DemoContext, 'now'>): AtelierApi['tasks'] {
  const mine = () => myTasks(ctx.now());
  return {
    list: () => resolved([{ source: 'clickup', status: 'connected', loading: false, updatedAt: ctx.now() - 60_000, tasks: mine() }]),
    get: (source, id): Promise<TaskGetResult> => {
      const t = source === 'clickup' ? mine().find((x) => x.id === id) : undefined;
      const body = SPRINT_TASKS.find((x) => x.id === id)?.body ?? '';
      return resolved(source !== 'clickup' ? { ok: false, reason: 'not-connected' } : t ? { ok: true, task: { ...t, body } } : { ok: false, reason: 'gone' });
    },
    search: (source, query) => {
      const q = query.trim().toLowerCase();
      return resolved(source === 'clickup' && q ? mine().filter((t) => `${t.displayId} ${t.title}`.toLowerCase().includes(q)) : []);
    }
  };
}
