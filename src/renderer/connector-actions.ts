// What the Connectors list and details, the palette and the toasts do. Main
// does the work and broadcasts the new status to every window (ev:connectors); the replies are not used, so a window
// never shows a status older than the broadcast it already has.
import type { ConnectorId } from '@shared/tasks';
import { useApp } from './store';
import type { ConnectorActionId, ConnectorCommand } from './connectors-view';
import { opensTokenForm } from './jira-view';

const ignore = () => {};

export function runConnectorAction(id: ConnectorId, action: ConnectorActionId): void {
  const api = window.atelier.connectors;
  // A connection made with an API token signs in again with a new token: its details' form, never the browser.
  const st = useApp.getState();
  const c = st.connectors.find((x) => x.id === id);
  if (action === 'reconnect' && c && opensTokenForm(c)) {
    if (st.connectorDetail !== id) { st.setSettingsOpen('connectors'); st.openConnector(id); }
    useApp.getState().setConnectorTokenForm(id);
    return;
  }
  switch (action) {
    case 'connect': case 'reconnect': void api.connect(id).catch(ignore); break;
    case 'cancel': void api.cancel(id).catch(ignore); break;
    case 'reopen': void api.reopenAuth(id).catch(ignore); break;
    case 'refresh': case 'retry': void api.refresh(id).catch(ignore); break;
    // Asks once, on the connector's details page.
    case 'disconnect': useApp.getState().setConnectorConfirm(id); break;
  }
}

/** The confirm's Disconnect: forgets the connection (main deletes the saved blob, the cache and the timers). */
export function confirmDisconnect(id: ConnectorId): void {
  useApp.getState().setConnectorConfirm(null);
  void window.atelier.connectors.disconnect(id).catch(ignore);
}

/**
 * A palette command. Connect / Reconnect / Disconnect go on in the connector's details page (the countdown and Cancel
 * while the browser is open, the confirm before disconnecting); Refresh Tasks works in the background — unless the
 * connector is unavailable, where a Retry may turn into a sign-in: then on its details too.
 */
export function runConnectorCommand(c: ConnectorCommand): void {
  const st = useApp.getState();
  const unavailable = st.connectors.find((x) => x.id === c.id)?.status === 'unavailable';
  if (c.action === 'refresh' && !unavailable) { runConnectorAction(c.id, 'refresh'); return; }
  st.setSettingsOpen('connectors');
  st.openConnector(c.id);
  runConnectorAction(c.id, c.action);
}
