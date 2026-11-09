// Settings › Connectors' part of the sheet itself: which details page is open, and the header's
// "‹ Connectors". The section's own content (Connectors.tsx: the list, the details, Jira's and Notion's options) loads
// with the section, never the first paint.
import type { ConnectorInfo } from '@shared/tasks';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';
import { kbd } from '../kbd';

/** The connector whose details page is open, if main still lists it (else the list shows). */
export function useConnectorDetail(): ConnectorInfo | null {
  return useApp((s) => (s.connectorDetail ? s.connectors.find((c) => c.id === s.connectorDetail) ?? null : null));
}

const back = () => useApp.getState().openConnector(null);

/** "‹ Connectors", in the sheet's header while a details page is open. Esc on it (or ⌘[ anywhere) goes back. */
export function ConnectorsBack() {
  return (
    <button type="button" className="conn-back" aria-label={t.conn.backLabel} data-tip={t.conn.backLabel} data-kbd={kbd('⌘[')} data-own-esc=""
      onClick={back} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); } }}>
      <Icon name="chevronLeft" size={14} stroke={2} />{t.conn.back}
    </button>
  );
}
